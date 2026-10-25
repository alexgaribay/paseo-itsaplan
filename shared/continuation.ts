import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const continuationOptionsSchema = z.object({ enabled: z.boolean().default(false) });
export const taskProvenanceSchema = z.object({
  version: z.literal(1), actorId: z.string().min(1), capturedAt: z.number(),
  taskDigest: digest, systemDigest: digest, requirementsDigest: digest, configDigest: digest,
  restrictions: z.array(z.string()),
});
export type TaskProvenance = z.infer<typeof taskProvenanceSchema>;
export const continuationScopeSchema = z.object({
  sourceKey: z.string().min(1), sourceAgentId: z.string().min(1), sourceDigest: digest,
  taskDigest: digest, systemDigest: digest, requirementsDigest: digest, configDigest: digest,
  executionActorId: z.string().min(1), expiresAt: z.number(),
});
export type ContinuationScope = z.infer<typeof continuationScopeSchema>;
export const continuationGrantSchema = continuationScopeSchema.extend({
  requestId: z.string().uuid(), approvedAt: z.number(), attestation: z.literal("same-task-unrestricted"),
});
export type ContinuationGrant = z.infer<typeof continuationGrantSchema>;
export const continuationReviewSchema = z.object({
  sourceAgentId: z.string(), task: z.string(), systemPrompt: z.string(), requirements: z.string(),
  expiresAt: z.number(), statement: z.string(),
});
export type ContinuationReview = z.infer<typeof continuationReviewSchema>;
