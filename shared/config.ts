import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { fieldBindingsSchema, taskContextOptionsSchema } from "./task-context";
import { continuationOptionsSchema } from "./continuation";

export const httpUrl = z.string().trim().refine((value) => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}, "Use HTTPS, or HTTP on loopback; no credentials, query, or fragment");
const optionalText = z.string().trim().default("");
export const selectionSchema = z.object({ provider: optionalText, model: optionalText, modeId: optionalText });
export type Selection = z.infer<typeof selectionSchema>;
export const milestoneSchema = z.enum(["turn-completed", "implementation-completed", "tests-passed", "pull-request-created", "ready-for-review", "issue-completed"]);
export type Milestone = z.infer<typeof milestoneSchema>;
export const projectMappingSchema = selectionSchema.extend({
  repository: z.string().default(""),
  workspaceId: optionalText,
  automatic: z.boolean().default(false),
  worktree: z.boolean().default(true),
  baseBranch: optionalText,
  statusPolicy: z.partialRecord(milestoneSchema, z.number().int().positive()).optional(),
  taskContext: taskContextOptionsSchema.optional(),
  fieldBindings: fieldBindingsSchema.optional(),
});
const connectionSchema = z.object({
  serverUrl: z.union([z.literal(""), httpUrl]).default("").transform((value) => value.replace(/\/+$/, "")),
  webUrl: z.union([z.literal(""), httpUrl]).default(""),
  automatic: z.boolean().default(false),
  defaultProvider: optionalText,
  defaultModel: optionalText,
  defaultModeId: optionalText,
  maxConcurrent: z.number().int().min(1).max(32).default(2),
  pollIntervalMs: z.number().int().min(1000).max(300000).default(3000),
  executionTimeoutMs: z.number().int().min(1000).max(86400000).default(1800000),
  // This is a local safety deadline, not a claim about the server's configurable lease.
  leaseSafetyMs: z.number().int().min(90000).max(180000).default(120000),
  projects: z.record(z.string(), projectMappingSchema).default({}),
  issueOverrides: z.record(z.string(), selectionSchema).default({}),
  chatProjects: z.record(z.string(), z.string()).default({}),
  statusPolicy: z.partialRecord(milestoneSchema, z.number().int().positive()).default({}),
  activityPrivacy: z.enum(["off", "metadata", "full"]).optional(),
  continuation: continuationOptionsSchema.optional(),
  mcp: z.object({
    enabled: z.boolean().default(false),
    url: z.union([z.literal(""), httpUrl]).default(""),
    providers: z.array(z.string()).default([]),
    preapprovedTools: z.array(z.string().min(1)).default([]),
  }).default({ enabled: false, url: "", providers: [], preapprovedTools: [] }),
  paseoConnectionMode: z.enum(["auto", "manual"]).default("auto"),
  paseoUrl: z.union([z.literal(""), z.string().refine((value) => {
    try { const url = new URL(value); return ["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search && url.pathname === "/ws"; }
    catch { return false; }
  })]).default(""),
}).superRefine((values, context) => {
  if (values.paseoConnectionMode === "manual" && !values.paseoUrl) context.addIssue({ code: "custom", path: ["paseoUrl"], message: "Enter a WebSocket URL for the manual connection override." });
});
export const configSchema = z.preprocess((input) => {
  if (input && typeof input === "object" && !("paseoConnectionMode" in input) && "paseoUrl" in input) {
    const url = input.paseoUrl;
    if (typeof url === "string" && url && url !== "ws://127.0.0.1:6767/ws" && url !== "ws://localhost:6767/ws") return { ...input, paseoConnectionMode: "manual" };
  }
  return input;
}, connectionSchema);
export type Config = z.infer<typeof configSchema>;
export type ProjectMapping = z.infer<typeof projectMappingSchema>;
export const preferences = defineSettings({ id: "connection", scope: "host", version: 1, schema: configSchema });
export const defaults = (): Config => configSchema.parse({});
