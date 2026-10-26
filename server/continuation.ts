import { createHash } from "node:crypto";
import type { Config } from "../shared/config";
import type { ContinuationGrant, ContinuationScope, TaskProvenance } from "../shared/continuation";
import type { TaskIntent } from "../shared/experience";
import type { Issue, SessionRecord } from "../shared/models";
import type { PersistedTaskContext, TaskContextSnapshot } from "../shared/task-context";
import type { ExperienceContext } from "./experience";
import type { SessionSnapshot } from "./contracts";
import { ConfigurationError } from "./errors";
import { executionPreferences } from "./plan";
import { knownTaskRestrictions } from "./task";
import { resolveProject } from "./projects";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function factDigest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function executionConfigDigest(config: Config, projectId: string, issueId: number): string {
  return factDigest({ serverUrl: config.serverUrl, host: [config.paseoConnectionMode, config.paseoUrl], defaults: [config.defaultProvider, config.defaultModel, config.defaultModeId], project: config.projects[projectId], issue: config.issueOverrides[String(issueId)], mcp: config.mcp, execution: { timeoutMs: config.executionTimeoutMs, leaseSafetyMs: config.leaseSafetyMs, activityPrivacy: config.activityPrivacy ?? "off" } });
}
export function taskRequirements(issue: Issue, context?: PersistedTaskContext): string {
  return canonical({ id: issue.id, projectId: issue.projectId, identifier: issue.identifier, title: issue.title, description: issue.description ?? "", context: context ? { text: context.text, warnings: context.warnings, digest: context.digest, assets: context.assets.map(({ id, filename, mimeType, digest }) => ({ id, filename, mimeType, digest })) } : undefined });
}
function reviewRequirements(issue: Issue, context?: PersistedTaskContext): string {
  return [
    `${issue.identifier} — ${issue.title}`,
    issue.description ?? "",
    ...(context ? [
      context.text,
      ...(context.warnings.length ? ["Captured context warnings:", ...context.warnings] : []),
      ...(context.assets.length ? ["Captured images (review their contents in the original Paseo session):", ...context.assets.map((asset) => `${asset.filename} · ${asset.mimeType} · SHA-256 ${asset.digest}`)] : []),
    ] : []),
  ].filter(Boolean).join("\n\n");
}
export function contextRequirementsDigest(context: PersistedTaskContext | TaskContextSnapshot): string {
  return factDigest({ issueId: context.issueId, projectId: context.projectId, text: context.text, warnings: context.warnings, assets: context.assets.map(({ id, filename, mimeType, digest }) => ({ id, filename, mimeType, digest })) });
}
export function intentDigest(intent: TaskIntent): string {
  return factDigest({ source: intent.source, request: intent.request, projectId: intent.projectId, sourceRunId: intent.sourceRunId, acceptance: intent.acceptance });
}
export function captureProvenance(config: Config, actorId: string, intent: TaskIntent, systemPrompt: string, issue: Issue, context?: PersistedTaskContext): TaskProvenance {
  const requirements = taskRequirements(issue, context);
  return { version: 1, actorId, capturedAt: Date.now(), taskDigest: intentDigest(intent), systemDigest: factDigest(systemPrompt), requirementsDigest: factDigest(requirements), configDigest: executionConfigDigest(config, String(issue.projectId), issue.id), restrictions: knownTaskRestrictions({ request: intent.request, systemPrompt, requirements: reviewRequirements(issue, context), source: intent.source, acceptance: intent.acceptance }) };
}
export function sourceFacts(record: SessionRecord): { task: string; systemPrompt: string; requirements: string } {
  const provenance = record.taskProvenance;
  if (!provenance || !record.intent || !record.taskIssue || record.task?.kind !== "run" || record.kind !== "run" || !record.plan || !record.projectMapping || !record.issueId || !record.agentId || !record.cwd || !record.provider || !record.model || record.modeId === undefined || !record.nativeLastUserMessageAt || record.phase !== "finished" || record.result?.status !== "success" || record.cancellation || !record.evidence?.historyComplete || record.acceptance?.status === "failed") {
    throw new ConfigurationError("This execution has missing, restricted, failed, or uncertain source facts. Start a fresh session.");
  }
  const requirements = taskRequirements(record.taskIssue, record.taskContext);
  const systemPrompt = record.task.run.systemPrompt;
  const readable = reviewRequirements(record.taskIssue, record.taskContext);
  const restrictions = knownTaskRestrictions({ request: record.intent.request, systemPrompt, requirements: readable, source: record.intent.source, acceptance: record.intent.acceptance });
  if (restrictions.length || provenance.restrictions.length || provenance.taskDigest !== intentDigest(record.intent) || provenance.systemDigest !== factDigest(systemPrompt) || provenance.requirementsDigest !== factDigest(requirements) || record.taskIssue.id !== record.issueId || String(record.taskIssue.projectId) !== record.projectId) {
    throw new ConfigurationError("The original task restrictions or immutable source facts do not permit this operation. Start a fresh session.");
  }
  return { task: record.intent.request, systemPrompt, requirements: readable };
}
export function sourceFactsDigest(record: SessionRecord): string {
  sourceFacts(record);
  return factDigest({ key: record.key, serverUrl: record.serverUrl, task: record.task, intent: record.intent, provenance: record.taskProvenance, issue: record.taskIssue, context: record.taskContext, plan: record.plan, project: record.projectMapping, agentId: record.agentId, workspaceId: record.workspaceId, cwd: record.cwd, branchName: record.branchName, limits: record.limits, provider: record.provider, model: record.model, modeId: record.modeId, nativeLastUserMessageAt: record.nativeLastUserMessageAt, result: record.result, evidence: record.evidence, acceptance: record.acceptance, createdAt: record.createdAt });
}
export function assertSourceNative(record: SessionRecord, native: SessionSnapshot | null): asserts native is SessionSnapshot {
  if (!native || native.id !== record.agentId || native.archived || native.active || native.error || native.pendingPermissionCount !== 0 || native.cwd !== record.cwd || native.workspaceId !== record.workspaceId || native.provider !== record.provider || native.model !== record.model || native.modeId !== record.modeId || !native.lastUserMessageAt || native.lastUserMessageAt !== record.nativeLastUserMessageAt) {
    throw new ConfigurationError("The reviewed native session is missing, busy, changed, archived, or its original turn cannot be verified. It was not interrupted.");
  }
}
export async function assertSourceCurrent(context: ExperienceContext, record: SessionRecord): Promise<void> {
  sourceFacts(record);
  const run = record.task?.kind === "run" ? record.task.run : undefined;
  const initial = sourceFactsDigest(record);
  const actor = await context.protocol.identity();
  const issue = await context.protocol.issue(record.issueId!);
  const upstream = await context.protocol.getRun(record.externalId);
  const original = record.intent!.sourceRunId === record.externalId ? upstream : await context.protocol.getRun(record.intent!.sourceRunId);
  const originalMatches = original && original.issueId === record.issueId && original.projectId === record.projectId && original.username === actor.username && original.agentId === upstream?.agentId &&
    (record.intent!.source === "issue" ? original.trigger === "delegation" : original.prompt === record.intent!.request && (record.intent!.source === "comment" ? original.trigger === "mention" : original.trigger !== "delegation" && original.trigger !== "mention"));
  const project = context.config.projects[record.projectId];
  if (!project || record.serverUrl !== context.config.serverUrl || !actor.isAgent || actor.id !== record.taskProvenance!.actorId || !upstream || !originalMatches || upstream.trigger !== run?.trigger || upstream.executionState !== "success" || upstream.status !== "success" || upstream.attempts !== record.attempt || upstream.issueId !== record.issueId || upstream.projectId !== record.projectId || upstream.username !== actor.username || factDigest(taskRequirements(issue, record.taskContext)) !== record.taskProvenance!.requirementsDigest || executionConfigDigest(context.config, record.projectId, record.issueId!) !== record.taskProvenance!.configDigest) {
    throw new ConfigurationError("The source actor, requirements, configuration, or authoritative outcome changed. Start a fresh session.");
  }
  const resolvedProject = await resolveProject(context.config, context.protocol, context.gateway, record.projectId);
  if (resolvedProject.repository !== record.projectMapping!.repository || resolvedProject.workspaceId !== record.projectMapping!.workspaceId) throw new ConfigurationError("The source repository mapping changed. Start a fresh session.");
  const preferences = await executionPreferences(context.protocol, context.config, resolvedProject, issue);
  const selection = await context.gateway.select(context.config, resolvedProject, preferences.selection);
  if (factDigest(selection) !== factDigest(record.plan!.selection)) throw new ConfigurationError("The source execution selection changed. Start a fresh session.");
  if (record.taskContext) {
    const currentContext = await context.protocol.context(issue, resolvedProject);
    if (contextRequirementsDigest(currentContext) !== contextRequirementsDigest(record.taskContext)) throw new ConfigurationError("The source's optional requirements or attachment content changed or could not be verified.");
  }
  const latestActor = await context.protocol.identity();
  const latestIssue = await context.protocol.issue(record.issueId!);
  const native = await context.gateway.inspect(record.agentId, { includeHistory: false });
  context.assertCurrent();
  const persisted = context.storage.get(record.key);
  if (!persisted || initial !== sourceFactsDigest(persisted) || latestActor.id !== actor.id || !latestActor.isAgent || factDigest(taskRequirements(latestIssue, record.taskContext)) !== record.taskProvenance!.requirementsDigest || executionConfigDigest(context.config, record.projectId, record.issueId!) !== record.taskProvenance!.configDigest) throw new ConfigurationError("The source execution changed during review.");
  assertSourceNative(record, native);
}
export function continuationScope(record: SessionRecord, expiresAt = Date.now() + 30 * 60_000): ContinuationScope {
  const sourceDigest = sourceFactsDigest(record);
  const facts = record.taskProvenance!;
  return { sourceKey: record.key, sourceAgentId: record.agentId, sourceDigest, taskDigest: facts.taskDigest, systemDigest: facts.systemDigest, requirementsDigest: facts.requirementsDigest, configDigest: facts.configDigest, executionActorId: facts.actorId, expiresAt };
}
export function assertContinuationScope(record: SessionRecord, scope: ContinuationScope, now = Date.now()): void {
  const current = continuationScope(record, scope.expiresAt);
  const observed = { sourceKey: scope.sourceKey, sourceAgentId: scope.sourceAgentId, sourceDigest: scope.sourceDigest, taskDigest: scope.taskDigest, systemDigest: scope.systemDigest, requirementsDigest: scope.requirementsDigest, configDigest: scope.configDigest, executionActorId: scope.executionActorId, expiresAt: scope.expiresAt };
  if (scope.expiresAt <= now || factDigest(current) !== factDigest(observed)) throw new ConfigurationError("The continuation approval expired or its source facts changed. No session was resumed.");
}
export function assertContinuationGrant(record: SessionRecord, grant: ContinuationGrant, requestId: string, now = Date.now()): void {
  assertContinuationScope(record, grant, now);
  if (grant.requestId !== requestId || grant.attestation !== "same-task-unrestricted" || grant.approvedAt > now || grant.approvedAt >= grant.expiresAt) throw new ConfigurationError("The continuation has no valid human scope attestation.");
}
