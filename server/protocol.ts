// Adapted from @itsaplan/runner 0.7.0, packages/runner/src/client.ts.
// Copyright 2026 Andrii Poluosmak. Licensed under Apache-2.0.
// Changes add validated responses, cancellation, safe errors, and planner API access.
import { z } from "zod";
import { httpUrl, type ProjectMapping, type Selection } from "../shared/config";
import { contextLimits, customFieldSchema, type CustomField, type TaskContextSnapshot } from "../shared/task-context";
import {
  chatSchema, eventSchema, issueSchema, projectSchema, resultSchema, runSchema,
  type AgUiEvent, type ChatMessage, type Issue, type LinkedRepository, type Project, type Result, type Run,
} from "../shared/models";
import type { Protocol } from "./contracts";
import type { RerunRequest, TaskIntent } from "../shared/experience";
import { ConfigurationError } from "./errors";
import { parseRequestComment, smokeOutput, smokeTask } from "./task";
import { collectTaskContext } from "./task-context";

const positiveId = z.number().int().positive();
const projectWire = projectSchema.omit({ repositoryMatch: true }).extend({ ref: z.string().min(1), teamId: positiveId.optional() });
const projectPage = z.object({
  items: z.array(projectWire).max(100), total: z.number().int().nonnegative(),
  page: positiveId, pageSize: positiveId.max(100),
});
const connectionsSchema = z.array(z.object({
  provider: z.string().min(1),
  repositories: z.array(z.object({ id: positiveId, fullName: z.string().min(1), webUrl: z.string().max(4096), status: z.enum(["connected", "error"]) })),
}));
const wireResult = resultSchema.extend({
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable().optional(),
});
const cancellation = z.union([z.object({ canceled: z.boolean() }), z.undefined()]);
const issueWire = issueSchema.extend({ identifier: z.string().min(1) });
const searchHit = issueWire.omit({ projectId: true }).extend({ projectId: positiveId.optional() });
const sessionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queueRunWire = z.object({
  id: positiveId, agentId: positiveId, username: z.string().min(1), projectRef: z.string().min(1),
  issueId: positiveId.nullable(), sequenceNumber: positiveId.nullable(), prompt: z.string(),
  trigger: runSchema.shape.trigger, status: z.enum(["pending", "success", "failed", "canceled"]),
  executionState: z.enum(["queued", "running", "success", "failed", "canceled"]),
  attempts: z.number().int().nonnegative(), createdAt: z.string().datetime({ offset: true }), nextAttemptAt: z.string().datetime({ offset: true }),
});
const fieldIssueWire = z.object({
  id: positiveId, projectId: positiveId, typeId: positiveId.nullable(),
  fields: z.array(z.object({ fieldId: positiveId, fieldType: z.string(), optionIds: z.array(positiveId).max(1000) })).max(1000),
});
const feedWire = z.object({
  items: z.array(z.object({
    id: positiveId, issueId: positiveId, kind: z.string().max(100),
    actorUserId: z.string().min(1).max(500).nullable(), body: z.string().max(50_000).nullable(),
  })).max(2000),
  nextCursor: z.object({ ts: z.string().min(1).max(200), id: positiveId }).nullable(),
});
const queuePageWire = z.object({
  items: z.array(queueRunWire).max(100), total: z.number().int().nonnegative(), page: positiveId, pageSize: positiveId.max(100),
});
const actorWire = z.object({
  id: positiveId, userId: z.string().min(1), username: z.string().min(1), kind: z.enum(["external", "internal"]),
  invocationUrl: z.string().nullable(), delegationDelaySec: z.number().int().nonnegative(),
});
export type UpstreamRun = {
  id: number; agentId: number; username: string; projectId: string; projectName: string; issueId: number | null; issueIdentifier: string | null;
  prompt: string; trigger: Run["trigger"]; status: "pending" | "success" | "failed" | "canceled";
  executionState: "queued" | "running" | "success" | "failed" | "canceled"; attempts: number; createdAt: string; nextAttemptAt: string;
};

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}
export class AgentIdentityError extends RequestError {
  constructor() {
    super(403, "API authentication succeeded, but this key belongs to a regular account. Save an It's a Plan external agent's execution API key, not a personal or MCP token.");
    this.name = "AgentIdentityError";
  }
}
export const isAuthError = (error: unknown): boolean => error instanceof RequestError && (error.status === 401 || error.status === 403);
export const isTransientError = (error: unknown): boolean =>
  (error instanceof RequestError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500)) ||
  (error instanceof Error && error.name === "TimeoutError");
export const isLeaseError = (error: unknown): boolean => error instanceof RequestError && (error.status === 404 || error.status === 409);

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, "Invalid It's a Plan request");
  return result.data;
}

export class Client implements Protocol {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  readonly signal: AbortSignal | undefined;

  constructor(options: { url: string; apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }) {
    const url = httpUrl.safeParse(options.url);
    if (!url.success) throw new RequestError(400, "Invalid It's a Plan server URL");
    if (!options.apiKey.trim() || /[\r\n\0]/.test(options.apiKey)) throw new RequestError(401, "An It's a Plan agent API key is required");
    this.url = url.data.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
  }

  private request(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<void>;
  private request<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined, schema: z.ZodType<T>, timeoutMs?: number, maxResponseBytes?: number): Promise<T>;
  private async request(method: string, path: string, body: unknown, signal?: AbortSignal, schema?: z.ZodType, timeoutMs = 30_000, maxResponseBytes?: number): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const joined = this.signal ? AbortSignal.any(signal ? [this.signal, signal, timeout] : [this.signal, timeout]) : signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      joined.throwIfAborted();
      const response = await this.fetcher(`${this.url}${path}`, {
        method, redirect: "error", credentials: "omit",
        headers: { "x-api-key": this.apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: joined,
      });
      if (!response.ok) throw new RequestError(response.status, `It's a Plan request failed (HTTP ${response.status})`);
      if (!schema) {
        await response.body?.cancel();
        return;
      }
      let raw: unknown;
      if (response.status === 204) raw = undefined;
      else if (maxResponseBytes !== undefined) {
        const declared = response.headers.get("content-length");
        if (declared && Number(declared) > maxResponseBytes) {
          await response.body?.cancel();
          throw new RequestError(502, "It's a Plan response exceeds the context budget");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RequestError(502, "Invalid response from It's a Plan");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const chunks: string[] = [];
        let bytes = 0;
        try {
          for (;;) {
            joined.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxResponseBytes) throw new RequestError(502, "It's a Plan response exceeds the context budget");
            chunks.push(decoder.decode(chunk.value, { stream: true }));
          }
          chunks.push(decoder.decode());
          raw = JSON.parse(chunks.join(""));
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      } else raw = await response.json();
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new RequestError(502, "Invalid response from It's a Plan");
      return parsed.data;
    } catch (error) {
      if (joined.aborted) {
        if (signal?.aborted || this.signal?.aborted) throw new DOMException("It's a Plan request canceled", "AbortError");
        throw new DOMException("It's a Plan request timed out", "TimeoutError");
      }
      if (error instanceof RequestError) throw error;
      if (error instanceof SyntaxError) throw new RequestError(502, "Invalid response from It's a Plan");
      throw new RequestError(0, "Unable to reach It's a Plan");
    }
  }

  async claim(signal?: AbortSignal): Promise<Run | null> {
    return (await this.request("POST", "/agent-runs/claim", undefined, signal, z.object({ run: runSchema.nullable() }))).run;
  }
  async claimChat(signal?: AbortSignal): Promise<ChatMessage | null> {
    return (await this.request("POST", "/agent-chats/claim", undefined, signal, z.object({ message: chatSchema.nullable() }), 35_000)).message;
  }
  async heartbeat(runId: number, attempt?: number, signal?: AbortSignal): Promise<void> {
    input(positiveId, runId);
    if (attempt !== undefined) input(positiveId, attempt);
    await this.request("POST", `/agent-runs/${runId}/heartbeat`, attempt === undefined ? undefined : { attempt }, signal);
  }
  async report(runId: number, result: Result & { attempt?: number }, signal?: AbortSignal): Promise<void> {
    input(positiveId, runId);
    const body = input(wireResult.extend({ attempt: positiveId.optional() }), result);
    await this.request("POST", `/agent-runs/${runId}/result`, body, signal);
  }
  async runEvents(run: Run, offset: number, events: AgUiEvent[], sessionId?: string, signal?: AbortSignal): Promise<void> {
    input(positiveId, run.id);
    input(positiveId, run.attempts);
    input(z.number().int().nonnegative(), offset);
    const batch = input(z.array(eventSchema), events);
    for (let start = 0; start < batch.length; start += 200) {
      await this.request("POST", `/agent-runs/${run.id}/events`, {
        attempt: run.attempts, offset: offset + start, events: batch.slice(start, start + 200),
        ...(sessionId && sessionUuid.test(sessionId) ? { sessionId } : {}),
      }, signal);
    }
  }
  // Chat writes are fenced by message id, not attempt. The caller must stop an old
  // owner before reporting progress or results for a reclaimed message.
  async chatHeartbeat(messageId: number, signal?: AbortSignal): Promise<boolean> {
    input(positiveId, messageId);
    const ack = await this.request("POST", `/agent-chats/${messageId}/heartbeat`, undefined, signal, cancellation);
    return ack?.canceled ?? false;
  }
  async chatEvents(messageId: number, events: AgUiEvent[], sessionId?: string, signal?: AbortSignal): Promise<boolean> {
    input(positiveId, messageId);
    if (sessionId !== undefined) input(z.string().max(200), sessionId);
    const batch = input(z.array(eventSchema), events);
    for (let start = 0; start < batch.length; start += 200) {
      const ack = await this.request("POST", `/agent-chats/${messageId}/events`, {
        events: batch.slice(start, start + 200), ...(sessionId ? { sessionId } : {}),
      }, signal, cancellation);
      if (ack?.canceled) return true;
    }
    return false;
  }
  async chatResult(messageId: number, result: Result, signal?: AbortSignal): Promise<void> {
    input(positiveId, messageId);
    const { status, error, usage } = input(wireResult, result);
    await this.request("POST", `/agent-chats/${messageId}/result`, { status, error, usage }, signal);
  }
  private async projectCatalog(signal?: AbortSignal): Promise<z.infer<typeof projectWire>[]> {
    const projects: z.infer<typeof projectWire>[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request("GET", `/projects/search?page=${page}&pageSize=100&sort=key`, undefined, signal, projectPage);
      if (result.page !== page || result.pageSize !== 100 || (!result.items.length && projects.length < result.total)) {
        throw new RequestError(502, "Invalid project pagination from It's a Plan");
      }
      projects.push(...result.items);
      if (page * result.pageSize >= result.total) return projects;
    }
  }
  async projects(signal?: AbortSignal): Promise<Project[]> {
    return (await this.projectCatalog(signal)).map(({ id, key, name }) => ({ id, key, name }));
  }
  private async projectReference(projectId: number, signal?: AbortSignal): Promise<string> {
    input(positiveId, projectId);
    const page = await this.request("GET", `/projects/search?ids=${projectId}&page=1&pageSize=100`, undefined, signal, projectPage);
    const project = page.items.find((item) => item.id === projectId);
    if (!project) throw new RequestError(404, "It's a Plan project is unavailable");
    return project.ref;
  }
  async repositories(projectId: number, signal?: AbortSignal): Promise<LinkedRepository[]> {
    const ref = await this.projectReference(projectId, signal);
    const connections = await this.request("GET", `/projects/${encodeURIComponent(ref)}/settings/git/connections`, undefined, signal, connectionsSchema);
    const repositories: LinkedRepository[] = [];
    for (const connection of connections) for (const linked of connection.repositories) {
      if (linked.status !== "connected") continue;
      let url: URL;
      try { url = new URL(linked.webUrl); } catch { throw new RequestError(502, "Invalid repository metadata from It's a Plan"); }
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new RequestError(502, "Invalid repository metadata from It's a Plan");
      repositories.push({ id: linked.id, provider: connection.provider, fullName: linked.fullName, webUrl: linked.webUrl });
    }
    return repositories;
  }
  async issue(id: number, signal?: AbortSignal): Promise<Issue> {
    input(positiveId, id);
    const issue = await this.request("GET", `/issues/${id}`, undefined, signal, issueWire);
    if (issue.id !== id) throw new RequestError(502, "Invalid issue response from It's a Plan");
    return issue;
  }
  async search(projectId: number, query: string, signal?: AbortSignal): Promise<Issue[]> {
    input(z.string().max(300), query);
    const ref = await this.projectReference(projectId, signal);
    const path = `/projects/${encodeURIComponent(ref)}/issues${query.trim() ? "/search" : ""}`;
    const params = new URLSearchParams({ limit: "50", ...(query.trim() ? { q: query.trim() } : {}) });
    const hits = await this.request("GET", `${path}?${params}`, undefined, signal, z.array(searchHit).max(50));
    return hits.map((hit) => {
      if (hit.projectId !== undefined && hit.projectId !== projectId) throw new RequestError(502, "Invalid issue project from It's a Plan");
      return { ...hit, projectId };
    });
  }
  async customFields(projectId: number, issueTypeId?: number, signal?: AbortSignal): Promise<CustomField[]> {
    if (issueTypeId !== undefined) input(positiveId, issueTypeId);
    const ref = await this.projectReference(projectId, signal);
    const query = issueTypeId === undefined ? "" : `?issueTypeId=${issueTypeId}`;
    return this.request("GET", `/projects/${encodeURIComponent(ref)}/custom-fields${query}`, undefined, signal, z.array(customFieldSchema).max(1000), 30_000, contextLimits.responseBytes);
  }
  async issueSelection(issue: Issue, project: ProjectMapping, signal?: AbortSignal): Promise<Partial<Selection>> {
    const bindings = project.fieldBindings ?? [];
    if (!bindings.length) return {};
    if (bindings.some((binding) => binding.projectId !== issue.projectId)) throw new ConfigurationError("A field mapping belongs to a different project. Review this project's field mappings.");
    const current = await this.request("GET", `/issues/${input(positiveId, issue.id)}`, undefined, signal, fieldIssueWire, 30_000, contextLimits.responseBytes);
    if (current.id !== issue.id || current.projectId !== issue.projectId) throw new RequestError(502, "Invalid issue field scope from It's a Plan");
    const fields = await this.customFields(issue.projectId, current.typeId ?? undefined, signal);
    const matches: Partial<Selection>[] = [];
    for (const binding of bindings) {
      if (binding.issueTypeId !== null && binding.issueTypeId !== current.typeId) continue;
      const field = fields.find((candidate) => candidate.id === binding.fieldId && candidate.issueTypeId === binding.issueTypeId);
      if (!field || !["select", "multi_select"].includes(field.fieldType) || !field.options.some((option) => option.id === binding.optionId)) {
        throw new ConfigurationError("A configured provider/model field or option is unavailable or changed type. Review this project's field mappings.");
      }
      const value = current.fields.find((candidate) => candidate.fieldId === field.id);
      if (value && value.fieldType !== field.fieldType) throw new ConfigurationError("Issue field metadata changed while resolving execution preferences. Refresh the field mappings.");
      if (value?.optionIds.includes(binding.optionId)) matches.push({ provider: binding.provider, model: binding.model });
    }
    const selected = matches[0];
    if (matches.some((match) => match.provider !== selected?.provider || match.model !== selected?.model)) throw new ConfigurationError("Selected issue field options map to conflicting providers or models. Choose one execution selection.");
    return selected ?? {};
  }
  async context(issue: Issue, project: ProjectMapping, signal?: AbortSignal): Promise<TaskContextSnapshot> {
    const read = <T>(path: string, schema: z.ZodType<T>, requestSignal?: AbortSignal) =>
      this.request("GET", path, undefined, requestSignal, schema, contextLimits.timeoutMs, contextLimits.responseBytes);
    const cancellation = this.signal ? AbortSignal.any([this.signal, ...(signal ? [signal] : [])]) : signal;
    return collectTaskContext(issue, project, read, cancellation, { redact: [this.apiKey] });
  }
  async transition(issueId: number, columnId: number, evidence: string, signal?: AbortSignal): Promise<void> {
    input(positiveId, issueId);
    input(positiveId, columnId);
    input(z.string().trim().min(1).max(10_000), evidence);
    await this.request("POST", `/issues/${issueId}/comments`, { body: evidence }, signal);
    await this.request("PATCH", `/issues/${issueId}`, { columnId }, signal);
  }
  async identity(signal?: AbortSignal): Promise<{ id: string; username: string | null; isAgent: boolean }> {
    const identity = await this.request("GET", "/me", undefined, signal, z.discriminatedUnion("authenticated", [
      z.object({ authenticated: z.literal(false) }),
      z.object({ authenticated: z.literal(true), user: z.object({ id: z.string().min(1), isAgent: z.boolean(), username: z.string().min(1).nullable().optional() }) }),
    ]));
    if (!identity.authenticated) throw new RequestError(401, "It's a Plan rejected the API key");
    return { id: identity.user.id, username: identity.user.username ?? null, isAgent: identity.user.isAgent };
  }
  async agent(signal?: AbortSignal): Promise<{ id: number; username: string; kind: "external" | "internal"; invocationUrl: string | null; delegationDelaySec: number; settingsPath?: string } | null> {
    const identity = await this.identity(signal);
    if (!identity.isAgent) throw new AgentIdentityError();
    const projects = await this.projectCatalog(signal);
    const teams = new Set<number>();
    for (const project of projects) if (project.teamId) teams.add(project.teamId);
    for (const teamId of teams) {
      let actors: z.infer<typeof actorWire>[];
      try { actors = await this.request("GET", `/teams/${teamId}/ai-agents`, undefined, signal, z.array(actorWire)); }
      catch (error) {
        if (error instanceof RequestError && (error.status === 403 || error.status === 404)) continue;
        throw error;
      }
      const actor = actors.find((candidate) => candidate.userId === identity.id);
      if (actor) {
        const reference = projects.find((project) => project.teamId === teamId)!.ref;
        const teamReference = reference.slice(0, reference.indexOf("."));
        return { id: actor.id, username: actor.username, kind: actor.kind, invocationUrl: actor.invocationUrl, delegationDelaySec: actor.delegationDelaySec, ...(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(teamReference) ? { settingsPath: `/${encodeURIComponent(teamReference)}/settings/ai-agents` } : {}) };
      }
    }
    return null;
  }
  private async readQueue(signal?: AbortSignal, runId?: number): Promise<{ items: UpstreamRun[]; complete: boolean }> {
    const identity = await this.identity(signal);
    if (!identity.isAgent) throw new AgentIdentityError();
    const username = identity.username ?? (await this.agent(signal))?.username;
    if (!username) throw new ConfigurationError("The external agent's username is unavailable; check the agent identity in It's a Plan");
    const query = new URLSearchParams({ page: "1", pageSize: "100" });
    if (runId !== undefined) query.set("runId", String(input(positiveId, runId)));
    const page = await this.request("GET", `/agent-runs/queue?${query}`, undefined, signal, queuePageWire);
    if (page.page !== 1 || page.pageSize !== 100 || page.items.length > page.total || (runId !== undefined && page.items.some((row) => row.id !== runId))) {
      throw new RequestError(502, "Invalid execution queue response from It's a Plan");
    }
    const projects = await this.projectCatalog(signal);
    const byReference = new Map<string, z.infer<typeof projectWire>>();
    for (const project of projects) byReference.set(project.ref, project);
    const items: UpstreamRun[] = [];
    for (const row of page.items) {
      if (row.username.toLowerCase() !== username.toLowerCase()) continue;
      const project = byReference.get(row.projectRef);
      if (!project) throw new ConfigurationError("Execution project metadata is unavailable; check project access in It's a Plan");
      items.push({
        id: row.id, agentId: row.agentId, username: row.username, projectId: String(project.id), projectName: project.name,
        issueId: row.issueId, issueIdentifier: row.sequenceNumber === null ? null : `${project.key}-${row.sequenceNumber}`,
        prompt: row.prompt, trigger: row.trigger, status: row.status, executionState: row.executionState, attempts: row.attempts,
        createdAt: row.createdAt, nextAttemptAt: row.nextAttemptAt,
      });
    }
    return { items, complete: page.total <= page.pageSize };
  }
  queue(signal?: AbortSignal): Promise<{ items: UpstreamRun[]; complete: boolean }> { return this.readQueue(signal); }
  async getRun(id: number, signal?: AbortSignal): Promise<UpstreamRun | null> {
    return (await this.readQueue(signal, id)).items.find((row) => row.id === id) ?? null;
  }
  async intent(run: Run, issue?: Issue, signal?: AbortSignal, lookup?: (id: string) => RerunRequest | undefined): Promise<TaskIntent> {
    let source: UpstreamRun | null;
    try { source = await this.getRun(run.id, signal); }
    catch (error) {
      if (error instanceof RequestError && (error.status === 403 || error.status === 404)) throw new ConfigurationError("Original task context is unavailable. Grant this bot work-item and agent read access and use an It's a Plan version with the runner queue API.");
      throw error;
    }
    if (!source || source.issueId !== run.issueId || source.trigger !== run.trigger || (issue && source.projectId !== String(issue.projectId))) {
      throw new ConfigurationError("The claimed execution's task, issue, or project could not be verified");
    }
    if (source.attempts !== run.attempts || source.status !== "pending" || source.executionState !== "running") {
      throw new RequestError(409, "The execution attempt is no longer current");
    }
    const scope = { agentId: source.agentId, projectId: source.projectId, issueId: source.issueId };
    let requestId: string | undefined;
    for (let depth = 0; depth < 8; depth++) {
      const request = parseRequestComment(source.prompt, source.username);
      if (!request) {
        if (source.trigger === "delegation") {
          const context = issue ?? (source.issueId ? await this.issue(source.issueId, signal) : undefined);
          if (!context || context.id !== scope.issueId || String(context.projectId) !== scope.projectId) throw new ConfigurationError("The delegated issue's requirements are unavailable");
          return { version: 1, source: "issue", request: context.description?.trim() ? context.description : context.title, projectId: scope.projectId, sourceRunId: source.id, ...(requestId ? { requestId } : {}) };
        }
        return { version: 1, source: source.trigger === "mention" ? "comment" : "task", request: source.prompt, projectId: scope.projectId, sourceRunId: source.id, ...(requestId ? { requestId } : {}) };
      }
      requestId ??= request.requestId;
      if (request.version === 2) {
        const prepared = lookup?.(request.requestId);
        const actor = await this.identity(signal);
        if (source.trigger !== "mention" || request.issueId !== scope.issueId || request.projectId !== scope.projectId || request.agentId !== scope.agentId ||
          !prepared || prepared.id !== request.requestId || prepared.source?.kind !== "issue" || prepared.operation !== "smoke" || prepared.serverUrl.replace(/\/+$/, "") !== this.url ||
          prepared.issueId !== scope.issueId || prepared.projectId !== scope.projectId || prepared.body !== source.prompt ||
          prepared.source.agentId !== scope.agentId || prepared.source.actorId !== actor.id || prepared.source.username !== source.username ||
          !actor.isAgent || actor.username !== source.username || prepared.executionActorId !== actor.id ||
          (prepared.delivery === "api" && !prepared.requestActorId) ||
          (prepared.state !== "unknown" && prepared.state !== "submitted" && !(prepared.delivery === "api" && prepared.state === "submitting")) ||
          (prepared.runId !== null && prepared.runId !== source.id)) {
          throw new ConfigurationError("The issue-origin smoke request is not backed by a matching durable handed-off request for this actor, issue, and project");
        }
        return { version: 1, source: "smoke", request: smokeTask, projectId: scope.projectId, sourceRunId: source.id, requestId, acceptance: { expectedOutput: smokeOutput, noTools: true } };
      }
      if (request.sourceRunId >= source.id) throw new ConfigurationError("The Paseo execution request contains a cyclic or forward task reference");
      const previous = await this.getRun(request.sourceRunId, signal);
      if (!previous || previous.agentId !== scope.agentId || previous.projectId !== scope.projectId || previous.issueId !== scope.issueId) {
        throw new ConfigurationError("The Paseo execution request references a different agent, project, or issue");
      }
      if (request.operation === "continue") {
        const prepared = lookup?.(request.requestId);
        const actor = await this.identity(signal);
        const grant = prepared?.continuation;
        if (source.trigger !== "mention" || !prepared || prepared.operation !== "continue" ||
          prepared.serverUrl.replace(/\/+$/, "") !== this.url || prepared.body !== source.prompt ||
          prepared.issueId !== scope.issueId || prepared.projectId !== scope.projectId ||
          prepared.executionActorId !== actor.id || !actor.isAgent || actor.username !== source.username ||
          (prepared.delivery === "api" && !prepared.requestActorId) ||
          !["unknown", "submitted", ...(prepared.delivery === "api" ? ["submitting"] : [])].includes(prepared.state) ||
          (prepared.runId !== null && prepared.runId !== source.id) ||
          !grant || grant.requestId !== prepared.id || grant.requestId !== request.requestId ||
          grant.executionActorId !== actor.id || grant.sourceKey !== prepared.sourceKey ||
          grant.attestation !== "same-task-unrestricted" || (depth === 0 && grant.expiresAt <= Date.now())) {
          throw new ConfigurationError("The continuation request is not backed by a matching durable approval for this task and actor");
        }
      }
      if (request.operation === "smoke") return { version: 1, source: "smoke", request: smokeTask, projectId: scope.projectId, sourceRunId: previous.id, requestId, acceptance: { expectedOutput: smokeOutput, noTools: true } };
      source = previous;
    }
    throw new ConfigurationError("The Paseo execution request has too many nested task references");
  }
  async comment(issueId: number, body: string, signal?: AbortSignal): Promise<{ id: number }> {
    input(positiveId, issueId);
    input(z.string().min(1).max(50_000), body);
    return this.request("POST", `/issues/${issueId}/comments`, { body }, signal, z.object({ id: positiveId }));
  }
  async updateComment(commentId: number, body: string, signal?: AbortSignal): Promise<{ id: number }> {
    input(positiveId, commentId);
    input(z.string().min(1).max(50_000), body);
    const result = await this.request("PATCH", `/comments/${commentId}`, { body }, signal, z.object({ id: positiveId }));
    if (result.id !== commentId) throw new RequestError(502, "Invalid comment update receipt from It's a Plan");
    return result;
  }
  async commentFeed(issueId: number, signal?: AbortSignal): Promise<{ items: Array<{ id: number; body: string; actorId: string }>; complete: boolean }> {
    input(positiveId, issueId);
    const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const items: Array<{ id: number; body: string; actorId: string }> = [];
    const ids = new Set<number>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ filter: "comments", limit: "100", order: "desc", ...(cursor ? { cursor } : {}) });
      const result = await this.request("GET", `/issues/${issueId}/feed?${query}`, undefined, deadline, feedWire, 30_000, contextLimits.responseBytes);
      for (const row of result.items) {
        if (row.issueId !== issueId || ids.has(row.id)) throw new RequestError(502, "Invalid comment feed scope or pagination from It's a Plan");
        ids.add(row.id);
        if (row.kind === "comment" && row.body !== null && row.actorUserId !== null) items.push({ id: row.id, body: row.body, actorId: row.actorUserId });
      }
      if (result.nextCursor === null) return { items, complete: true };
      cursor = JSON.stringify(result.nextCursor);
      if (cursors.has(cursor)) throw new RequestError(502, "Invalid comment feed pagination from It's a Plan");
      cursors.add(cursor);
    }
    return { items, complete: false };
  }
  async test(signal?: AbortSignal): Promise<void> {
    if (!(await this.identity(signal)).isAgent) throw new AgentIdentityError();
  }
}
