// Protocol data adapted from @itsaplan/runner src/client.ts and src/agui.ts.
// Copyright 2026 Andrii Poluosmak. Apache-2.0; revision in THIRD_PARTY.md.
import { z } from "zod";
import { projectMappingSchema } from "./config";
import { acceptanceSchema, executionEvidenceSchema, executionObservationSchema, executionPlanSchema, taskIntentSchema } from "./experience";
export const runSchema = z.object({
  id: z.number().int().positive(), attempts: z.number().int().positive(), traceEvents: z.boolean().optional(),
  trigger: z.enum(["mention", "delegation", "field", "schedule", "manual", "status", "event"]),
  prompt: z.string(), systemPrompt: z.string(), issueId: z.number().int().positive().nullable(), issueIdentifier: z.string().nullable(),
});
export const chatSchema = z.object({ id: z.number().int().positive(), attempts: z.number().int().positive().optional(), threadId: z.string().min(1), prompt: z.string(), systemPrompt: z.string(), sessionId: z.string().nullable() });
export type Run = z.infer<typeof runSchema>;
export type ChatMessage = z.infer<typeof chatSchema>;
export type Task = { kind: "run"; run: Run } | { kind: "chat"; message: ChatMessage };
export const usageSchema = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() });
export type Usage = z.infer<typeof usageSchema>;
export const resultSchema = z.object({ status: z.enum(["success", "failed"]), output: z.string().optional(), error: z.string().optional(), usage: usageSchema.nullable().optional() });
export type Result = z.infer<typeof resultSchema>;
export type AgUiEvent =
  | { type: "RUN_STARTED" | "RUN_FINISHED"; threadId: string; runId: string }
  | { type: "RUN_ERROR"; message: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string };
export const eventSchema = z.union([
  z.object({ type: z.enum(["RUN_STARTED", "RUN_FINISHED"]), threadId: z.string(), runId: z.string() }),
  z.object({ type: z.literal("RUN_ERROR"), message: z.string() }),
  z.object({ type: z.literal("TEXT_MESSAGE_START"), messageId: z.string(), role: z.literal("assistant") }),
  z.object({ type: z.literal("TEXT_MESSAGE_CONTENT"), messageId: z.string(), delta: z.string() }),
  z.object({ type: z.literal("TEXT_MESSAGE_END"), messageId: z.string() }),
]);
export const issueSchema = z.object({ id: z.number().int().positive(), projectId: z.number().int().positive(), identifier: z.string(), title: z.string(), description: z.string().nullable().optional(), columnId: z.number().nullable().optional() });
export type Issue = z.infer<typeof issueSchema>;
export const linkedRepositorySchema = z.object({ id: z.number().int().positive(), provider: z.string(), fullName: z.string(), webUrl: z.string() });
export type LinkedRepository = z.infer<typeof linkedRepositorySchema>;
export const repositoryCandidateSchema = z.object({ paseoProjectId: z.string(), name: z.string(), repository: z.string() });
export type RepositoryCandidate = z.infer<typeof repositoryCandidateSchema>;
export const repositoryMatchSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("matched"), candidate: repositoryCandidateSchema }),
  z.object({ status: z.literal("ambiguous"), candidates: z.array(repositoryCandidateSchema).min(2) }),
  z.object({ status: z.literal("unmatched"), reason: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type RepositoryMatch = z.infer<typeof repositoryMatchSchema>;
export const projectSchema = z.object({ id: z.number().int().positive(), key: z.string(), name: z.string(), repositoryMatch: repositoryMatchSchema.optional() });
export type Project = z.infer<typeof projectSchema>;
export const sessionSchema = z.object({
  key: z.string(), kind: z.enum(["run", "chat", "manual"]), externalId: z.number(), attempt: z.number(),
  serverUrl: z.string(),
  issueId: z.number().nullable(), issueIdentifier: z.string().nullable(), projectId: z.string(),
  agentId: z.string(), workspaceId: z.string().nullable(), cwd: z.string(), provider: z.string(),
  phase: z.enum(["preparing", "created", "sending", "running", "stopping", "reporting", "finished", "canceled", "lease-lost", "uncertain"]),
  createdAt: z.number(), updatedAt: z.number(), eventOffset: z.number().int().nonnegative().default(0),
  pendingEvents: z.array(eventSchema).optional(),
  result: resultSchema.optional(), error: z.string().optional(), task: z.union([z.object({ kind: z.literal("run"), run: runSchema }), z.object({ kind: z.literal("chat"), message: chatSchema })]).optional(),
  projectMapping: projectMappingSchema.optional(),
  model: z.string().nullable().optional(), modeId: z.string().nullable().optional(), pendingPermissionCount: z.number().int().nonnegative().optional(),
  lastHeartbeatAt: z.number().nullable().optional(), cancellation: z.enum(["requested", "confirmed", "unconfirmed"]).optional(),
  plan: executionPlanSchema.optional(), intent: taskIntentSchema.optional(), evidence: executionEvidenceSchema.optional(), acceptance: acceptanceSchema.optional(),
  limits: z.object({ executionTimeoutMs: z.number().positive(), leaseSafetyMs: z.number().positive() }).optional(),
  review: z.object({ reviewedAt: z.number(), fingerprint: z.string(), observation: executionObservationSchema }).optional(),
});
export type SessionRecord = z.infer<typeof sessionSchema>;
export const providerSchema = z.object({ id: z.string(), available: z.boolean(), error: z.string().nullable().optional(), models: z.array(z.object({ id: z.string(), name: z.string() })), modes: z.array(z.object({ id: z.string(), name: z.string() })) });
export type Provider = z.infer<typeof providerSchema>;
