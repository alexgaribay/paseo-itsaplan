import { z } from "zod";

const key = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commentId = z.number().int().positive().nullable();
const reportState = z.enum(["prepared", "submitting", "submitted", "unknown"]);
export const ticketReportNotesSchema = z.string().trim().max(2000);
export const ticketReportPreviewInputSchema = z.object({ key, body: ticketReportNotesSchema.optional() }).strict();
export const ticketReportAttestationSchema = z.object({ fingerprint: digest, unrestrictedTask: z.literal(true) }).strict();
export const ticketReportSubmitInputSchema = z.object({ key, digest, attestation: ticketReportAttestationSchema }).strict();
export const ticketReportReconcileInputSchema = z.object({ key }).strict();

export const ticketReportReceiptSchema = z.object({
  marker: z.string().uuid(), state: reportState, commentId, updatedAt: z.number(),
});
export const ticketReportPrivateSchema = ticketReportReceiptSchema.extend({
  actorId: z.string().min(1), scopeDigest: digest, digest,
  body: z.string().max(8000), notes: ticketReportNotesSchema,
  baseBody: z.string().max(8000).nullable(),
  attestation: ticketReportAttestationSchema.optional(),
});
export type TicketReportPrivate = z.infer<typeof ticketReportPrivateSchema>;
export type TicketReportReceipt = z.infer<typeof ticketReportReceiptSchema>;

export const ticketReportPreviewSchema = z.object({
  key, marker: z.string().uuid(), state: reportState, commentId,
  operation: z.enum(["create", "update"]), body: z.string(), notes: ticketReportNotesSchema, digest,
  review: z.object({ fingerprint: digest, task: z.string(), systemPrompt: z.string(), requirements: z.string(), statement: z.string() }),
  warnings: z.array(z.string()),
});
export type TicketReportPreview = z.infer<typeof ticketReportPreviewSchema>;
export const ticketReportResultSchema = z.object({
  key, state: reportState, commentId, message: z.string(),
});
export type TicketReportResult = z.infer<typeof ticketReportResultSchema>;
