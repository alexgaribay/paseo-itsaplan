import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { SessionRecord } from "../shared/models";
import {
  ticketReportPreviewInputSchema, ticketReportSubmitInputSchema, ticketReportReconcileInputSchema,
  type TicketReportPrivate, type TicketReportPreview, type TicketReportResult,
} from "../shared/ticket-report";
import { assertSourceCurrent, sourceFacts, sourceFactsDigest } from "./continuation";
import type { Secrets } from "./contracts";
import { ConfigurationError } from "./errors";
import type { ExperienceContext } from "./experience";
import type { PrivateStorage } from "./storage";

const operations = new WeakMap<PrivateStorage, Map<string, Promise<unknown>>>();
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const approvalStatement = "I reviewed the original task, system instructions and requirements. This original task permits a ticket report and is not a smoke, exact-output, no-tools or no-posting task. I approve only the displayed report, not requirements or issue status changes.";

async function exclusive<T>(context: ExperienceContext, key: string, operation: () => Promise<T>): Promise<T> {
  let entries = operations.get(context.storage);
  if (!entries) { entries = new Map(); operations.set(context.storage, entries); }
  const current = (entries.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  entries.set(key, current);
  try { return await current; }
  finally { if (entries.get(key) === current) entries.delete(key); }
}

function recordFor(context: ExperienceContext, key: string): SessionRecord {
  const record = context.storage.get(key);
  if (!record || record.kind !== "run" || record.issueId === null || record.serverUrl !== context.config.serverUrl) throw new ConfigurationError("Ticket reporting requires a recorded issue run on this connection.");
  if (record.phase !== "finished" || record.result?.status !== "success" || record.cancellation) throw new ConfigurationError("Only a successful, finished, uncanceled source run may be reported.");
  return record;
}

function material(record: SessionRecord): string {
  const { ticketReport: _private, ticketReportReceipt: _public, updatedAt: _updated, ...source } = record;
  return hash(source);
}

interface Scope {
  record: SessionRecord;
  actorId: string;
  facts: { task: string; systemPrompt: string; requirements: string };
  fingerprint: string;
  configDigest: string;
  original: string;
  credentialDigest: string;
  digest: string;
}

async function scopeFor(context: ExperienceContext, key: string): Promise<Scope> {
  context.assertCurrent();
  const record = recordFor(context, key);
  const original = material(record);
  const configDigest = hash(context.config);
  const facts = sourceFacts(record);
  const fingerprint = sourceFactsDigest(record);
  await assertSourceCurrent(context, record);
  context.assertCurrent();
  const actor = await context.protocol.identity();
  context.assertCurrent();
  if (!actor.isAgent) throw new ConfigurationError("Ticket reports must use the execution bot's credential.");
  const issue = await context.protocol.issue(record.issueId!);
  context.assertCurrent();
  if (String(issue.projectId) !== record.projectId || issue.id !== record.issueId) throw new ConfigurationError("The report issue changed project or identity. Review a new report.");
  const credentials = await context.credentials();
  context.assertCurrent();
  if (!credentials.apiKey) throw new ConfigurationError("The execution credential is unavailable.");
  if (material(recordFor(context, key)) !== original || hash(context.config) !== configDigest) throw new ConfigurationError("The source or configuration changed during report review.");
  return { record, actorId: actor.id, facts, fingerprint, configDigest, original, credentialDigest: hash(credentials), digest: hash({ source: original, fingerprint, configDigest, credentials, actorId: actor.id, issueId: issue.id, projectId: issue.projectId }) };
}

function safeNotes(notes: string, credentials: Readonly<Secrets>): void {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(notes) || /(?:https?:\/\/|www\.|<\/?|```|@|paseo-ticket-report:|(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=])/i.test(notes)) throw new ConfigurationError("Report notes cannot contain links, mentions, markup, report markers or credential assignments.");
  if (Object.values(credentials).some((value) => value && notes.includes(value))) throw new ConfigurationError("Report notes contain a saved credential and cannot be posted.");
}

function bodyFor(record: SessionRecord, marker: string, notes: string): string {
  const tools = record.evidence?.toolCallCount;
  return [
    `Paseo execution report for run ${record.externalId}, attempt ${record.attempt}.`,
    "", "Outcome", "Native turn completed successfully. The execution result was delivered through the execution API.",
    "", "Validation", "Implementation, tests, pull requests and issue completion have not been independently verified by this report.",
    tools == null ? "Tool activity is unknown." : `Observed ${tools} tool calls. Turn history is ${record.evidence?.historyComplete ? "complete" : "incomplete"}; tool activity alone does not prove implementation or passing tests.`,
    ...(notes ? ["", "User-reviewed notes, not independently verified evidence", ...notes.split("\n").map((line) => `> ${line}`)] : []),
    "", "Remaining work", "A human must review implementation and validation evidence. Original requirements and issue status are unchanged.",
    "", `<!-- paseo-ticket-report:${marker} -->`,
  ].join("\n");
}

function reportDigest(report: Pick<TicketReportPrivate, "marker" | "actorId" | "scopeDigest" | "body" | "notes" | "baseBody" | "commentId">): string {
  return hash({ marker: report.marker, actorId: report.actorId, scopeDigest: report.scopeDigest, body: report.body, notes: report.notes, baseBody: report.baseBody, commentId: report.commentId });
}

function assertReport(scope: Scope, report: TicketReportPrivate): void {
  if (report.actorId !== scope.actorId || report.scopeDigest !== scope.digest || report.digest !== reportDigest(report) || report.body !== bodyFor(scope.record, report.marker, report.notes)) throw new ConfigurationError("The approved report, execution credential, actor or source scope changed. Review a new report; never repost unknown delivery.");
}

async function persist(context: ExperienceContext, scope: Scope, report: TicketReportPrivate): Promise<void> {
  context.assertCurrent();
  if (hash(context.config) !== scope.configDigest) throw new ConfigurationError("Configuration changed during report delivery.");
  await context.storage.update(scope.record.key, (current) => {
    if (material(current) !== scope.original) throw new ConfigurationError("The execution changed during report delivery.");
    return { ...current, ticketReport: report, ticketReportReceipt: { marker: report.marker, state: report.state, commentId: report.commentId, updatedAt: report.updatedAt } };
  });
  context.assertCurrent();
}

function result(key: string, report: TicketReportPrivate, message: string): TicketReportResult {
  return { key, state: report.state, commentId: report.commentId, message };
}

async function ownedComment(context: ExperienceContext, scope: Scope, report: TicketReportPrivate): Promise<void> {
  const feed = await context.protocol.commentFeed(scope.record.issueId!);
  context.assertCurrent();
  const existing = feed.items.filter((item) => item.id === report.commentId);
  const markers = feed.items.filter((item) => item.body.includes(`paseo-ticket-report:${report.marker}`));
  if (!feed.complete || existing.length !== 1 || markers.length !== 1 || existing[0].actorId !== scope.actorId || existing[0].body !== report.baseBody || markers[0].id !== report.commentId) throw new ConfigurationError("A complete authoritative feed must prove the exact existing comment belongs to this bot before updating it.");
}

export function prepareTicketReport(context: ExperienceContext, input: z.infer<typeof ticketReportPreviewInputSchema>): Promise<TicketReportPreview> {
  const parsed = ticketReportPreviewInputSchema.parse(input);
  return exclusive(context, parsed.key, async () => {
    const scope = await scopeFor(context, parsed.key);
    const previous = scope.record.ticketReport;
    if (previous && (previous.state === "submitting" || previous.state === "unknown")) throw new ConfigurationError("Report delivery is unknown. Reconcile it without preparing another write.");
    if (previous) assertReport(scope, previous);
    const credentials = await context.credentials();
    context.assertCurrent();
    if (hash(credentials) !== scope.credentialDigest) throw new ConfigurationError("Credentials changed during report review.");
    const notes = parsed.body ?? previous?.notes ?? "";
    safeNotes(notes, credentials);
    const report: TicketReportPrivate = {
      marker: previous?.marker ?? randomUUID(), actorId: scope.actorId, scopeDigest: scope.digest,
      state: "prepared", commentId: previous?.commentId ?? null, updatedAt: Date.now(),
      notes, body: "", digest: "", baseBody: previous?.state === "submitted" ? previous.body : previous?.baseBody ?? null,
    };
    report.body = bodyFor(scope.record, report.marker, notes);
    report.digest = reportDigest(report);
    if (report.commentId !== null) await ownedComment(context, scope, report);
    await persist(context, scope, report);
    return { key: parsed.key, marker: report.marker, state: report.state, commentId: report.commentId, operation: report.commentId === null ? "create" : "update", body: report.body, notes, digest: report.digest, review: { ...scope.facts, fingerprint: scope.fingerprint, statement: approvalStatement }, warnings: ["This posts only after explicit approval. No requirements or issue status will be changed.", "Model claims are not imported as verified implementation or test evidence. Notes remain user-reviewed claims."] };
  });
}

async function reconcile(context: ExperienceContext, scope: Scope, report: TicketReportPrivate): Promise<TicketReportResult> {
  assertReport(scope, report);
  if (report.state === "prepared") return result(scope.record.key, report, "This preview has not been submitted. Review and approve it explicitly.");
  let feed;
  try { feed = await context.protocol.commentFeed(scope.record.issueId!); }
  catch {
    const unknown: TicketReportPrivate = { ...report, state: "unknown", updatedAt: Date.now() };
    await persist(context, scope, unknown);
    return result(scope.record.key, unknown, "The authoritative comment feed is unavailable. Delivery remains unknown. No comment was posted or retried.");
  }
  context.assertCurrent();
  const candidates = feed.items.filter((item) => item.body.includes(`paseo-ticket-report:${report.marker}`));
  const matched = candidates.length === 1 && candidates[0].actorId === report.actorId && candidates[0].body === report.body && (report.commentId === null || candidates[0].id === report.commentId) ? candidates[0] : undefined;
  if (feed.complete && matched) {
    const submitted: TicketReportPrivate = { ...report, state: "submitted", commentId: matched.id, baseBody: null, updatedAt: Date.now() };
    submitted.digest = reportDigest(submitted);
    await persist(context, scope, submitted);
    return result(scope.record.key, submitted, "The exact bot-authored report is confirmed in the complete authoritative comment feed. Issue status and requirements are unchanged.");
  }
  const unknown: TicketReportPrivate = { ...report, state: "unknown", updatedAt: Date.now() };
  await persist(context, scope, unknown);
  return result(scope.record.key, unknown, feed.complete ? "No unique exact bot-authored receipt is proven. Delivery remains unknown. Never repost this report blindly." : "Only a partial comment feed is visible. Delivery remains unknown. No comment was posted or retried.");
}

export function submitTicketReport(context: ExperienceContext, input: z.infer<typeof ticketReportSubmitInputSchema>): Promise<TicketReportResult> {
  const parsed = ticketReportSubmitInputSchema.parse(input);
  return exclusive(context, parsed.key, async () => {
    let scope = await scopeFor(context, parsed.key);
    const report = scope.record.ticketReport;
    if (!report) throw new ConfigurationError("Prepare and review a ticket report before approving it.");
    assertReport(scope, report);
    if (report.state !== "prepared") return reconcile(context, scope, report);
    if (parsed.digest !== report.digest || parsed.attestation.fingerprint !== scope.fingerprint) throw new ConfigurationError("The report or original task review changed. Review the current preview and attest again.");
    const credentials = await context.credentials();
    context.assertCurrent();
    if (hash(credentials) !== scope.credentialDigest) throw new ConfigurationError("Credentials changed after report approval.");
    safeNotes(report.notes, credentials);
    if (report.commentId !== null) await ownedComment(context, scope, report);
    scope = await scopeFor(context, parsed.key);
    assertReport(scope, report);
    const fenced: TicketReportPrivate = { ...report, state: "submitting", attestation: parsed.attestation, updatedAt: Date.now() };
    await persist(context, scope, fenced);
    const finalScope = await scopeFor(context, parsed.key);
    assertReport(finalScope, fenced);
    try {
      const receipt = report.commentId === null
        ? await context.protocol.comment(scope.record.issueId!, report.body)
        : await context.protocol.updateComment(report.commentId, report.body);
      if (report.commentId !== null && receipt.id !== report.commentId) throw new ConfigurationError("The comment update receipt changed identity.");
      const submitted: TicketReportPrivate = { ...fenced, state: "submitted", commentId: receipt.id, baseBody: null, updatedAt: Date.now() };
      submitted.digest = reportDigest(submitted);
      await persist(context, scope, submitted);
      return result(parsed.key, submitted, "The server acknowledged the approved ticket report. Issue status and requirements are unchanged.");
    } catch {
      const unknown: TicketReportPrivate = { ...fenced, state: "unknown", updatedAt: Date.now() };
      await persist(context, scope, unknown);
      return result(parsed.key, unknown, "Report delivery is uncertain. Reconcile the original report. Do not submit a new comment or retry blindly.");
    }
  });
}

export function reconcileTicketReport(context: ExperienceContext, input: z.infer<typeof ticketReportReconcileInputSchema>): Promise<TicketReportResult> {
  const parsed = ticketReportReconcileInputSchema.parse(input);
  return exclusive(context, parsed.key, async () => {
    const scope = await scopeFor(context, parsed.key);
    const report = scope.record.ticketReport;
    if (!report) throw new ConfigurationError("No ticket report is recorded for this execution.");
    return reconcile(context, scope, report);
  });
}
