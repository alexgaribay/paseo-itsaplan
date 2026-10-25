import { createHash } from "node:crypto";
import type { ExecutionObservation, ExecutionReview } from "../shared/experience";
import type { SessionRecord } from "../shared/models";
import type { SessionSnapshot } from "./contracts";
import { ConfigurationError } from "./errors";
import type { ExperienceContext } from "./experience";

const terminal = new Set(["success", "failed", "canceled"]);
const historical = new Set<SessionRecord["phase"]>(["uncertain", "lease-lost", "canceled", "finished"]);

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function localState({ review: _review, ...record }: SessionRecord): string {
  return hash(record);
}

function delivery(record: SessionRecord): ExecutionObservation["delivery"] {
  if (record.kind === "manual") return "not-applicable";
  if (record.phase === "uncertain" || record.phase === "lease-lost") return "unknown";
  if (!record.result) return "not-recorded";
  if (record.phase === "finished") return "delivered";
  return record.phase === "reporting" ? "pending" : "unknown";
}

async function nativeObservation(context: ExperienceContext, record: SessionRecord): Promise<SessionSnapshot | null> {
  try {
    const found = await context.gateway.inspect(record.agentId, { includeHistory: false });
    return found?.id === record.agentId ? found : null;
  } catch { return null; }
}

async function upstreamObservation(context: ExperienceContext, record: SessionRecord) {
  const unavailable = {
    state: (record.kind === "manual" ? "not-applicable" : "unavailable") as ExecutionObservation["upstream"],
    attempt: null as number | null, terminal: false, scope: null as unknown, warnings: [] as string[],
  };
  if (record.kind !== "run") return unavailable;
  try {
    const identity = await context.protocol.identity();
    if (!identity.isAgent) return unavailable;
    const agent = await context.protocol.agent();
    if (!agent || agent.kind !== "external" || agent.invocationUrl || (identity.username && agent.username.toLowerCase() !== identity.username.toLowerCase())) {
      return { ...unavailable, warnings: ["The authenticated external polling agent could not be verified. Check agent metadata access and configuration before acknowledging this record."] };
    }
    const username = agent.username;
    const run = await context.protocol.getRun(record.externalId);
    if (!run) return { ...unavailable, state: "not-found" as const };
    if (run.id !== record.externalId || run.agentId !== agent.id || run.issueId !== record.issueId || run.projectId !== record.projectId || run.username.toLowerCase() !== username.toLowerCase()) {
      return { ...unavailable, warnings: ["The upstream run does not match this execution's agent, issue, or project; its outcome is not attributed here."] };
    }
    return {
      state: run.executionState, attempt: run.attempts,
      terminal: terminal.has(run.executionState) && run.status === run.executionState,
      scope: { actor: identity.id, agentId: run.agentId, issueId: run.issueId, projectId: run.projectId, status: run.status },
      warnings: [] as string[],
    };
  } catch {
    return { ...unavailable, warnings: ["Upstream execution state could not be verified. Queue access or authentication may need attention."] };
  }
}

async function observe(context: ExperienceContext, key: string) {
  context.assertCurrent();
  const record = context.storage.get(key);
  if (!record) throw new ConfigurationError("The execution association is missing.");
  if (record.serverUrl !== context.config.serverUrl) throw new ConfigurationError("Restore this execution's It's a Plan connection before reviewing it.");
  const token = localState(record);
  const [snapshot, upstream] = await Promise.all([nativeObservation(context, record), upstreamObservation(context, record)]);
  context.assertCurrent();
  const nativeState: ExecutionObservation["native"] = !snapshot ? "unavailable" : snapshot.active ? "active" : snapshot.archived ? "archived" : "idle";
  const observation: ExecutionObservation = {
    observedAt: Date.now(), upstream: upstream.state, upstreamAttempt: upstream.attempt, native: nativeState,
    pendingPermissionCount: snapshot?.pendingPermissionCount ?? null,
    delivery: delivery(record), acceptance: record.acceptance?.status ?? "not-assessed",
  };
  const warnings = [...upstream.warnings];
  if (!snapshot) warnings.push("Native state is unavailable; this is not confirmation that the agent stopped.");
  if (snapshot?.active || (snapshot?.pendingPermissionCount ?? 0) > 0) warnings.push("The native session is active or awaiting approval. Open it in Paseo before reviewing this discrepancy.");
  if (upstream.attempt !== null && upstream.attempt !== record.attempt) warnings.push("The upstream execution attempt differs from this historical association.");
  if (record.cancellation === "unconfirmed") warnings.push("Cancellation remains unconfirmed. Reviewing cannot clear the stop fence.");
  if (observation.delivery === "unknown") warnings.push("An upstream terminal outcome does not prove that this plugin's result acknowledgment was received.");
  const fingerprint = hash({ local: token, scope: upstream.scope, ...observation, observedAt: undefined });
  const review: ExecutionReview = {
    ...observation, key, fingerprint,
    canMarkReviewed: record.kind === "run" && historical.has(record.phase) && upstream.terminal && upstream.attempt === record.attempt &&
      snapshot !== null && !snapshot.active && snapshot.pendingPermissionCount === 0 && record.cancellation !== "unconfirmed" && !context.runtime.pendingConfiguration,
    reviewedAt: record.review?.fingerprint === fingerprint ? record.review.reviewedAt : null,
    warnings,
  };
  return { record, token, review };
}

export async function reviewExecution(context: ExperienceContext, input: { key: string }): Promise<ExecutionReview> {
  return (await observe(context, input.key)).review;
}

export async function markExecutionReviewed(context: ExperienceContext, input: { key: string; fingerprint: string }): Promise<ExecutionReview> {
  const { record, token, review } = await observe(context, input.key);
  if (review.fingerprint !== input.fingerprint) throw new ConfigurationError("Execution state changed. Refresh the comparison before marking it reviewed.");
  if (!review.canMarkReviewed) throw new ConfigurationError("A matching terminal upstream attempt and positively idle or archived native session are required. Existing cancellation and delivery state are preserved.");
  if (review.reviewedAt !== null) return review;
  const { key: _key, fingerprint: _fingerprint, canMarkReviewed: _allowed, reviewedAt: _at, warnings: _warnings, ...observation } = review;
  const reviewedAt = Date.now();
  await context.storage.update(record.key, (current) => {
    context.assertCurrent();
    if (localState(current) !== token) throw new ConfigurationError("The local execution changed while saving the review; refresh it first.");
    return { ...current, review: { reviewedAt, fingerprint: review.fingerprint, observation } };
  });
  return { ...review, reviewedAt };
}
