import { z } from "zod";

export const taskContextOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  checklists: z.boolean().default(false),
  relations: z.boolean().default(false),
  documents: z.boolean().default(false),
  attachments: z.boolean().default(false),
  development: z.boolean().default(false),
});
export type TaskContextOptions = z.infer<typeof taskContextOptionsSchema>;
export const contextLimits = { chars: 48_000, responseBytes: 8_000_000, assets: 6, assetBytes: 2_000_000, totalAssetBytes: 6_000_000, documents: 8, relations: 30, timeoutMs: 30_000 } as const;
export const fieldBindingSchema = z.object({
  projectId: z.number().int().positive(), issueTypeId: z.number().int().positive().nullable(),
  fieldId: z.number().int().positive(), optionId: z.number().int().positive(),
  provider: z.string().trim().min(1).max(200), model: z.string().trim().max(300).default(""),
});
export type FieldBinding = z.infer<typeof fieldBindingSchema>;
export const fieldBindingsSchema = z.array(fieldBindingSchema).max(100).superRefine((bindings, context) => {
  const ids = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    const key = `${binding.projectId}/${binding.issueTypeId}/${binding.fieldId}/${binding.optionId}`;
    if (ids.has(key)) context.addIssue({ code: "custom", path: [index], message: "Map each field option only once." });
    ids.add(key);
  }
});
export const customFieldSchema = z.object({
  id: z.number().int().positive(), issueTypeId: z.number().int().positive().nullable(), name: z.string().max(500),
  fieldType: z.string().max(100), options: z.array(z.object({ id: z.number().int().positive(), value: z.string().max(500) })).max(1000),
});
export type CustomField = z.infer<typeof customFieldSchema>;
export const developmentSchema = z.object({
  id: z.number().int().positive(), provider: z.string().max(100), kind: z.string().max(100),
  title: z.string().max(2000), state: z.string().max(100), url: z.string().max(4096).nullable(),
  sourceBranch: z.string().max(500).nullable().optional(), targetBranch: z.string().max(500).nullable().optional(),
});
export const taskContextAssetSchema = z.object({
  id: z.string().uuid(), filename: z.string().max(500), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.string().max(Math.ceil(contextLimits.assetBytes / 3) * 4), digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const taskContextSnapshotSchema = z.object({
  version: z.literal(1), issueId: z.number().int().positive(), projectId: z.number().int().positive(), capturedAt: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(contextLimits.chars),
  warnings: z.array(z.string().max(1000)).max(100), development: z.array(developmentSchema).max(100),
  assets: z.array(taskContextAssetSchema).max(contextLimits.assets),
});
export const taskContextAssetRefSchema = taskContextAssetSchema.omit({ data: true });
export const persistedTaskContextSchema = taskContextSnapshotSchema.extend({ assets: z.array(taskContextAssetRefSchema).max(contextLimits.assets) });
export type TaskContextAssetRef = z.infer<typeof taskContextAssetRefSchema>;
export type PersistedTaskContext = z.infer<typeof persistedTaskContextSchema>;
export type TaskContextSnapshot = z.infer<typeof taskContextSnapshotSchema>;
export type TaskContextAsset = z.infer<typeof taskContextAssetSchema>;
export const taskContextMetadataSchema = persistedTaskContextSchema.omit({ text: true, assets: true }).extend({
  assetCount: z.number().int().nonnegative(), textChars: z.number().int().nonnegative(),
});
export const executionContextSchema = z.object({
  captured: taskContextMetadataSchema.nullable(),
  latest: taskContextMetadataSchema.nullable(),
  checkedAt: z.number(),
  warning: z.string().nullable(),
});
