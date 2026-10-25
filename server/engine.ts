// Adapted scheduling/heartbeat semantics from @itsaplan/runner src/cli.ts and
// src/tasks.ts, revision 02235dd57a6cecffa62e0d6c054cb7b7df72e153.
// Copyright 2026 Andrii Poluosmak. Apache-2.0; see LICENSE and THIRD_PARTY.md.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { realpath } from "node:fs/promises";
import { ConfigurationError, StorageError } from "./errors";
import type { Config, Milestone, Selection } from "../shared/config";
import type { AgUiEvent, Issue, Result, SessionRecord, Task } from "../shared/models";
import type { Gateway, Journal, Protocol, Secrets } from "./contracts";
import { AgentIdentityError, RequestError, isAuthError, isTransientError } from "./protocol";
import { resolveProject } from "./projects";
import type { IntegrationRuntime } from "../shared/experience";
import type { SessionSnapshot } from "./contracts";
import { executionPreferences, makePlan } from "./plan";
import { assessAcceptance, nativeSystemPrompt, taskPrompt } from "./task";
import { assertContinuationGrant, assertSourceNative, captureProvenance, contextRequirementsDigest, executionConfigDigest, factDigest, intentDigest, taskRequirements } from "./continuation";
import type { ContinuationGrant } from "../shared/continuation";
import type { TaskContextSnapshot } from "../shared/task-context";

function compatibleSession(session: SessionSnapshot, selection: Selection, previous?: Selection): boolean {
  const unchangedProvider = previous?.provider === selection.provider;
  const model = selection.model ? session.model === selection.model : unchangedProvider && previous?.model === "" && session.model !== null;
  const mode = selection.modeId ? session.modeId === selection.modeId : unchangedProvider && previous?.modeId === "";
  return !session.archived && session.provider === selection.provider && model && mode;
}

const terminal: Partial<Record<SessionRecord["phase"], true>> = { finished: true, canceled: true, "lease-lost": true, uncertain: true };
export function taskKey(serverUrl: string, task: Task): string {
  const server = createHash("sha256").update(serverUrl.replace(/\/+$/, "")).digest("hex").slice(0, 16);
  return task.kind === "run" ? `${server}:run:${task.run.id}:${task.run.attempts}` : `${server}:chat:${task.message.id}:${task.message.attempts ?? 1}`;
}
function agentIdFor(key: string): string {
  const hash = createHash("sha256").update(`paseo-itsaplan:${key}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function issueBranchName(key: string, identifier?: string | null): string {
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return identifier && /^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(identifier) ? `${identifier}-itsaplan-${suffix}` : `itsaplan-${suffix}`;
}

function visibleActivity(event: AgUiEvent, privacy: Config["activityPrivacy"]): AgUiEvent | undefined {
  if (!privacy || privacy === "off" || !event.type.startsWith("TOOL_CALL_")) return undefined;
  if (privacy === "full") return event;
  if (event.type === "TOOL_CALL_ARGS") return undefined;
  if (event.type === "TOOL_CALL_RESULT") return { ...event, content: "[Tool result withheld by activity privacy]" };
  return event;
}

function redactActivity(event: AgUiEvent, secrets: Secrets): AgUiEvent {
  const credentials = Object.values(secrets).filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
  const redact = (text: string) => {
    for (const credential of credentials) {
      text = text.replaceAll(credential, "[redacted]");
      const encoded = JSON.stringify(credential).slice(1, -1);
      if (encoded !== credential) text = text.replaceAll(encoded, "[redacted]");
    }
    return text;
  };
  switch (event.type) {
    case "TOOL_CALL_START": return { ...event, toolCallId: redact(event.toolCallId), toolCallName: redact(event.toolCallName).slice(0, 200), ...(event.parentMessageId ? { parentMessageId: redact(event.parentMessageId) } : {}) };
    case "TOOL_CALL_ARGS": return { ...event, toolCallId: redact(event.toolCallId), delta: redact(event.delta) };
    case "TOOL_CALL_END": return { ...event, toolCallId: redact(event.toolCallId) };
    case "TOOL_CALL_RESULT": {
      const content = redact(event.content);
      const suffix = "\n[Tool result truncated to the 12,000-character event limit]";
      return { ...event, toolCallId: redact(event.toolCallId), messageId: redact(event.messageId), content: content.length > 12000 ? content.slice(0, 12000 - suffix.length) + suffix : content };
    }
    default: return event;
  }
}
export function safeError(error: unknown): string {
  if (error instanceof AgentIdentityError) return error.message;
  if (error instanceof RequestError) return `It's a Plan request rejected (${error.status})`;
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Execution interrupted";
  // Provider and transport errors may include env/headers or URLs. Only our own
  // actionable configuration/credential errors cross this boundary verbatim.
  return "Integration operation failed; inspect connection, provider availability, and project mapping";
}
class ExecutionStop extends Error {
  constructor(message: string, readonly phase: "canceled" | "lease-lost" | "reporting" = "reporting") { super(message); }
}
interface Active {
  stop: AbortController;
  done: Promise<void>;
  clear: () => void;
}
export class Engine {
  state = "idle";
  message = "Automatic delegation is disabled";
  private claims = new AbortController();
  private readonly active = new Map<string, Active>();
  private readonly agentLocks = new Set<string>();
  private readonly intentClaims = new Map<string, number>();
  private loops: Promise<void>[] = [];
  private reservations = 0;
  private stopping = false;
  private paused = false;
  private interrupting = false;
  private draining = false;
  private started = false;
  private admissionEpoch = 0;
  private lastPollAt: number | null = null;
  private maintenance: NodeJS.Timeout | undefined;
  private reporting = false;
  private readonly reports = new Map<string, Promise<void>>();
  private readonly deliveries = new Map<string, AbortController>();
  private readonly stopRequests = new Map<string, AbortController>();
  private wake = new Set<() => void>();
  constructor(
    public config: Config,
    private readonly protocol: Protocol,
    private readonly gateway: Gateway,
    private readonly journal: Journal,
    private secrets: Secrets,
    private readonly timing: { heartbeatMs?: number; flushMs?: number; backoffMs?: number } = {},
  ) {}

  async start(paused = false): Promise<void> {
    this.started = true;
    this.paused = paused;
    this.state = "recovering";
    for (const record of this.journal.records()) {
      if (record.serverUrl === this.config.serverUrl && record.task && (!terminal[record.phase] || record.cancellation === "unconfirmed")) this.launch(record.task);
    }
    if (this.journal.records().some((record) => record.cancellation === "unconfirmed" || record.cancellation === "requested")) {
      this.state = "cancellation-error";
      this.message = "Native cancellation is unresolved; confirm the linked session before resuming claims";
      this.claims.abort();
    }
    this.maintenance = setInterval(() => { void this.retryReports().catch((error) => { if (error instanceof StorageError) this.storageFailed(error); }); }, this.timing.backoffMs ?? 5000);
    this.refreshClaims();
  }

  runtime(): IntegrationRuntime {
    return { claiming: this.started && this.config.automatic && !this.paused && !this.draining && !this.stopping && !this.claims.signal.aborted,
      paused: this.paused, active: this.active.size, reservations: this.reservations, pendingConfiguration: this.draining, lastPollAt: this.lastPollAt };
  }

  updateConfiguration(config: Config, secrets = this.secrets): void {
    this.admissionEpoch++;
    this.config = config;
    this.secrets = secrets;
    this.refreshClaims();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused && this.state === "cancellation-error" && !this.journal.records().some((record) => record.cancellation === "unconfirmed" || record.cancellation === "requested")) this.state = "idle";
    this.refreshClaims();
  }

  private refreshClaims(): void {
    if (this.stopping || this.draining || !this.started) return;
    const blocked = ["storage-error", "cancellation-error", "authentication-error", "configuration-error"].includes(this.state);
    if (this.paused || !this.config.automatic) {
      this.claims.abort();
      this.notify();
      if (!blocked) {
        this.state = this.paused ? "paused" : "idle";
        this.message = this.paused ? "Paused; existing executions retain their leases" : "Automatic delegation is disabled; existing executions continue";
      }
      return;
    }
    if (this.loops.length && !this.claims.signal.aborted) { this.notify(); return; }
    if (blocked) return;
    this.claims = new AbortController();
    const signal = this.claims.signal;
    this.state = "connecting";
    this.loops = [this.poll("run", signal), this.poll("chat", signal)];
  }

  async drain(): Promise<void> {
    this.draining = true;
    this.claims.abort();
    this.notify();
    this.state = "draining";
    this.message = "Connection changes are waiting for existing executions and result delivery";
    while (!this.stopping && (this.active.size || this.reservations || this.reports.size ||
      this.journal.records().some((record) => record.serverUrl === this.config.serverUrl && (record.phase === "reporting" || record.cancellation === "unconfirmed" ||
        (record.kind === "manual" && ["preparing", "created", "sending", "running", "stopping"].includes(record.phase)))))) {
      await new Promise<void>((resolve) => this.wake.add(resolve));
    }
    clearInterval(this.maintenance);
  }

  private async reserve(signal: AbortSignal): Promise<boolean> {
    while (!this.stopping && !signal.aborted && this.reservations + this.active.size >= this.config.maxConcurrent) {
      // The owning daemon supports Node 20, before Promise.withResolvers.
      await new Promise<void>((resolve) => this.wake.add(resolve));
    }
    if (this.stopping || signal.aborted) return false;
    this.reservations++;
    return true;
  }
  private notify(): void { for (const resolve of this.wake) resolve(); this.wake.clear(); }
  private storageFailed(error: StorageError): void {
    this.state = "storage-error";
    this.message = "Execution journal could not be committed; claiming stopped";
    this.claims.abort();
    for (const active of this.active.values()) active.stop.abort(error);
    this.notify();
  }
  private async poll(kind: "run" | "chat", signal: AbortSignal): Promise<void> {
    while (!signal.aborted && await this.reserve(signal)) {
      const config = structuredClone(this.config);
      const secrets = { ...this.secrets };
      const admissionEpoch = this.admissionEpoch;
      let empty = false;
      let delay = config.pollIntervalMs;
      try {
        if (signal.aborted) break;
        // Chat writes have no attempt fence. Do not reclaim a message while a
        // durable answer for it is still being delivered.
        const pendingChat = kind === "chat" && this.journal.records().some((record) => record.serverUrl === this.config.serverUrl && record.kind === "chat" && record.phase === "reporting");
        this.lastPollAt = Date.now();
        const item = pendingChat ? null : kind === "run" ? await this.protocol.claim(signal) : await this.protocol.claimChat(signal);
        if (item) {
          const task: Task = kind === "run" ? { kind, run: item as Extract<Task, { kind: "run" }>["run"] } : { kind, message: item as Extract<Task, { kind: "chat" }>["message"] };
          // A claim can settle just as shutdown begins. Persist/report it; never discard.
          this.launch(task, config, secrets, admissionEpoch);
        } else { empty = true; }
        if (!signal.aborted) {
          this.state = "connected";
          this.message = "Connected to external-agent feeds";
        }
      } catch (error) {
        if (signal.aborted) break;
        if (kind === "chat" && error instanceof RequestError && error.status === 404) return;
        if (error instanceof RequestError && error.status === 409) {
          this.state = "configuration-error";
          this.message = "This external agent uses an invocation URL; switch it to polling in It's a Plan";
          this.claims.abort();
          this.notify();
          return;
        }
        if (isAuthError(error)) {
          this.state = "authentication-error";
          this.message = "External-agent key rejected; update credentials to reconnect";
          this.claims.abort();
          for (const active of this.active.values()) active.stop.abort(new ExecutionStop("External-agent authentication rejected", "lease-lost"));
          this.notify();
          return;
        }
        this.state = "offline";
        this.message = safeError(error);
        delay = this.timing.backoffMs ?? 5000;
        empty = true;
      } finally { this.reservations--; this.notify(); }
      if (empty) await sleep(delay, undefined, { signal }).catch(() => {});
    }
  }

  private launch(task: Task, config = structuredClone(this.config), secrets = { ...this.secrets }, admissionEpoch = this.admissionEpoch): Promise<void> {
    const key = taskKey(config.serverUrl, task);
    const running = this.active.get(key);
    if (running) return running.done;
    const existing = this.journal.get(key);
    if (existing && terminal[existing.phase] && existing.cancellation !== "unconfirmed") return Promise.resolve();
    const stop = new AbortController();
    const halted = ["storage-error", "cancellation-error", "authentication-error", "configuration-error"].includes(this.state) ||
      (this.claims.signal.aborted && !this.paused && !this.draining && this.config.automatic);
    if (this.stopping || this.interrupting || halted) stop.abort(new ExecutionStop(this.stopping ? "Plugin stopped; session preserved" : "Execution stopped before prompt acceptance; session preserved"));
    const active: Active = { stop, clear: () => {}, done: Promise.resolve() };
    this.active.set(key, active);
    active.done = this.execute(task, key, active, config, secrets, admissionEpoch).catch(() => {
      this.storageFailed(new StorageError("Execution journal unavailable"));
    }).finally(() => { active.clear(); this.active.delete(key); this.notify(); });
    return active.done;
  }

  /** Accept only server-claimed tasks. This method is also the deterministic integration test seam. */
  dispatch(task: Task): Promise<void> { return this.launch(task); }

  private async execute(task: Task, key: string, active: Active, config: Config, secrets: Secrets, admissionEpoch: number): Promise<void> {
    const { stop } = active;
    let record = this.journal.get(key);
    const resumed = Boolean(record);
    let heartbeat: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let safety: NodeJS.Timeout | undefined;
    let flushing: NodeJS.Timeout | undefined;
    let ownsAgentLock = false;
    let sessionOwned = Boolean(!record?.continuation && record?.cwd && ["sending", "running", "stopping", "uncertain"].includes(record.phase));
    let beatInFlight = false;
    let leaseLost = false;
    let remotelyCanceled = false;
    let cancelPromise: Promise<void> | undefined;
    let cancellationUnconfirmed = false;
    let intentClaim: string | undefined;
    let releaseObservation: (() => Promise<void>) | undefined;
    let continuation: ContinuationGrant | undefined = record?.continuation;
    const activityIds = new Set(record?.activityEventIds ?? []);
    let streamedTextLength = record?.streamedTextLength ?? 0;
    let events: AgUiEvent[] = record?.pendingEvents ?? [];
    let sending = Promise.resolve();
    const threadId = task.kind === "chat" ? task.message.threadId : `run-${task.run.id}`;
    const externalId = task.kind === "chat" ? task.message.id : task.run.id;
    const messageId = `paseo-${key}`;
    const persist = async (patch: Partial<SessionRecord>) => {
      if (!record) throw new Error("Execution journal record missing");
      record = { ...record, ...patch, activityEventIds: [...activityIds], streamedTextLength, updatedAt: Date.now() };
      await this.journal.put(record);
    };
    const clear = () => { clearInterval(heartbeat); clearInterval(flushing); clearTimeout(deadline); clearTimeout(safety); };
    active.clear = clear;
    const cancel = () => {
      this.notify();
      if (!sessionOwned || !record?.agentId || cancelPromise) return;
      const agentId = record.agentId;
      cancelPromise = (async () => {
        let storageError: StorageError | undefined;
        try { await persist({ phase: record?.phase === "created" ? "created" : "stopping", cancellation: "requested" }); }
        catch (error) { if (error instanceof StorageError) storageError = error; else throw error; }
        try {
          await this.gateway.cancel(agentId);
          const session = await this.gateway.inspect(agentId);
          if (!session || session.active || session.pendingPermissionCount > 0) throw new Error("Cancellation unconfirmed");
          cancellationUnconfirmed = false;
          await persist({ cancellation: "confirmed", pendingPermissionCount: 0 });
        } catch (error) {
          if (error instanceof StorageError) throw error;
          cancellationUnconfirmed = true;
          await persist({ phase: "uncertain", cancellation: "unconfirmed", error: "Native cancellation is unconfirmed; inspect the linked Paseo session" });
          this.state = "cancellation-error";
          this.message = "Could not confirm turn cancellation; no further work will be claimed";
          this.claims.abort();
          this.notify();
        }
        if (storageError) throw storageError;
      })();
      void cancelPromise.catch(() => {});
    };
    stop.signal.addEventListener("abort", cancel, { once: true });
    const resetSafety = () => {
      clearTimeout(safety);
      safety = setTimeout(() => stop.abort(new ExecutionStop("Heartbeat safety deadline exceeded", "lease-lost")), record?.limits?.leaseSafetyMs ?? config.leaseSafetyMs);
    };
    const beat = async () => {
      if (beatInFlight || stop.signal.aborted) return;
      beatInFlight = true;
      try {
        if (task.kind === "run") await this.protocol.heartbeat(task.run.id, task.run.attempts, stop.signal);
        else if (await this.protocol.chatHeartbeat(task.message.id, stop.signal)) {
          remotelyCanceled = true;
          stop.abort(new ExecutionStop("Chat canceled in It's a Plan", "canceled"));
        }
        if (!stop.signal.aborted) {
          resetSafety();
          await persist({ lastHeartbeatAt: Date.now() });
        }
      } catch (error) {
        if (error instanceof StorageError) { this.storageFailed(error); return; }
        if (!stop.signal.aborted && (isAuthError(error) || (error instanceof RequestError && [404, 409].includes(error.status)))) {
          leaseLost = true;
          stop.abort(new ExecutionStop("Execution lease rejected", "lease-lost"));
        }
        // Connectivity failures retain the last acknowledged safety deadline.
      } finally { beatInFlight = false; }
    };
    const flush = (): Promise<void> => {
      sending = sending.catch(() => {}).then(async () => {
        if (!record || events.length === 0 || stop.signal.aborted) return;
        const batch = events.slice(0, 200);
        await persist({ pendingEvents: [...events] });
        try {
          if (task.kind === "run") {
            if (task.run.traceEvents) await this.protocol.runEvents(task.run, record.eventOffset, batch, undefined, stop.signal);
          } else if (await this.protocol.chatEvents(task.message.id, batch, record.agentId || undefined, stop.signal)) {
            remotelyCanceled = true;
            stop.abort(new ExecutionStop("Chat canceled in It's a Plan", "canceled"));
          }
          events.splice(0, batch.length);
          await persist({ eventOffset: record.eventOffset + batch.length, pendingEvents: [...events] });
        } catch (error) {
          if (error instanceof RequestError && [401, 403, 404, 409].includes(error.status)) {
            leaseLost = true;
            stop.abort(new ExecutionStop("Execution event lease rejected", "lease-lost"));
          } else if (!isTransientError(error)) throw error;
        }
      });
      return sending;
    };
    try {
      if (!record) {
        record = { key, kind: task.kind, serverUrl: config.serverUrl, externalId, attempt: task.kind === "run" ? task.run.attempts : task.message.attempts ?? 1,
          issueId: task.kind === "run" ? task.run.issueId : null, issueIdentifier: task.kind === "run" ? task.run.issueIdentifier : null,
          projectId: "", agentId: agentIdFor(key), workspaceId: null, cwd: "", provider: "", phase: "preparing", createdAt: Date.now(), updatedAt: Date.now(), eventOffset: 0, task,
          limits: { executionTimeoutMs: config.executionTimeoutMs, leaseSafetyMs: config.leaseSafetyMs } };
        let retired: SessionRecord | undefined;
        const prior = this.journal.records().filter((item) => item.serverUrl === record!.serverUrl && item.kind === record!.kind && item.externalId === externalId && ["reporting", "uncertain"].includes(item.phase) && item.result).sort((a, b) => b.attempt - a.attempt)[0];
        if (prior?.result) {
          const earlier = this.active.get(prior.key);
          this.deliveries.get(prior.key)?.abort();
          earlier?.stop.abort(new ExecutionStop("Superseded execution attempt", "lease-lost"));
          if (earlier) await earlier.done;
          await this.reports.get(prior.key)?.catch(() => {});
          retired = { ...prior, phase: "lease-lost", error: "Outcome transferred to a newer claimed attempt", updatedAt: Date.now() };
          record = { ...record, agentId: prior.agentId, workspaceId: prior.workspaceId, cwd: prior.cwd, provider: prior.provider, model: prior.model, modeId: prior.modeId,
            projectId: prior.projectId, projectMapping: prior.projectMapping, plan: prior.plan, intent: prior.intent, evidence: prior.evidence, acceptance: prior.acceptance, phase: "reporting", result: prior.result };
          if (task.kind === "chat") {
            const answerId = `paseo-${key}`;
            const restored: AgUiEvent[] = [{ type: "RUN_STARTED", threadId, runId: String(externalId) }, { type: "TEXT_MESSAGE_START", messageId: answerId, role: "assistant" }];
            const output = prior.result.output ?? "";
            for (let start = 0; start < Math.min(output.length, 1000000); start += 12000) restored.push({ type: "TEXT_MESSAGE_CONTENT", messageId: answerId, delta: output.slice(start, start + 12000) });
            restored.push({ type: "TEXT_MESSAGE_END", messageId: answerId }, prior.result.status === "success" ? { type: "RUN_FINISHED", threadId, runId: String(externalId) } : { type: "RUN_ERROR", message: prior.result.error ?? "Agent execution failed" });
            record.pendingEvents = restored;
          }
        }
        if (retired) await this.journal.putMany([retired, record]);
        else await this.journal.put(record);
      }
      if (record.cancellation === "unconfirmed" || record.phase === "stopping") {
        stop.abort(new ExecutionStop("Recovering interrupted cancellation; prompt not replayed"));
        throw stop.signal.reason;
      }
      if (record.phase === "reporting" && record.result) { await this.report(record); return; }
      resetSafety();
      await beat();
      heartbeat = setInterval(() => { void beat(); }, this.timing.heartbeatMs ?? 60000);
      deadline = setTimeout(() => stop.abort(new ExecutionStop("Execution timeout exceeded; session preserved")), Math.max(1, (record.limits?.executionTimeoutMs ?? config.executionTimeoutMs) - (Date.now() - record.createdAt)));
      stop.signal.throwIfAborted();


      const issue = task.kind === "run" && task.run.issueId ? await this.protocol.issue(task.run.issueId, stop.signal) : undefined;
      let binding = task.kind === "chat" ? this.journal.thread(task.message.threadId) : undefined;
      if (task.kind === "chat" && !binding && record.projectId && record.phase !== "preparing") {
        binding = { agentId: record.agentId, projectId: record.projectId };
        await this.journal.bindThread(task.message.threadId, binding);
      }
      const intent = task.kind === "run" ? record.intent ?? await this.protocol.intent(task.run, issue, stop.signal, (id) => this.journal.request(id)) : undefined;
      if (intent?.requestId) {
        const request = this.journal.request(intent.requestId);
        if (request?.source?.kind === "issue" || request?.operation === "continue" || intent.source === "smoke" && intent.sourceRunId === externalId) {
          if (task.kind !== "run") throw new ExecutionStop("Issue-origin smoke requires an authoritative claimed run");
          const verified = await this.protocol.intent(task.run, issue, stop.signal, (id) => this.journal.request(id));
          if (verified.version !== intent.version || verified.source !== intent.source || verified.request !== intent.request || verified.projectId !== intent.projectId || verified.sourceRunId !== intent.sourceRunId || verified.requestId !== intent.requestId || verified.acceptance?.expectedOutput !== intent.acceptance?.expectedOutput || verified.acceptance?.noTools !== intent.acceptance?.noTools) throw new ExecutionStop("The persisted smoke intent no longer matches its durable request");
        }
        if (request?.operation === "continue") {
          if (!config.continuation?.enabled || !request.continuation || request.continuation.requestId !== intent.requestId) throw new ExecutionStop("This continuation has no approved durable scope grant");
          if (this.journal.records().some((prior) => prior.serverUrl === config.serverUrl && prior.externalId === externalId && prior.intent?.requestId === intent.requestId && prior.attempt < record!.attempt)) throw new ExecutionStop("A continuation retry requires a new reviewed request; an earlier attempt cannot transfer its approval");
          continuation = request.continuation;
        }
        const claim = `${config.serverUrl}:${intent.requestId}`;
        const owner = this.intentClaims.get(claim);
        if ((owner !== undefined && owner !== externalId) || this.journal.records().some((prior) =>
          prior.serverUrl === config.serverUrl && prior.intent?.requestId === intent.requestId && prior.externalId !== externalId)) {
          throw new ExecutionStop("This execution request was already accepted by another upstream run; create a new request to run it again");
        }
        this.intentClaims.set(claim, externalId);
        intentClaim = claim;
        await persist({ intent });
      }
      const projectId = issue ? String(issue.projectId) : intent?.projectId ?? binding?.projectId ?? (task.kind === "chat" ? config.chatProjects[task.message.threadId] : undefined);
      if (intent && intent.projectId !== projectId) throw new ExecutionStop("Task intent belongs to a different project");
      if (!projectId || (!record.projectMapping && !config.projects[projectId])) throw new ExecutionStop("Enable this project in plugin settings and select a project for chat threads before automatic execution");
      if (!record.projectMapping && !config.projects[projectId]!.automatic) throw new ExecutionStop("Automatic execution is disabled for this project");
      if (record.projectId && record.projectId !== projectId) throw new ExecutionStop("The issue's project changed; refusing to reroute an existing execution");
      let boundRecord: SessionRecord | undefined;
      if (binding) for (const item of this.journal.records()) {
        if (item.serverUrl === record.serverUrl && item.projectId === projectId && item.agentId === binding.agentId && item.projectMapping && (!boundRecord || item.createdAt >= boundRecord.createdAt)) boundRecord = item;
      }
      const boundMapping = boundRecord?.projectMapping;
      const project = record.projectMapping ?? (boundMapping ? { ...config.projects[projectId]!, repository: boundMapping.repository, workspaceId: boundMapping.workspaceId } : await resolveProject(config, this.protocol, this.gateway, projectId, stop.signal));
      const preferences = await executionPreferences(this.protocol, config, project, issue, {}, stop.signal);
      const selection = record.plan?.selection ?? await this.gateway.select(config, project, preferences.selection);
      if (!record.plan) await persist({ projectId, projectMapping: project, intent,
        plan: makePlan(config, project, selection, { projectId, issueId: issue?.id ?? null, issueIdentifier: issue?.identifier ?? null, host: await this.gateway.host(), sources: preferences.sources }) });
      stop.signal.throwIfAborted();
      const verifyContinuation = async () => {
        if (!continuation || !intent?.requestId || task.kind !== "run" || !issue) throw new ExecutionStop("Continuation source scope is unavailable");
        const request = this.journal.request(intent.requestId);
        const source = this.journal.get(continuation.sourceKey);
        if (!source || !request || request.operation !== "continue" || !request.continuation || factDigest(request.continuation) !== factDigest(continuation) || request.sourceKey !== source.key || request.issueId !== issue.id || request.projectId !== projectId || request.executionActorId !== continuation.executionActorId || request.runId !== null && request.runId !== task.run.id || !["unknown", "submitted", "submitting"].includes(request.state)) throw new ExecutionStop("The durable continuation request changed or belongs to another execution");
        assertContinuationGrant(source, continuation, intent.requestId);
        const actor = await this.protocol.identity(stop.signal);
        stop.signal.throwIfAborted();
        const currentIssue = await this.protocol.issue(issue.id, stop.signal);
        if (!this.config.projects[projectId]) throw new ExecutionStop("The continuation project is no longer configured");
        const currentProject = await resolveProject(this.config, this.protocol, this.gateway, projectId, stop.signal);
        if (currentProject.repository !== source.projectMapping!.repository || currentProject.workspaceId !== source.projectMapping!.workspaceId) throw new ExecutionStop("The continuation repository mapping changed");
        const currentPreferences = await executionPreferences(this.protocol, this.config, currentProject, currentIssue, {}, stop.signal);
        const currentSelection = await this.gateway.select(this.config, currentProject, currentPreferences.selection);
        if (source.taskContext) {
          const currentContext = await this.protocol.context(currentIssue, currentProject, stop.signal);
          if (contextRequirementsDigest(currentContext) !== contextRequirementsDigest(source.taskContext)) throw new ExecutionStop("The continuation's optional requirements or attachments changed or could not be verified");
        }
        try { await this.protocol.heartbeat(task.run.id, task.run.attempts, stop.signal); }
        catch (error) {
          if (isAuthError(error) || error instanceof RequestError && [404, 409].includes(error.status)) throw new ExecutionStop("Continuation execution lease rejected", "lease-lost");
          throw error;
        }
        const latestActor = await this.protocol.identity(stop.signal);
        const latestIssue = await this.protocol.issue(issue.id, stop.signal);
        const currentIntent = await this.protocol.intent(task.run, latestIssue, stop.signal, (id) => this.journal.request(id));
        const sourceRun = await this.protocol.getRun(source.externalId, stop.signal);
        const native = await this.gateway.inspect(source.agentId, { includeHistory: false });
        stop.signal.throwIfAborted();
        const latestSource = this.journal.get(source.key);
        const latestRequest = this.journal.request(intent.requestId);
        if (!latestSource || !latestRequest || latestRequest.operation !== "continue" || factDigest(latestRequest.continuation) !== factDigest(continuation) || latestRequest.executionActorId !== continuation.executionActorId || latestRequest.body !== request.body || !["unknown", "submitted", "submitting"].includes(latestRequest.state) || latestRequest.runId !== null && latestRequest.runId !== task.run.id) throw new ExecutionStop("The continuation source or durable grant changed during admission");
        assertContinuationGrant(latestSource, continuation, intent.requestId);
        if (!sourceRun || sourceRun.executionState !== "success" || sourceRun.status !== "success" || sourceRun.attempts !== source.attempt || sourceRun.issueId !== source.issueId || sourceRun.projectId !== source.projectId || sourceRun.username !== latestActor.username) throw new ExecutionStop("The authoritative continuation source is no longer successful or belongs to another scope");
        if (!this.config.continuation?.enabled || !actor.isAgent || !latestActor.isAgent || actor.id !== continuation.executionActorId || latestActor.id !== actor.id || executionConfigDigest(this.config, projectId, issue.id) !== continuation.configDigest || factDigest(taskRequirements(latestIssue, source.taskContext)) !== continuation.requirementsDigest || intentDigest(currentIntent) !== continuation.taskDigest || factDigest(task.run.systemPrompt) !== continuation.systemDigest || factDigest(currentSelection) !== factDigest(source.plan!.selection) || factDigest(selection) !== factDigest(currentSelection)) throw new ExecutionStop("Continuation actor, task, requirements, configuration, or execution selection changed");
        assertSourceNative(source, native);
        return { source, native };
      };
      if (continuation && record.phase === "preparing") {
        const { source, native } = await verifyContinuation();
        await persist({ continuation, agentId: native.id, workspaceId: native.workspaceId, cwd: native.cwd, provider: native.provider, model: native.model, modeId: native.modeId, taskContext: source.taskContext, taskIssue: source.taskIssue, taskProvenance: source.taskProvenance, branchName: source.branchName, phase: "created" });
      }
      if (task.kind === "run" && issue && intent && intent.source !== "smoke" && record.phase === "preparing") {
        let context = record.taskContext;
        if (project.taskContext?.enabled && !context) {
          const collected = await this.protocol.context(issue, project, stop.signal);
          context = await this.journal.cacheTaskContext(collected);
          await persist({ taskContext: context });
        }
        const actor = await this.protocol.identity(stop.signal);
        stop.signal.throwIfAborted();
        await persist({ taskIssue: issue, ...(actor.isAgent ? { taskProvenance: captureProvenance(config, actor.id, intent, task.run.systemPrompt, issue, context) } : {}) });
      }
      if (task.kind === "chat" && task.message.sessionId && (!binding || task.message.sessionId !== binding.agentId)) throw new ExecutionStop("Unknown chat session; restore the original thread binding from backup or start a new It's a Plan chat thread");
      if (record.phase === "preparing") {
        // Cancel an older lease before resuming its session/worktree. No two attempts
        // may knowingly mutate a repository through this integration at once.
        if (task.kind === "run") {
          const prior = this.journal.records().filter((item) => item.serverUrl === record!.serverUrl && item.kind === "run" && item.externalId === record!.externalId && item.attempt < record!.attempt).sort((a, b) => b.attempt - a.attempt)[0];
          if (prior?.agentId && !terminal[prior.phase]) {
            const earlier = this.active.get(prior.key);
            earlier?.stop.abort(new ExecutionStop("Superseded by a newer execution attempt", "lease-lost"));
            try {
              await this.gateway.cancel(prior.agentId);
              if (earlier) await earlier.done;
              const stopped = await this.gateway.inspect(prior.agentId);
              if (!stopped || stopped.active || stopped.pendingPermissionCount > 0) throw new Error("Cancellation unconfirmed");
            } catch {
              await this.journal.update(prior.key, (current) => ({ ...current, phase: "uncertain", cancellation: "unconfirmed", error: "Superseded session cancellation is unconfirmed", updatedAt: Date.now() }));
              this.claims.abort();
              throw new ExecutionStop("Previous execution is still unconfirmed; a new coding session will not be started");
            }
          }
        }
        if (binding) {
          const bound = await this.gateway.inspect(binding.agentId);
          if (!bound || bound.archived) throw new ExecutionStop("Mapped Paseo session is missing or archived; refusing to lose conversation state");
          if (compatibleSession(bound, selection, boundRecord?.plan?.selection)) await persist({ agentId: binding.agentId });
          else throw new ExecutionStop("The mapped chat session's model or mode differs from this request, or its defaults cannot be verified. Update the native session to the explicit selection or start a new It's a Plan thread; conversation state was preserved.");
        }
        const known = record.agentId !== agentIdFor(key) ? await this.gateway.inspect(record.agentId) : null;
        if (record.agentId !== agentIdFor(key) && (!known || !compatibleSession(known, selection, binding?.agentId === known.id ? boundRecord?.plan?.selection : undefined))) throw new ExecutionStop("Mapped Paseo session selection changed before reuse");
        if (!known && !record.branchName) await persist({ branchName: issueBranchName(key, resumed ? null : issue?.identifier) });
        const session = known ?? await this.gateway.create({ key, agentId: record.agentId, title: issue?.identifier ?? (task.kind === "run" ? `It's a Plan ${task.run.trigger} run ${externalId}` : `It's a Plan chat ${externalId}`), project, selection,
          systemPrompt: nativeSystemPrompt(task.kind === "run" ? task.run.systemPrompt : task.message.systemPrompt), config, mcpToken: secrets.mcpToken, issueId: issue?.id ?? null, branchName: record.branchName });
        sessionOwned = !known;
        await persist({ projectId, agentId: session.id, workspaceId: session.workspaceId, cwd: session.cwd, provider: session.provider, model: session.model, modeId: session.modeId, pendingPermissionCount: session.pendingPermissionCount, phase: "created", issueId: issue?.id ?? record.issueId, issueIdentifier: issue?.identifier ?? record.issueIdentifier });
        if (task.kind === "chat") await this.journal.bindThread(task.message.threadId, { agentId: record.agentId, projectId });
      }
      while (this.agentLocks.has(record.agentId)) {
        stop.signal.throwIfAborted();
        await new Promise<void>((resolve) => this.wake.add(resolve));
      }
      stop.signal.throwIfAborted();
      this.agentLocks.add(record.agentId);
      ownsAgentLock = true;
      if (record.phase === "created" || continuation) sessionOwned = false;
      const snapshot = await this.gateway.inspect(record.agentId);
      if (!snapshot || snapshot.archived) {
        sessionOwned = false;
        throw new ExecutionStop("Paseo session is missing or archived");
      }
      stop.signal.throwIfAborted();
      if (record.phase === "created" && (snapshot.active || snapshot.pendingPermissionCount > 0 || snapshot.id !== record.agentId || snapshot.cwd !== record.cwd || snapshot.workspaceId !== record.workspaceId || snapshot.provider !== record.provider || snapshot.model !== record.model || snapshot.modeId !== record.modeId)) {
        sessionOwned = false;
        throw new ExecutionStop("Native session is busy or its model/mode changed; refusing to interrupt it");
      }
      if (continuation && resumed && ["sending", "running"].includes(record.phase)) {
        if (!record.nativeLastUserMessageAt || snapshot.lastUserMessageAt !== record.nativeLastUserMessageAt || snapshot.provider !== record.provider || snapshot.model !== record.model || snapshot.modeId !== record.modeId || snapshot.cwd !== record.cwd || snapshot.workspaceId !== record.workspaceId) throw new ExecutionStop("The interrupted continuation's native turn cannot be verified; no prompt was replayed or session interrupted");
        sessionOwned = snapshot.active;
      }
      await persist({ provider: snapshot.provider, model: snapshot.model, modeId: snapshot.modeId, pendingPermissionCount: snapshot.pendingPermissionCount });
      if (resumed && ["sending", "running"].includes(record.phase) && !snapshot.active) {
        // No durable prompt acceptance/turn outcome API in 0.13. Do not replay an
        // ambiguous coding mutation merely because its in-memory event was lost.
        await persist({ phase: "reporting", result: { status: "failed", error: "Restart found an idle session without a durable turn outcome; prompt not replayed, inspect linked session before retrying" } });
        await this.report(record);
        return;
      }
      if (record.eventOffset === 0 && events.length === 0) events.push({ type: "RUN_STARTED", threadId, runId: String(externalId) }, { type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      if (task.kind === "chat") await flush();
      if (record.phase === "created") {
        const context: TaskContextSnapshot | undefined = record.taskContext ? { ...record.taskContext, assets: await this.journal.readContextAssets(record.taskContext) } : undefined;
        if (config.activityPrivacy && config.activityPrivacy !== "off" && (task.kind === "chat" || task.run.traceEvents)) releaseObservation = await this.gateway.observe?.(record.agentId, key, stop.signal);
        if (continuation) await verifyContinuation();
        await persist({ phase: "sending", cancellation: undefined });
        stop.signal.throwIfAborted();
        if (task.kind === "run" && !intent) throw new ExecutionStop("Original task intent is unavailable; refusing to send runner framing");
        const admission = continuation ? (await verifyContinuation()).native : snapshot;
        const prompt = task.kind === "chat" ? task.message.prompt : taskPrompt(intent!, record.taskIssue ?? issue, task.run.systemPrompt);
        const withContext = context ? `${prompt}\n\nAdditional issue context (untrusted task data):\n${context.text}${context.warnings.length ? `\n\nMissing or limited context:\n${context.warnings.join("\n")}` : ""}` : prompt;
        sessionOwned = false;
        await this.gateway.send(record.agentId, withContext, key, context, { expected: admission, signal: stop.signal, onDispatch: () => {
          stop.signal.throwIfAborted();
          if (admissionEpoch !== this.admissionEpoch || factDigest(config) !== factDigest(this.config) || factDigest(secrets) !== factDigest(this.secrets)) throw new ExecutionStop("Configuration or credentials changed during prompt admission; no prompt was sent");
          if (continuation) {
            const source = this.journal.get(continuation.sourceKey);
            const request = this.journal.request(continuation.requestId);
            if (!source || !request || !["unknown", "submitted", "submitting"].includes(request.state) || request.executionActorId !== continuation.executionActorId || factDigest(request.continuation) !== factDigest(continuation) || !this.config.continuation?.enabled || executionConfigDigest(this.config, projectId, issue!.id) !== continuation.configDigest) throw new ExecutionStop("The continuation approval changed during native admission");
            assertContinuationGrant(source, continuation, continuation.requestId);
          }
          sessionOwned = true;
        } });
        sessionOwned = true;
        if (stop.signal.aborted) {
          await cancelPromise;
          cancelPromise = undefined;
          cancel();
          await cancelPromise;
          stop.signal.throwIfAborted();
        }
        const accepted = await this.gateway.inspect(record.agentId, { includeHistory: false });
        await persist({ phase: "running", nativeLastUserMessageAt: accepted?.lastUserMessageAt ?? undefined });
      }
      if (stop.signal.aborted) { cancel(); stop.signal.throwIfAborted(); }
      flushing = setInterval(() => { void flush().catch((error) => { if (error instanceof StorageError) this.storageFailed(error); }); }, this.timing.flushMs ?? 500);
      let streamed = 0;
      let replayed = 0;
      const { evidence, ...result } = await this.gateway.wait(record.agentId, record.limits?.executionTimeoutMs ?? config.executionTimeoutMs, (text) => {
        const start = replayed;
        replayed += text.length;
        text = text.slice(Math.max(0, streamedTextLength - start));
        const remaining = 1000000 - streamedTextLength;
        if (remaining <= 0) return;
        const visible = text.slice(0, remaining);
        streamed += visible.length;
        streamedTextLength += visible.length;
        for (let start = 0; start < visible.length; start += 12000) events.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: visible.slice(start, start + 12000) });
        if (streamed === 1000000) events.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "\n[Live trace truncated at 1,000,000 characters; full conversation remains in Paseo.]" });
      }, stop.signal, key, config.activityPrivacy && config.activityPrivacy !== "off" && (task.kind === "chat" || task.run.traceEvents) ? (event) => {
        if (stop.signal.aborted) return;
        const id = factDigest(event);
        if (activityIds.has(id)) return;
        const visible = visibleActivity(event, config.activityPrivacy);
        if (!visible) return;
        activityIds.add(id);
        const redacted = redactActivity(visible, secrets);
        if (redacted.type === "TOOL_CALL_ARGS") {
          for (let start = 0; start < redacted.delta.length; start += 12000) events.push({ ...redacted, delta: redacted.delta.slice(start, start + 12000) });
        } else events.push(redacted);
      } : undefined);
      stop.signal.throwIfAborted();
      if (streamedTextLength === 0 && result.output) for (let start = 0; start < Math.min(result.output.length, 1000000); start += 12000) events.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: result.output.slice(start, start + 12000) });
      events.push({ type: "TEXT_MESSAGE_END", messageId }, result.status === "success" ? { type: "RUN_FINISHED", threadId, runId: String(externalId) } : { type: "RUN_ERROR", message: result.error ?? "Agent execution failed" });
      clearInterval(flushing);
      await sending;
      clearInterval(heartbeat);
      clearTimeout(safety);
      clearTimeout(deadline);
      await persist({ phase: "reporting", result, evidence, acceptance: assessAcceptance(intent?.acceptance, result, evidence), pendingEvents: [...events], pendingPermissionCount: 0 });
      this.agentLocks.delete(record.agentId);
      ownsAgentLock = false;
      sessionOwned = false;
      this.notify();
      await this.report(record);
      // A completed agent turn is deliberately not an issue-completion transition.
    } catch (error) {
      clear();
      const reason = error instanceof StorageError ? error : stop.signal.aborted ? stop.signal.reason : error;
      if (reason instanceof StorageError) { cancel(); await cancelPromise; throw reason; }
      // A completed outcome remains authoritative through shutdown or lost ack.
      if (record?.phase === "reporting" && record.result) return;
      if (reason instanceof ExecutionStop && reason.phase === "lease-lost") leaseLost = true;
      cancel();
      await cancelPromise;
      if (!record) throw error;
      if (cancellationUnconfirmed) {
        if (leaseLost || remotelyCanceled) await persist({ phase: remotelyCanceled ? "canceled" : "lease-lost" });
        return;
      }
      const result: Result = { status: "failed", error: reason instanceof ExecutionStop ? reason.message : safeError(reason) };
      if (leaseLost || remotelyCanceled) {
        await persist({ phase: remotelyCanceled ? "canceled" : "lease-lost", result, error: result.error });
      } else {
        await persist({ phase: "reporting", result, error: result.error, acceptance: assessAcceptance(record.intent?.acceptance, result, record.evidence) });
        await this.report(record).catch(() => {});
      }
    } finally {
      clear();
      stop.signal.removeEventListener("abort", cancel);
      await releaseObservation?.();
      if (intentClaim && this.intentClaims.get(intentClaim) === externalId) this.intentClaims.delete(intentClaim);
      if (record && ownsAgentLock) this.agentLocks.delete(record.agentId);
    }
  }

  private report(record: SessionRecord): Promise<void> {
    const inFlight = this.reports.get(record.key);
    if (inFlight) return inFlight;
    const operation = this.deliver(record).finally(() => { this.reports.delete(record.key); this.notify(); });
    this.reports.set(record.key, operation);
    return operation;
  }

  private async deliver(record: SessionRecord): Promise<void> {
    if (!record.result || terminal[this.journal.get(record.key)?.phase ?? "preparing"]) return;
    const result = record.result;
    const controller = new AbortController();
    this.deliveries.set(record.key, controller);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.stopping ? 750 : 30000)]);
      while (record.pendingEvents?.length) {
        const batch = record.pendingEvents.slice(0, 200);
        if (record.kind === "run") {
          const task = record.task;
          if (task?.kind === "run" && task.run.traceEvents) await this.protocol.runEvents(task.run, record.eventOffset, batch, undefined, signal);
        } else if (await this.protocol.chatEvents(record.externalId, batch, record.agentId, signal)) {
          await this.journal.put({ ...record, phase: "canceled", pendingEvents: [], updatedAt: Date.now() });
          return;
        }
        record = { ...record, eventOffset: record.eventOffset + batch.length, pendingEvents: record.pendingEvents.slice(batch.length), updatedAt: Date.now() };
        await this.journal.put(record);
      }
      if (record.kind === "run") await this.protocol.report(record.externalId, { ...result, attempt: record.attempt }, signal);
      else await this.protocol.chatResult(record.externalId, result, signal);
      await this.journal.put({ ...record, phase: "finished", updatedAt: Date.now() });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (terminal[this.journal.get(record.key)?.phase ?? "preparing"]) return;
      if (error instanceof RequestError && [401, 403, 404, 409].includes(error.status)) {
        await this.journal.put({ ...record, phase: "uncertain", error: "Result acknowledgment is ambiguous or lease rejected; outcome preserved, prompt will not be replayed", updatedAt: Date.now() });
        return;
      }
      this.state = "offline";
      this.message = "Result delivery pending; preserved for reconciliation";
      throw error;
    } finally { this.deliveries.delete(record.key); }
  }

  private async confirmCancellation(key: string): Promise<void> {
    await this.journal.update(key, (current) => {
      if (current.cancellation !== "requested" && current.cancellation !== "unconfirmed") return undefined;
      const local = current.kind === "manual" || current.serverUrl !== this.config.serverUrl;
      const expired = current.phase === "lease-lost" || current.phase === "canceled";
      return { ...current, phase: current.phase === "finished" ? "finished" : expired ? current.phase : local ? "canceled" : "reporting",
        cancellation: "confirmed", pendingPermissionCount: 0, updatedAt: Date.now(),
        result: current.result ?? { status: "failed", error: "Execution canceled; native stop confirmed" } };
    });
    const settled = this.journal.get(key);
    if (settled?.phase === "reporting" && settled.result) await this.report(settled).catch((error) => { if (error instanceof StorageError) throw error; });
    if (this.state === "cancellation-error" && !this.journal.records().some((current) => current.cancellation === "unconfirmed")) this.state = this.paused ? "paused" : "idle";
    this.notify();
  }

  private async reconcileCancellation(record: SessionRecord): Promise<void> {
    const controller = new AbortController();
    this.stopRequests.set(record.key, controller);
    try {
      if (record.kind !== "manual" && !["lease-lost", "canceled"].includes(record.phase)) {
        const age = Date.now() - (record.lastHeartbeatAt ?? record.createdAt);
        const safety = record.limits?.leaseSafetyMs ?? this.config.leaseSafetyMs;
        if (age >= safety) {
          await this.journal.update(record.key, (current) => current.cancellation === "unconfirmed" ? { ...current, phase: "lease-lost", error: "Lease safety expired while native stop remained unconfirmed", updatedAt: Date.now() } : undefined);
        } else if (age >= (this.timing.heartbeatMs ?? 60000)) {
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(30000, safety - age)))]);
            let canceled = false;
            if (record.kind === "chat") canceled = await this.protocol.chatHeartbeat(record.externalId, signal);
            else await this.protocol.heartbeat(record.externalId, record.attempt, signal);
            if (controller.signal.aborted || this.stopping) return;
            await this.journal.update(record.key, (current) => current.cancellation === "unconfirmed" ? { ...current, phase: canceled ? "canceled" : current.phase, lastHeartbeatAt: Date.now(), updatedAt: Date.now() } : undefined);
          } catch (error) {
            if (error instanceof StorageError) throw error;
            if (controller.signal.aborted || this.stopping) return;
            if (isAuthError(error) || error instanceof RequestError && [404, 409].includes(error.status)) {
              await this.journal.update(record.key, (current) => current.cancellation === "unconfirmed" ? { ...current, phase: "lease-lost", error: "Lease rejected while native stop remained unconfirmed", updatedAt: Date.now() } : undefined);
            }
          }
        }
      }
      if (controller.signal.aborted || this.stopping || this.journal.get(record.key)?.cancellation !== "unconfirmed") return;
      let native = await this.gateway.inspect(record.agentId);
      if (native?.active || (native?.pendingPermissionCount ?? 0) > 0) {
        try { await this.gateway.cancel(record.agentId); } catch { return; }
        native = await this.gateway.inspect(record.agentId);
      }
      if (!controller.signal.aborted && !this.stopping && native && !native.active && native.pendingPermissionCount === 0) await this.confirmCancellation(record.key);
    } finally { this.stopRequests.delete(record.key); }
  }

  async retryReports(): Promise<void> {
    if (this.reporting || this.stopping) return;
    this.reporting = true;
    try {
      await Promise.all(this.journal.records().filter((record) => record.serverUrl === this.config.serverUrl && record.cancellation === "unconfirmed" && !this.active.has(record.key)).map((record) => this.reconcileCancellation(record)));
      for (const record of this.journal.records()) {
        if (record.serverUrl === this.config.serverUrl && record.phase === "reporting" && record.result && !this.active.has(record.key)) await this.report(record);
      }
    } finally { this.reporting = false; }
  }

  async cancel(key: string): Promise<void> {
    const record = this.journal.get(key);
    if (record?.result && ["reporting", "finished", "uncertain"].includes(record.phase) && record.cancellation !== "unconfirmed") {
      throw new ConfigurationError("This execution already has a durable outcome; no native turn was canceled");
    }
    const active = this.active.get(key);
    if (active) {
      active.stop.abort(new ExecutionStop("Canceled from Paseo; session preserved", "canceled"));
      await active.done;
      if (this.journal.get(key)?.cancellation === "unconfirmed") throw new ConfigurationError("Native cancellation is unconfirmed; inspect the linked Paseo session");
      return;
    }
    if (!record) throw new ConfigurationError("Unknown execution");
    await this.journal.update(key, (current) => ({ ...current, phase: current.phase === "lease-lost" || current.phase === "canceled" ? current.phase : "stopping", cancellation: "requested", updatedAt: Date.now() }));
    try {
      await this.gateway.cancel(record.agentId);
      const session = await this.gateway.inspect(record.agentId);
      if (!session || session.active || session.pendingPermissionCount > 0) throw new Error("Cancellation unconfirmed");
    } catch (error) {
      await this.journal.update(key, (current) => ({ ...current, phase: "uncertain", cancellation: "unconfirmed", error: "Native cancellation is unconfirmed; inspect the linked Paseo session", updatedAt: Date.now() }));
      throw error instanceof StorageError ? error : new ConfigurationError("Native cancellation is unconfirmed; inspect the linked Paseo session");
    } finally { this.notify(); }
    await this.confirmCancellation(key);
  }

  observeTurnEnd(agentId: string, kind: "completed" | "failed" | "canceled"): void {
    this.notify();
    if (kind === "completed") return;
    for (const [key, active] of this.active) {
      const record = this.journal.get(key);
      if (record?.agentId === agentId && ["sending", "running"].includes(record.phase)) active.stop.abort(new ExecutionStop(kind === "canceled" ? "Agent turn canceled in Paseo" : "Agent provider reported a failed turn"));
    }
  }

  async manual(issue: Issue, gateway: Gateway, override: Partial<Selection> = {}): Promise<SessionRecord> {
    if (this.stopping || this.interrupting) throw new ConfigurationError("Execution is stopping; wait before starting a new session");
    const config = structuredClone(this.config);
    const secrets = { ...this.secrets };
    const admissionEpoch = this.admissionEpoch;
    const key = `manual:${randomUUID()}`;
    const stop = new AbortController();
    const active: Active = { stop, done: Promise.resolve(), clear() {} };
    this.active.set(key, active);
    let record: SessionRecord | undefined;
    let dispatched = false;
    const operation = (async () => {
      try {
        const projectId = String(issue.projectId);
        const project = await resolveProject(config, this.protocol, gateway, projectId, stop.signal);
        const preferences = await executionPreferences(this.protocol, config, project, issue, override, stop.signal);
        const selection = await gateway.select(config, project, preferences.selection);
        const plan = makePlan(config, project, selection, { projectId, issueId: issue.id, issueIdentifier: issue.identifier, host: await gateway.host(), sources: preferences.sources });
        stop.signal.throwIfAborted();
        const now = Date.now();
        const taskContext = project.taskContext?.enabled ? await this.journal.cacheTaskContext(await this.protocol.context(issue, project, stop.signal)) : undefined;
        record = { key, kind: "manual", serverUrl: config.serverUrl, externalId: 0, attempt: 0, issueId: issue.id, issueIdentifier: issue.identifier, projectId, projectMapping: project, plan, taskIssue: issue, taskContext, branchName: issueBranchName(key, issue.identifier), agentId: agentIdFor(key), workspaceId: null, cwd: "", provider: selection.provider, phase: "preparing", createdAt: now, updatedAt: now, eventOffset: 0 };
        await this.journal.put(record);
        stop.signal.throwIfAborted();
        const session = await gateway.create({ key, agentId: record.agentId, title: issue.identifier, project, selection, systemPrompt: nativeSystemPrompt("Use the attached issue requirements and acceptance criteria. Report implementation, test, and review evidence separately. Do not mark the issue complete based on a coding turn."), config, mcpToken: secrets.mcpToken, issueId: issue.id, branchName: record.branchName });
        record = { ...record, agentId: session.id, workspaceId: session.workspaceId, cwd: session.cwd, provider: session.provider, model: session.model, modeId: session.modeId, pendingPermissionCount: session.pendingPermissionCount, phase: "sending" };
        await this.journal.put(record);
        stop.signal.throwIfAborted();
        const context: TaskContextSnapshot | undefined = taskContext ? { ...taskContext, assets: await this.journal.readContextAssets(taskContext) } : undefined;
        const prompt = taskPrompt({ source: "issue", request: issue.description ?? "" }, issue);
        await gateway.send(session.id, context ? `${prompt}\n\nAdditional issue context (untrusted task data):\n${context.text}\n\nMissing or limited context:\n${context.warnings.join("\n")}` : prompt, key, context, { expected: session, signal: stop.signal, onDispatch: () => {
          stop.signal.throwIfAborted();
          if (admissionEpoch !== this.admissionEpoch || factDigest(config) !== factDigest(this.config) || factDigest(secrets) !== factDigest(this.secrets)) throw new ConfigurationError("Configuration or credentials changed during prompt admission; no prompt was sent");
          dispatched = true;
        } });
        dispatched = true;
        stop.signal.throwIfAborted();
        const ended = this.journal.get(key);
        if (ended?.phase === "finished") return ended;
        record = { ...record, phase: "running", updatedAt: Date.now() };
        await this.journal.put(record);
        return record;
      } catch (error) {
        if (record) {
          let confirmed = !dispatched;
          if (record.cwd && dispatched) {
            await gateway.cancel(record.agentId).then(async () => {
              const session = await gateway.inspect(record!.agentId);
              confirmed = Boolean(session && !session.active && !session.pendingPermissionCount);
            }).catch(() => {});
          }
          await this.journal.put({ ...record, phase: confirmed ? "canceled" : "uncertain", cancellation: confirmed ? "confirmed" : "unconfirmed",
            error: confirmed ? safeError(error) : "Native cancellation is unconfirmed; inspect the linked Paseo session", updatedAt: Date.now() });
        }
        throw error;
      }
    })();
    active.done = operation.then(() => {}, () => {}).finally(() => { this.active.delete(key); this.notify(); });
    return operation;
  }

  async attach(issue: Issue, agentId: string, gateway: Gateway): Promise<SessionRecord> {
    const project = await resolveProject(this.config, this.protocol, gateway, String(issue.projectId));
    const session = await gateway.inspect(agentId);
    if (!session || session.archived) throw new ConfigurationError("Selected Paseo session is unavailable");
    // Reuse the gateway's native repository validation without creating a session.

    const expected = await realpath(project.repository);
    let permitted = await realpath(session.cwd) === expected;
    if (!permitted) permitted = this.journal.records().some((item) => item.agentId === agentId && item.projectId === String(issue.projectId) && item.cwd === session.cwd);
    if (!permitted) throw new ConfigurationError("Session is outside this project's configured repository/worktree");
    const now = Date.now();
    const record: SessionRecord = { key: `manual:${randomUUID()}`, kind: "manual", serverUrl: this.config.serverUrl, externalId: 0, attempt: 0, issueId: issue.id, issueIdentifier: issue.identifier, projectId: String(issue.projectId), projectMapping: project, agentId, workspaceId: session.workspaceId, cwd: session.cwd, provider: session.provider, model: session.model, modeId: session.modeId, pendingPermissionCount: session.pendingPermissionCount, phase: "finished", createdAt: now, updatedAt: now, eventOffset: 0 };
    await this.journal.put(record);
    return record;
  }

  async milestone(key: string, milestone: Milestone, evidence: string): Promise<void> {
    const record = this.journal.get(key);
    if (!record?.issueId || record.serverUrl !== this.config.serverUrl) throw new ConfigurationError("Execution has no issue on this server");
    const columnId = this.config.projects[record.projectId]?.statusPolicy?.[milestone] ?? this.config.statusPolicy[milestone];
    if (!columnId) throw new ConfigurationError("Configure a target column for this milestone first");
    await this.protocol.transition(record.issueId, columnId, `[Paseo: ${milestone}]\n${evidence}`);
  }

  async stopActive(): Promise<boolean> {
    this.setPaused(true);
    this.interrupting = true;
    try {
      for (const active of this.active.values()) active.stop.abort(new ExecutionStop("Execution stopped from Paseo; session preserved", "canceled"));
      for (const delivery of this.deliveries.values()) delivery.abort();
      await Promise.allSettled(this.loops);
      while (this.reservations) await new Promise<void>((resolve) => this.wake.add(resolve));
      await Promise.allSettled([...this.active.values()].map((active) => active.done));
      const unresolved = this.journal.records().filter((record) =>
        record.cancellation === "unconfirmed" || ["preparing", "created", "sending", "running", "stopping"].includes(record.phase));
      await Promise.allSettled(unresolved.map((record) => this.cancel(record.key)));
      const confirmed = this.state !== "storage-error" && !this.journal.records().some((record) =>
        ["requested", "unconfirmed"].includes(record.cancellation ?? "") || ["preparing", "created", "sending", "running", "stopping"].includes(record.phase));
      this.state = confirmed ? "paused" : this.state === "storage-error" ? "storage-error" : "cancellation-error";
      this.message = confirmed ? "Paused; native cancellation confirmed for stopped executions" : "Paused; native cancellation remains unconfirmed";
      return confirmed;
    } finally { this.interrupting = false; }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.maintenance);
    this.claims.abort();
    for (const request of this.stopRequests.values()) request.abort();
    for (const delivery of this.deliveries.values()) delivery.abort();
    this.notify();
    this.state = "stopping";
    this.message = "Interrupting active turns; unresolved native cancellation will remain visible";
    for (const active of this.active.values()) active.stop.abort(new ExecutionStop("Plugin stopped; session and worktree preserved"));
    const manual = this.journal.records().filter((record) => record.serverUrl === this.config.serverUrl && record.kind === "manual" &&
      !this.active.has(record.key) && ["preparing", "created", "sending", "running", "stopping"].includes(record.phase));
    const cancellations = manual.map((record) => this.cancel(record.key).catch(() => {}));
    const timeout = new AbortController();
    try {
      await Promise.race([
        (async () => {
          await Promise.allSettled(this.loops);
          while (this.reservations) await new Promise<void>((resolve) => this.wake.add(resolve));
          await Promise.allSettled([...cancellations, ...[...this.active.values()].map((item) => item.done)]);
        })(),
        sleep(1400, undefined, { signal: timeout.signal }).catch(() => {}),
      ]);
      for (const key of this.active.keys()) {
        await this.journal.update(key, (record) => record.phase === "reporting" && record.result ? undefined :
          { ...record, phase: "uncertain", cancellation: "unconfirmed", error: "Plugin unloaded before native cancellation could be confirmed", updatedAt: Date.now() });
      }
    } finally { timeout.abort(); }
  }
}
