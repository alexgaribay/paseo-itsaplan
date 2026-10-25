import { createHash, randomUUID } from "node:crypto";
import type { ExecutionPlan, RerunPreview, RerunRequest, RerunResult } from "../shared/experience";
import { ConfigurationError } from "./errors";
import { planForIssue, type ExperienceContext } from "./experience";
import { Client, RequestError, type UpstreamRun } from "./protocol";
import type { PrivateStorage } from "./storage";
import { requestComment, smokeComment } from "./task";
import { assertContinuationScope, assertSourceCurrent, continuationScope, sourceFacts } from "./continuation";
import type { ContinuationScope } from "../shared/continuation";

const operations = new WeakMap<PrivateStorage, Promise<unknown>>();
type RequestSource = { kind: "run"; key: string } | { kind: "issue"; issueId: number };
interface RequestScope {
  sourceKey: string;
  source: NonNullable<RerunRequest["source"]>;
  issueId: number;
  projectId: string;
  agentId: number;
  actor: { id: string; username: string; isAgent: boolean };
  run?: UpstreamRun;
}

async function exclusive<T>(context: ExperienceContext, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(context.storage) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  operations.set(context.storage, current);
  try { return await current; }
  finally { if (operations.get(context.storage) === current) operations.delete(context.storage); }
}

function issueKey(context: ExperienceContext, issueId: number): string {
  return `issue:${createHash("sha256").update(context.config.serverUrl).digest("hex")}:${issueId}`;
}

async function scopeFor(context: ExperienceContext, source: RequestSource): Promise<RequestScope> {
  const actor = await context.protocol.identity();
  if (!actor.isAgent || !actor.username) throw new ConfigurationError("Execution requests require the external agent's execution key and mention handle.");
  const identity = { ...actor, username: actor.username };
  if (source.kind === "issue") {
    const agent = await context.protocol.agent();
    if (!agent || agent.kind !== "external" || agent.username !== actor.username || agent.invocationUrl) throw new ConfigurationError("The polling external agent identity is unavailable or does not match this connection.");
    const issue = await context.protocol.issue(source.issueId);
    const projectId = String(issue.projectId);
    if (!context.config.projects[projectId]) throw new ConfigurationError("Configure this project's execution preferences before testing delegation.");
    return { sourceKey: issueKey(context, issue.id), source: { kind: "issue", agentId: agent.id, actorId: actor.id, username: actor.username }, issueId: issue.id, projectId, agentId: agent.id, actor: identity };
  }
  const record = context.storage.get(source.key);
  if (!record || record.kind !== "run" || !record.issueId) throw new ConfigurationError("Rerun requires a recorded issue run.");
  if (record.serverUrl !== context.config.serverUrl) throw new ConfigurationError("This run belongs to a different It's a Plan connection.");
  if (!context.config.projects[record.projectId]) throw new ConfigurationError("Configure the source project's execution preferences before rerunning.");
  const run = await context.protocol.getRun(record.externalId);
  if (!run || run.issueId !== record.issueId || run.projectId !== record.projectId || run.username !== actor.username) throw new ConfigurationError("The authoritative source run is unavailable or belongs to another agent, issue, or project.");
  const issue = await context.protocol.issue(record.issueId);
  if (String(issue.projectId) !== run.projectId) throw new ConfigurationError("The source issue changed project. Prepare a request from its current authoritative run.");
  return { sourceKey: record.key, source: { kind: "run" }, issueId: record.issueId, projectId: record.projectId, agentId: run.agentId, actor: identity, run };
}

function bodyFor(scope: RequestScope, id: string, operation: RerunRequest["operation"]): string {
  if (scope.source.kind === "issue") {
    if (operation !== "smoke") throw new ConfigurationError("Issue-origin execution requests support only the fixed smoke test.");
    return smokeComment(scope.actor.username, id, scope);
  }
  if (!scope.run) throw new ConfigurationError("The source run is unavailable.");
  return requestComment(scope.actor.username, id, scope.run.id, operation);
}

async function requestScope(context: ExperienceContext, request: RerunRequest): Promise<RequestScope> {
  if (request.serverUrl !== context.config.serverUrl) throw new ConfigurationError("The request belongs to a different It's a Plan connection.");
  const scope = await scopeFor(context, request.source?.kind === "issue" ? { kind: "issue", issueId: request.issueId } : { kind: "run", key: request.sourceKey });
  if (request.sourceKey !== scope.sourceKey || request.issueId !== scope.issueId || request.projectId !== scope.projectId || request.executionActorId && request.executionActorId !== scope.actor.id || request.source?.kind === "issue" && (scope.source.kind !== "issue" || request.source.actorId !== scope.actor.id || request.source.agentId !== scope.agentId || request.source.username !== scope.actor.username) || request.body !== bodyFor(scope, request.id, request.operation)) {
    throw new ConfigurationError("The request's actor, source, issue, or project scope no longer matches this connection.");
  }
  return scope;
}

function digest(context: ExperienceContext, scope: RequestScope, plan: ExecutionPlan, body: string, delivery: RerunRequest["delivery"], requestActorId?: string, continuation?: ContinuationScope): string {
  return createHash("sha256").update(JSON.stringify({ version: 2, serverUrl: context.config.serverUrl, sourceKey: scope.sourceKey, source: scope.source, sourceRunId: scope.run?.id, agentId: scope.agentId, actorId: scope.actor.id, username: scope.actor.username, plan, body, delivery, requestActorId, continuation })).digest("hex");
}

function legacyDigest(context: ExperienceContext, scope: RequestScope, plan: ExecutionPlan, body: string): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, serverUrl: context.config.serverUrl, sourceKey: scope.sourceKey, sourceRunId: scope.run?.id, agentId: scope.agentId, actorId: scope.actor.id, username: scope.actor.username, plan, body })).digest("hex");
}

function result(request: RerunRequest, message: string): RerunResult {
  return { requestId: request.id, state: request.state === "submitting" ? "unknown" : request.state, commentId: request.commentId, runId: request.runId, message };
}

async function requestActor(context: ExperienceContext): Promise<{ client: Client; id: string } | null> {
  const { requestApiKey } = await context.credentials();
  if (!requestApiKey) return null;
  const client = new Client({ url: context.config.serverUrl, apiKey: requestApiKey, signal: context.protocol.signal });
  context.assertCurrent();
  const identity = await client.identity();
  if (identity.isAgent) throw new ConfigurationError("The request credential must belong to a human account. Agent-authored comments cannot queue execution requests.");
  return { client, id: identity.id };
}

async function deliveryActor(context: ExperienceContext, request: RerunRequest): Promise<{ client: Client; id: string } | null> {
  if (request.delivery === "browser") return null;
  const human = await requestActor(context);
  if (!human || !request.requestActorId || human.id !== request.requestActorId) throw new ConfigurationError("The human delivery actor changed or is unavailable. Discard this untouched preview and review a new request; its delivery channel cannot change.");
  return human;
}

function assertEnabled(context: ExperienceContext, scope: RequestScope): void {
  if (!context.config.automatic || !context.config.projects[scope.projectId]?.automatic || context.runtime.paused || context.runtime.pendingConfiguration || !context.runtime.claiming || context.storage.paused()) throw new ConfigurationError("Enable saved global and project automatic execution and resume claiming before delivering this request. Execution must not be paused or draining.");
}

function matches(request: RerunRequest, scope: RequestScope, run: UpstreamRun): boolean {
  return run.prompt === request.body && run.trigger === "mention" && run.agentId === scope.agentId && run.username === scope.actor.username && run.issueId === request.issueId && run.projectId === request.projectId;
}

async function assertNoOutstanding(context: ExperienceContext, scope: RequestScope, except?: string): Promise<void> {
  for (const request of context.storage.requests()) {
    if (request.serverUrl !== context.config.serverUrl || request.issueId !== scope.issueId || request.id === except || request.state === "failed" || request.state === "dismissed") continue;
    if (request.state === "submitted" && request.runId !== null) {
      const run = await context.protocol.getRun(request.runId);
      if (run && matches(request, scope, run) && run.executionState !== "queued" && run.executionState !== "running") continue;
    }
    throw new ConfigurationError("A request for this issue is prepared, pending, active, or has unknown delivery. Reconcile it before creating another operation.");
  }
  if (scope.run && (scope.run.executionState === "queued" || scope.run.executionState === "running")) throw new ConfigurationError("The source run is still queued or running. Wait for a terminal upstream state.");
  const queue = await context.protocol.queue();
  if (queue.items.some((run) => run.issueId === scope.issueId && (run.executionState === "queued" || run.executionState === "running"))) throw new ConfigurationError("This issue already has queued or running upstream work. Wait for it to finish before creating another operation.");
  if (!queue.complete) throw new ConfigurationError("Only a partial queue is visible. An incomplete queue cannot prove this issue has no active work.");
  for (const record of context.storage.records()) {
    if (record.serverUrl !== context.config.serverUrl || record.issueId !== scope.issueId) continue;
    if (["preparing", "created", "sending", "running", "stopping", "reporting"].includes(record.phase) || record.cancellation === "requested" || record.cancellation === "unconfirmed") throw new ConfigurationError("This issue has active or unresolved native execution. Confirm it is stopped before creating another operation.");
    if (!record.cwd) continue;
    const native = await context.gateway.inspect(record.agentId, { includeHistory: false });
    if (!native || native.id !== record.agentId) throw new ConfigurationError("The native session's idle state is unavailable. Confirm it is stopped before creating another operation.");
    if (native.active || native.pendingPermissionCount > 0) throw new ConfigurationError("The native session is still active or awaiting permission. Stop it and confirm it is idle before rerunning.");
  }
}

function prepare(context: ExperienceContext, source: RequestSource, operation: RerunRequest["operation"]): Promise<RerunPreview> {
  return exclusive(context, async () => {
    const scope = await scopeFor(context, source);
    const plan = await planForIssue(context, { issueId: scope.issueId });
    if (plan.projectId !== scope.projectId || plan.issueId !== scope.issueId) throw new ConfigurationError("The issue or project scope changed while preparing the request.");
    const existing = context.storage.requests().find((request) => request.serverUrl === context.config.serverUrl && request.sourceKey === scope.sourceKey && request.state === "prepared" && request.operation === operation);
    if (existing) await requestScope(context, existing);
    let reviewedScope: ContinuationScope | undefined;
    let continuationReview: RerunPreview["continuationReview"];
    if (operation === "continue") {
      if (!context.config.continuation?.enabled) throw new ConfigurationError("Enable reviewed continuation explicitly before preparing a continuation request.");
      const record = context.storage.get(scope.sourceKey);
      if (!record) throw new ConfigurationError("The original execution is unavailable.");
      await assertSourceCurrent(context, record);
      if (existing?.continuationScope) assertContinuationScope(record, existing.continuationScope);
      reviewedScope = existing?.continuationScope ?? continuationScope(record);
      continuationReview = { sourceAgentId: record.agentId, ...sourceFacts(record), expiresAt: reviewedScope.expiresAt,
        statement: "I reviewed the original task, system instructions and requirements. This is the same unrestricted task, not a smoke test, exact response, no-tools request, new requirements, or broader scope. Reuse only this native session for this task." };
    }
    await assertNoOutstanding(context, scope, existing?.id);
    const human = existing ? await deliveryActor(context, existing) : await requestActor(context);
    const delivery = existing?.delivery ?? (human ? "api" : "browser");
    const requestActorId = human?.id;
    const id = existing?.id ?? randomUUID();
    const body = existing?.body ?? bodyFor(scope, id, operation);
    const planDigest = digest(context, scope, plan, body, delivery, requestActorId, reviewedScope);
    const now = Date.now();
    const request: RerunRequest = { id, sourceKey: scope.sourceKey, source: scope.source, executionActorId: scope.actor.id, requestActorId, serverUrl: context.config.serverUrl, issueId: scope.issueId, projectId: scope.projectId, operation, state: "prepared", createdAt: existing?.createdAt ?? now, updatedAt: now, commentId: null, runId: null, body, planDigest, delivery, ...(reviewedScope ? { continuationScope: reviewedScope } : {}) };
    context.assertCurrent();
    await context.storage.putRequest(request);
    const disabled = !context.config.automatic || !context.config.projects[scope.projectId]?.automatic || context.runtime.paused || context.runtime.pendingConfiguration || !context.runtime.claiming || context.storage.paused();
    return { requestId: id, sourceKey: scope.sourceKey, operation, plan, planDigest, delivery, ...(continuationReview ? { continuationReview } : {}), warnings: [...(operation === "smoke" ? ["No-tools is instruction-only, not an enforced tool sandbox."] : []), ...(disabled ? ["Delivery is blocked until saved global and project automatic execution are enabled and claiming is resumed without a pending connection change."] : [])] };
  });
}

export function prepareRerun(context: ExperienceContext, input: { key: string; operation: "rerun" | "smoke" }): Promise<RerunPreview> {
  return prepare(context, { kind: "run", key: input.key }, input.operation);
}

export function prepareSmoke(context: ExperienceContext, input: { issueId: number }): Promise<RerunPreview> {
  return prepare(context, { kind: "issue", issueId: input.issueId }, "smoke");
}

export function prepareContinuation(context: ExperienceContext, input: { key: string }): Promise<RerunPreview> {
  return prepare(context, { kind: "run", key: input.key }, "continue");
}

async function reconcile(context: ExperienceContext, request: RerunRequest): Promise<RerunResult> {
  const scope = await requestScope(context, request);
  if (request.state === "failed") return result(request, "The request was rejected before delivery. Prepare a new operation after correcting the problem.");
  if (request.state === "dismissed") return result(request, "The untouched preview was discarded. No comment was submitted by this operation.");
  if (request.state === "prepared") return result(request, "This preview has not been handed off or submitted. Review its current plan before delivery.");
  let queue: { items: UpstreamRun[]; complete: boolean };
  let observed: UpstreamRun | undefined;
  try {
    queue = await context.protocol.queue();
    const matching = queue.items.filter((run) => matches(request, scope, run));
    if (matching.length > 1 || request.runId !== null && matching.some((run) => run.id !== request.runId)) {
      const unknown: RerunRequest = { ...request, state: "unknown", updatedAt: Date.now(), error: "Multiple upstream runs match this unique request. Never repost it." };
      await context.storage.putRequest(unknown);
      return result(unknown, "Multiple upstream runs match this unique request. Delivery requires manual review; do not post it again.");
    }
    observed = matching[0];
    if (!observed && request.runId !== null) {
      const run = await context.protocol.getRun(request.runId);
      if (run && matches(request, scope, run)) observed = run;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    const unknown: RerunRequest = { ...request, state: "unknown", updatedAt: Date.now(), error: "Queue reconciliation is unavailable. Never repost this request." };
    await context.storage.putRequest(unknown);
    return result(unknown, "Queue reconciliation is unavailable. No new comment was posted; absence of queue access is not proof of non-delivery.");
  }
  if (observed) {
    const submitted: RerunRequest = { ...request, state: "submitted", runId: observed.id, updatedAt: Date.now(), error: undefined };
    await context.storage.putRequest(submitted);
    return result(submitted, `Observed upstream run ${observed.id} in state ${observed.executionState}. Issue status was not changed.`);
  }
  const unknown: RerunRequest = { ...request, state: "unknown", updatedAt: Date.now(), error: "No matching upstream run is visible. Never repost this request." };
  await context.storage.putRequest(unknown);
  return result(unknown, queue.complete ? "No matching upstream run is visible. This is not proof that the comment was not delivered. Do not repost a pending or unknown request." : "Only a partial queue is visible and no matching run was found. Delivery remains unproven. Do not repost a pending or unknown request.");
}

export function submitRerun(context: ExperienceContext, input: { requestId: string; planDigest: string; attestContinuation?: boolean }): Promise<RerunResult> {
  return exclusive(context, async () => {
    let request = context.storage.request(input.requestId);
    if (!request) throw new ConfigurationError("The prepared request is missing.");
    if (request.state !== "prepared") return reconcile(context, request);
    const scope = await requestScope(context, request);
    const plan = await planForIssue(context, { issueId: request.issueId });
    const human = await deliveryActor(context, request);
    const currentDigest = !request.source && !request.executionActorId ? legacyDigest(context, scope, plan, request.body) : digest(context, scope, plan, request.body, request.delivery, human?.id, request.continuationScope);
    if (plan.projectId !== request.projectId || plan.issueId !== request.issueId || input.planDigest !== request.planDigest || currentDigest !== request.planDigest) throw new ConfigurationError("The execution plan or request scope changed. Prepare and review the current plan before submitting.");
    await assertNoOutstanding(context, scope, request.id);
    if (request.operation === "continue") {
      if (!context.config.continuation?.enabled || input.attestContinuation !== true || !request.continuationScope) throw new ConfigurationError("Continuation requires an explicit human review of this task's unchanged scope.");
      const record = context.storage.get(request.sourceKey);
      if (!record) throw new ConfigurationError("The original execution is unavailable.");
      await assertSourceCurrent(context, record);
      assertContinuationScope(record, request.continuationScope);
      request = { ...request, continuation: { ...request.continuationScope, requestId: request.id, approvedAt: Date.now(), attestation: "same-task-unrestricted" } };
    }
    context.assertCurrent();
    assertEnabled(context, scope);
    if (request.delivery === "browser") {
      const handedOff: RerunRequest = { ...request, state: "unknown", updatedAt: Date.now() };
      await context.storage.putRequest(handedOff);
      context.assertCurrent();
      assertEnabled(context, scope);
      return { ...result(handedOff, "The comment is handed off for human browser delivery, not posted or queued. Do not post it twice; reconcile after posting."), comment: request.body };
    }
    if (!human) throw new ConfigurationError("The pinned human delivery actor is unavailable.");
    const submitting: RerunRequest = { ...request, state: "submitting", updatedAt: Date.now() };
    await context.storage.putRequest(submitting);
    context.assertCurrent();
    assertEnabled(context, scope);
    let commentId: number;
    try {
      commentId = (await human.client.comment(request.issueId, request.body)).id;
    } catch (error) {
      const rejected = error instanceof RequestError && [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status);
      const next: RerunRequest = { ...submitting, state: rejected ? "failed" : "unknown", updatedAt: Date.now(), error: rejected ? "The server rejected the comment request." : "Comment delivery is uncertain. Never repost this request." };
      await context.storage.putRequest(next);
      return result(next, rejected ? "The server rejected the comment. No queued run has been observed." : "Comment delivery is uncertain. Reconcile this request; do not submit or post it again.");
    }
    const acknowledged: RerunRequest = { ...submitting, state: "unknown", commentId, updatedAt: Date.now() };
    await context.storage.putRequest(acknowledged);
    return reconcile(context, acknowledged);
  });
}

export function reconcileRerun(context: ExperienceContext, input: { requestId: string }): Promise<RerunResult> {
  return exclusive(context, async () => {
    const request = context.storage.request(input.requestId);
    if (!request) throw new ConfigurationError("The request is missing.");
    return reconcile(context, request);
  });
}

export function recoverHandoff(context: ExperienceContext, input: { requestId: string }): Promise<RerunResult & { comment: string; issueId: number; projectId: string }> {
  return exclusive(context, async () => {
    const request = context.storage.request(input.requestId);
    if (!request) throw new ConfigurationError("The browser handoff is missing.");
    await requestScope(context, request);
    if (request.delivery !== "browser" || (request.state !== "unknown" && request.state !== "submitted")) throw new ConfigurationError("Only a previously handed-off browser request can be recovered. Prepared, API, failed, and dismissed requests cannot expose a comment here.");
    const reconciled = await reconcile(context, request);
    const persisted = context.storage.request(request.id);
    if (!persisted || persisted.delivery !== "browser" || (persisted.state !== "unknown" && persisted.state !== "submitted")) throw new ConfigurationError("The persisted browser handoff is unavailable.");
    context.assertCurrent();
    return { ...reconciled, comment: persisted.body, issueId: persisted.issueId, projectId: persisted.projectId, message: `${reconciled.message} This is the exact existing browser handoff, not a new request. Do not post it twice.` };
  });
}

export function discardRerun(context: ExperienceContext, input: { requestId: string }): Promise<RerunResult> {
  return exclusive(context, async () => {
    const request = context.storage.request(input.requestId);
    if (!request || request.serverUrl !== context.config.serverUrl) throw new ConfigurationError("The prepared request is unavailable on this connection.");
    context.assertCurrent();
    if (request.state !== "prepared") return result(request, "This request was handed off, attempted, or resolved and cannot be discarded as an untouched preview.");
    const discarded: RerunRequest = { ...request, state: "dismissed", updatedAt: Date.now() };
    await context.storage.putRequest(discarded);
    return result(discarded, "Untouched preview discarded. No request was submitted.");
  });
}
