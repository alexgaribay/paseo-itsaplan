import { z } from "zod";
import { selectionSchema } from "./config";
import { continuationGrantSchema, continuationReviewSchema, continuationScopeSchema } from "./continuation";

export const selectionSourceSchema = z.enum(["manual", "issue", "field", "project", "global", "provider"]);
export const executionPlanSchema = z.object({
  issueId: z.number().int().positive().nullable(), issueIdentifier: z.string().nullable(), projectId: z.string(),
  hostId: z.string().nullable(), hostLabel: z.string().nullable(), repository: z.string(), workspaceId: z.string().nullable(),
  selection: selectionSchema,
  sources: z.object({ provider: selectionSourceSchema, model: selectionSourceSchema, mode: selectionSourceSchema }),
  worktree: z.boolean(), baseBranch: z.string(), defaultModelUnresolved: z.boolean(),
  noToolsEnforcement: z.literal("instruction-only"), warnings: z.array(z.string()),
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export const acceptanceContractSchema = z.object({ expectedOutput: z.string().min(1).max(10000), noTools: z.boolean() });
export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>;
export const taskIntentSchema = z.object({
  version: z.literal(1), source: z.enum(["issue", "comment", "task", "smoke"]), request: z.string(),
  projectId: z.string(), sourceRunId: z.number().int().positive(), requestId: z.string().uuid().optional(),
  acceptance: acceptanceContractSchema.optional(),
});
export type TaskIntent = z.infer<typeof taskIntentSchema>;
export const executionEvidenceSchema = z.object({ toolCallCount: z.number().int().nonnegative().nullable(), historyComplete: z.boolean() });
export type ExecutionEvidence = z.infer<typeof executionEvidenceSchema>;
export const acceptanceSchema = z.object({
  status: z.enum(["passed", "failed", "not-assessed"]), checkedAt: z.number(), enforcement: z.literal("instruction-only"),
  checks: z.array(z.object({ id: z.enum(["output", "no-tools"]), status: z.enum(["passed", "failed", "unknown"]), message: z.string() })),
});
export type Acceptance = z.infer<typeof acceptanceSchema>;
export const runtimeSchema = z.object({
  claiming: z.boolean(), paused: z.boolean(), active: z.number().int().nonnegative(), reservations: z.number().int().nonnegative(),
  pendingConfiguration: z.boolean(), lastPollAt: z.number().nullable(),
});
export type IntegrationRuntime = z.infer<typeof runtimeSchema>;
export const queueItemSchema = z.object({
  id: z.number().int().positive(), agentId: z.number().int().positive(), username: z.string(),
  projectId: z.string(), projectName: z.string(), issueId: z.number().int().positive().nullable(), issueIdentifier: z.string().nullable(),
  state: z.enum(["queued", "running", "success", "failed", "canceled"]), attempts: z.number().int().nonnegative(),
  createdAt: z.string(), dueAt: z.string(), configured: z.boolean(), automatic: z.boolean(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;
export const queuePreviewSchema = z.object({
  availability: z.enum(["available", "unavailable"]), complete: z.boolean(), checkedAt: z.number(), unfilteredClaims: z.literal(true),
  agentUsername: z.string().nullable(), items: z.array(queueItemSchema), queued: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
  warning: z.string().nullable(),
});
export type QueuePreview = z.infer<typeof queuePreviewSchema>;
export const readinessActionSchema = z.object({ kind: z.enum(["connection", "host", "execution", "projects", "project", "credentials", "agent"]), projectId: z.string().optional(), agentId: z.string().optional(), externalPath: z.string().optional() });
export const readinessCheckSchema = z.object({ id: z.string(), label: z.string(), state: z.enum(["pass", "warning", "fail", "unknown"]), message: z.string(), action: readinessActionSchema.optional() });
export const projectReadinessSchema = z.object({
  projectId: z.string(), name: z.string(), key: z.string(), automatic: z.boolean(), ready: z.boolean(),
  repository: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(), modeId: z.string().nullable(), problems: z.array(z.string()),
});
export const readinessSchema = z.object({ checkedAt: z.number(), ready: z.boolean(), checks: z.array(readinessCheckSchema), projects: z.array(projectReadinessSchema), queue: queuePreviewSchema });
export type Readiness = z.infer<typeof readinessSchema>;
export const rerunRequestSchema = z.object({
  id: z.string().uuid(), sourceKey: z.string(), serverUrl: z.string(), issueId: z.number().int().positive(), projectId: z.string(),
  operation: z.enum(["rerun", "smoke", "continue"]), state: z.enum(["prepared", "submitting", "submitted", "unknown", "failed", "dismissed"]),
  createdAt: z.number(), updatedAt: z.number(), commentId: z.number().int().positive().nullable(), runId: z.number().int().positive().nullable(),
  body: z.string(), planDigest: z.string(), error: z.string().optional(),
  delivery: z.enum(["api", "browser"]).default("browser"),
  requestActorId: z.string().min(1).optional(), executionActorId: z.string().min(1).optional(),
  continuationScope: continuationScopeSchema.optional(), continuation: continuationGrantSchema.optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run") }),
    z.object({ kind: z.literal("issue"), agentId: z.number().int().positive(), actorId: z.string().min(1), username: z.string().min(1) }),
  ]).optional(),
});
export type RerunRequest = z.infer<typeof rerunRequestSchema>;
export const rerunPreviewSchema = z.object({ requestId: z.string().uuid(), sourceKey: z.string(), operation: z.enum(["rerun", "smoke", "continue"]), plan: executionPlanSchema, planDigest: z.string(), delivery: z.enum(["api", "browser"]), warnings: z.array(z.string()), continuationReview: continuationReviewSchema.optional() });
export type RerunPreview = z.infer<typeof rerunPreviewSchema>;
export const rerunResultSchema = z.object({ requestId: z.string().uuid(), state: z.enum(["prepared", "submitted", "unknown", "failed", "dismissed"]), commentId: z.number().int().positive().nullable(), runId: z.number().int().positive().nullable(), message: z.string(), comment: z.string().optional() });
export type RerunResult = z.infer<typeof rerunResultSchema>;
export const diagnosticsSchema = z.object({ generatedAt: z.number(), text: z.string() });

export const executionObservationSchema = z.object({
  observedAt: z.number(),
  upstream: z.enum(["queued", "running", "success", "failed", "canceled", "unavailable", "not-found", "not-applicable"]),
  upstreamAttempt: z.number().int().nonnegative().nullable(),
  native: z.enum(["active", "idle", "archived", "unavailable"]),
  pendingPermissionCount: z.number().int().nonnegative().nullable(),
  delivery: z.enum(["delivered", "pending", "unknown", "not-applicable", "not-recorded"]),
  acceptance: z.enum(["passed", "failed", "not-assessed"]),
});
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;
export const executionReviewSchema = executionObservationSchema.extend({
  key: z.string(), fingerprint: z.string(), canMarkReviewed: z.boolean(),
  reviewedAt: z.number().nullable(), warnings: z.array(z.string()),
});
export type ExecutionReview = z.infer<typeof executionReviewSchema>;
