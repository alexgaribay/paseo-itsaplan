import type { RerunRequest } from "../shared/experience";
import type { SessionRecord } from "../shared/models";
import type { ExperienceContext } from "./experience";

export interface DiagnosticsStatus {
  state: string;
  credentialPresent: boolean;
  mcpCredentialPresent: boolean;
  passwordPresent: boolean;
  requestCredentialPresent: boolean;
  sessions: readonly Pick<SessionRecord, "key" | "kind" | "externalId" | "attempt" | "issueId" | "projectId" | "agentId" | "workspaceId" | "provider" | "model" | "modeId" | "phase" | "createdAt" | "updatedAt" | "pendingPermissionCount" | "lastHeartbeatAt" | "cancellation" | "result" | "evidence" | "acceptance">[];
  requests?: readonly Pick<RerunRequest, "id" | "issueId" | "projectId" | "operation" | "state" | "createdAt" | "updatedAt" | "commentId" | "runId">[];
}

export async function diagnostics(context: Pick<ExperienceContext, "config" | "runtime" | "storage">, status: DiagnosticsStatus): Promise<{ generatedAt: number; text: string }> {
  const generatedAt = Date.now();
  const runtime = context.runtime;
  const protectedValues = Object.values(await context.storage.secrets()).filter((value): value is string => Boolean(value));
  const identifier = (value: string | null | undefined): string | null =>
    value && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) && !value.includes("://") && !value.includes("..") && !/^[A-Za-z]:[/\\]/.test(value) && !protectedValues.some((secret) => value.includes(secret)) ? value : null;
  const bundle = {
    version: 1,
    generatedAt,
    state: ["initializing", "recovering", "configuration-error", "unconfigured", "idle", "connecting", "connected", "ready", "authentication-error", "offline", "storage-error", "cancellation-error", "paused", "draining", "stopping", "stopped", "error"].includes(status.state) ? status.state : "unknown",
    credentials: { execution: status.credentialPresent, mcp: status.mcpCredentialPresent, paseoPassword: status.passwordPresent, humanRequest: status.requestCredentialPresent },
    runtime: { claiming: runtime.claiming, paused: runtime.paused, active: runtime.active, reservations: runtime.reservations, pendingConfiguration: runtime.pendingConfiguration, lastPollAt: runtime.lastPollAt },
    configuration: {
      automatic: context.config.automatic, maxConcurrent: context.config.maxConcurrent, pollIntervalMs: context.config.pollIntervalMs,
      executionTimeoutMs: context.config.executionTimeoutMs, mcpEnabled: context.config.mcp.enabled,
      provider: identifier(context.config.defaultProvider), model: identifier(context.config.defaultModel), modeId: identifier(context.config.defaultModeId),
      projects: Object.entries(context.config.projects).map(([id, project]) => ({ id: identifier(id), automatic: project.automatic, repositoryConfigured: !!project.repository, workspaceConfigured: !!project.workspaceId, worktree: project.worktree, provider: identifier(project.provider), model: identifier(project.model), modeId: identifier(project.modeId) })),
    },
    sessions: status.sessions.map((session) => ({
      kind: session.kind, externalId: session.externalId, attempt: session.attempt, issueId: session.issueId,
      projectId: identifier(session.projectId), agentId: identifier(session.agentId), workspaceId: identifier(session.workspaceId),
      provider: identifier(session.provider), model: identifier(session.model), modeId: identifier(session.modeId), phase: session.phase,
      createdAt: session.createdAt, updatedAt: session.updatedAt, eventOffset: context.storage.get(session.key)?.eventOffset ?? null,
      pendingPermissionCount: session.pendingPermissionCount ?? null, lastHeartbeatAt: session.lastHeartbeatAt ?? null, cancellation: session.cancellation ?? null,
      result: session.result ? { status: session.result.status, outputPresent: session.result.output !== undefined, errorPresent: session.result.error !== undefined, inputTokens: session.result.usage?.inputTokens ?? null, outputTokens: session.result.usage?.outputTokens ?? null } : null,
      evidence: session.evidence ? { toolCallCount: session.evidence.toolCallCount, historyComplete: session.evidence.historyComplete } : null,
      acceptance: session.acceptance ? { status: session.acceptance.status, checkedAt: session.acceptance.checkedAt, enforcement: session.acceptance.enforcement, checks: session.acceptance.checks.map((check) => ({ id: check.id, status: check.status })) } : null,
    })),
    requests: (status.requests ?? context.storage.requests()).map((request) => ({ id: identifier(request.id), issueId: request.issueId, projectId: identifier(request.projectId), operation: request.operation, state: request.state, createdAt: request.createdAt, updatedAt: request.updatedAt, commentId: request.commentId, runId: request.runId })),
  };
  return { generatedAt, text: JSON.stringify(bundle, null, 2) };
}
