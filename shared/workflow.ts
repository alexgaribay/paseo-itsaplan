import { z } from "zod";

export const workflowOptionsSchema = z.object({
  mode: z.enum(["automatic", "review"]).default("automatic"),
  targetBranch: z.string().trim().min(1).default("main"),
  remote: z.string().trim().min(1).default("origin"),
  checks: z.array(z.array(z.string().min(1)).min(1)).max(30).default([]),
  inProgressColumnId: z.number().int().positive().optional(),
  doneColumnId: z.number().int().positive().optional(),
});
export type WorkflowOptions = z.infer<typeof workflowOptionsSchema>;

export const workflowColumnSchema = z.object({
  id: z.number().int().positive(), projectId: z.number().int().positive(), name: z.string(),
  stateType: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]), position: z.number(),
});
export type WorkflowColumn = z.infer<typeof workflowColumnSchema>;

const commit = z.string().regex(/^[0-9a-f]{40,64}$/);
export const workflowCheckSchema = z.object({
  command: z.array(z.string()), commit, exitCode: z.literal(0), directory: z.string().optional(),
});
export type WorkflowCheck = z.infer<typeof workflowCheckSchema>;
export const workflowNoticeSchema = z.object({
  kind: z.enum(["started", "completed", "blocked"]), body: z.string(),
  state: z.enum(["submitting", "delivered", "unknown"]), commentId: z.number().int().positive().optional(),
});
export type WorkflowNotice = z.infer<typeof workflowNoticeSchema>;
export const workflowStateSchema = z.object({
  version: z.literal(1), options: workflowOptionsSchema,
  stage: z.enum(["starting", "running", "validating", "committing", "integrating", "publishing", "published", "completing", "completed", "blocked", "uncertain"]),
  inProgressColumnId: z.number().int().positive(), doneColumnId: z.number().int().positive(),
  actorId: z.string().min(1).optional(),
  operationKey: z.string().min(1).optional(),
  ownership: z.object({ repository: z.string(), cwd: z.string(), commonDirectory: z.string(), branchName: z.string() }).optional(),
  taskBefore: commit.optional(), taskTree: commit.optional(),
  remoteIdentity: z.string().optional(), targetBefore: commit.optional(), taskCommit: commit.optional(),
  remoteBefore: commit.nullable().optional(),
  integratedCommit: commit.optional(), checks: z.array(workflowCheckSchema).default([]),
  publishedAt: z.number().optional(), error: z.string().optional(), notices: z.array(workflowNoticeSchema).default([]),
});
export type WorkflowState = z.infer<typeof workflowStateSchema>;

export interface GitWorkflowInput {
  key: string;
  repository: string;
  cwd: string;
  branchName: string;
  issueIdentifier: string;
  workflow: WorkflowState;
  signal: AbortSignal;
  checkpoint(workflow: WorkflowState): Promise<void>;
  assertAuthorized(): Promise<void>;
}
