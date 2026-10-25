import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, projectMappingSchema } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import type { TicketReportPreview } from "../shared/ticket-report";
import type { Gateway, SessionSnapshot } from "./contracts";
import { captureProvenance } from "./continuation";
import type { ExperienceContext } from "./experience";
import { Client, RequestError, type UpstreamRun } from "./protocol";
import { PrivateStorage } from "./storage";
import { prepareTicketReport, reconcileTicketReport, submitTicketReport } from "./ticket-report";

let directory: string;
let context: ExperienceContext;
let storage: PrivateStorage;
let wire: ReportClient;
let native: SessionSnapshot;
let forbiddenRequests: string[];
const key = "run-11";
const issue = { id: 21, projectId: 7, identifier: "TW-21", title: "Implement the parser", description: "Preserve the original input." };

class ReportClient extends Client {
  actorId = "bot-user-9";
  issueProjectId = 7;
  complete = true;
  unavailable = false;
  lost = false;
  comments: Array<{ id: number; body: string; actorId: string }> = [];
  writes: Array<{ method: string; issueId?: number; commentId?: number; body: string }> = [];
  source: UpstreamRun = { id: 11, agentId: 9, username: "builder", projectId: "7", projectName: "Token Watch", issueId: 21, issueIdentifier: "TW-21", prompt: "Implement the parser", trigger: "mention", status: "success", executionState: "success", attempts: 1, createdAt: "2026-10-24T00:00:00Z", nextAttemptAt: "2026-10-24T00:00:00Z" };
  override async identity() { return { id: this.actorId, username: "builder", isAgent: true }; }
  override async agent() { return { id: 9, username: "builder", kind: "external" as const, invocationUrl: null, delegationDelaySec: 0 }; }
  override async issue(id: number) { return { ...issue, id, projectId: this.issueProjectId }; }
  override async getRun() { return structuredClone(this.source); }
  override async commentFeed() {
    if (this.unavailable) throw new RequestError(403, "Feed denied");
    return { items: structuredClone(this.comments), complete: this.complete };
  }
  override async comment(issueId: number, body: string) {
    expect(storage.get(key)?.ticketReport?.state).toBe("submitting");
    expect(storage.get(key)?.ticketReport?.attestation?.unrestrictedTask).toBe(true);
    this.writes.push({ method: "POST", issueId, body });
    const item = { id: 101, body, actorId: this.actorId };
    this.comments.push(item);
    if (this.lost) throw new RequestError(0, "Acknowledgment lost");
    return { id: item.id };
  }
  override async updateComment(commentId: number, body: string) {
    expect(storage.get(key)?.ticketReport?.state).toBe("submitting");
    this.writes.push({ method: "PATCH", commentId, body });
    const item = this.comments.find((comment) => comment.id === commentId);
    if (!item) throw new RequestError(404, "Comment missing");
    item.body = body;
    if (this.lost) throw new RequestError(0, "Acknowledgment lost");
    return { id: item.id };
  }
}

function approve(preview: TicketReportPreview) {
  return { key: preview.key, digest: preview.digest, attestation: { fingerprint: preview.review.fingerprint, unrestrictedTask: true as const } };
}

async function seed(change: Partial<SessionRecord> = {}) {
  const project = projectMappingSchema.parse({ repository: directory, provider: "omp", model: "model-1", modeId: "ask" });
  const record: SessionRecord = {
    key, kind: "run", externalId: 11, attempt: 1, serverUrl: "https://plan.example", issueId: 21, issueIdentifier: "TW-21", projectId: "7",
    agentId: "native-11", workspaceId: null, cwd: directory, provider: "omp", model: "model-1", modeId: "ask", nativeLastUserMessageAt: "2026-10-24T00:00:00Z", phase: "finished", createdAt: 1, updatedAt: 2, eventOffset: 0,
    result: { status: "success", output: "I implemented everything, all tests pass, and the issue is complete. This is unverified model prose." },
    task: { kind: "run", run: { id: 11, attempts: 1, trigger: "mention", prompt: "Implement the parser", systemPrompt: "Respect the original requirements.", issueId: 21, issueIdentifier: "TW-21" } },
    intent: { version: 1, source: "comment", request: "Implement the parser", projectId: "7", sourceRunId: 11 },
    taskIssue: issue, projectMapping: project, evidence: { toolCallCount: 3, historyComplete: true },
    plan: { issueId: 21, issueIdentifier: "TW-21", projectId: "7", hostId: "host-1", hostLabel: "Desktop", repository: directory, workspaceId: null, selection: { provider: "omp", model: "model-1", modeId: "ask" }, sources: { provider: "project", model: "project", mode: "project" }, worktree: true, baseBranch: "", defaultModelUnresolved: false, noToolsEnforcement: "instruction-only", warnings: [] },
    ...change,
  };
  if (record.task?.kind !== "run" || !record.intent || !record.taskIssue) throw new Error("Test source facts are missing");
  record.taskProvenance = captureProvenance(context.config, wire.actorId, record.intent, record.task.run.systemPrompt, record.taskIssue, record.taskContext);
  await storage.put(record);
  return record;
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-ticket-report-")));
  storage = new PrivateStorage(join(directory, "private"));
  await storage.initialize();
  await storage.saveSecrets({ apiKey: "private-execution-key", mcpToken: "private-mcp-key" });
  forbiddenRequests = [];
  wire = new ReportClient({ url: "https://plan.example", apiKey: "private-execution-key", fetch: Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    forbiddenRequests.push(`${init?.method ?? "GET"} ${String(input)}`);
    throw new Error("Reports cannot make unmodeled HTTP requests");
  }, { preconnect: globalThis.fetch.preconnect }) });
  native = { id: "native-11", workspaceId: null, cwd: directory, provider: "omp", model: "model-1", modeId: "ask", lastUserMessageAt: "2026-10-24T00:00:00Z", active: false, archived: false, pendingPermissionCount: 0 };
  const gateway: Gateway = {
    host: async () => ({ id: "host-1", label: "Desktop" }),
    catalog: async () => [{ id: "omp", available: true, models: [{ id: "model-1", name: "Model" }], modes: [{ id: "ask", name: "Ask" }] }],
    repositories: async () => [], select: async () => ({ provider: "omp", model: "model-1", modeId: "ask" }), inspect: async () => native,
    create: async () => { throw new Error("Reports cannot create native agents"); }, send: async () => { throw new Error("Reports cannot send tasks"); },
    wait: async () => { throw new Error("Reports cannot execute tasks"); }, cancel: async () => { throw new Error("Reports cannot cancel tasks"); }, close: async () => {},
  };
  context = { config: configSchema.parse({ serverUrl: "https://plan.example", defaultProvider: "omp", defaultModel: "model-1", defaultModeId: "ask", projects: { "7": { repository: directory, provider: "omp", model: "model-1", modeId: "ask" } } }), protocol: wire, gateway, storage, credentials: () => storage.secrets(), assertCurrent: () => {}, runtime: { claiming: false, paused: true, active: 0, reservations: 0, pendingConfiguration: false, lastPollAt: null } };
  await seed();
});

afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

describe("explicit ticket reports", () => {
  test("previews original facts without posting or trusting model completion claims", async () => {
    const preview = await prepareTicketReport(context, { key });
    expect({ operation: preview.operation, state: preview.state, task: preview.review.task, system: preview.review.systemPrompt, writes: wire.writes }).toEqual({ operation: "create", state: "prepared", task: "Implement the parser", system: "Respect the original requirements.", writes: [] });
    expect(preview.body).toContain("Native turn completed successfully.");
    expect(preview.body).toContain("not been independently verified");
    expect(preview.body.includes("I implemented everything")).toBe(false);
    expect(preview.body.includes("private-execution-key")).toBe(false);
    expect(preview.review.requirements).toContain("Preserve the original input.");
  });

  test("delivers once and updates only the same bot-owned per-run comment", async () => {
    const first = await prepareTicketReport(context, { key });
    const delivered = await submitTicketReport(context, approve(first));
    const update = await prepareTicketReport(context, { key, body: "Manual review found the parser change useful. Test results remain unverified." });
    const updated = await submitTicketReport(context, approve(update));
    expect({ first: delivered.state, next: updated.state, id: updated.commentId, operation: update.operation, marker: first.marker === update.marker }).toEqual({ first: "submitted", next: "submitted", id: 101, operation: "update", marker: true });
    expect(wire.writes).toEqual([{ method: "POST", issueId: 21, body: first.body }, { method: "PATCH", commentId: 101, body: update.body }]);
    expect(wire.comments).toEqual([{ id: 101, actorId: "bot-user-9", body: update.body }]);
    expect(storage.get(key)?.ticketReportReceipt).toEqual({ marker: first.marker, state: "submitted", commentId: 101, updatedAt: storage.get(key)!.ticketReportReceipt!.updatedAt });
    expect(forbiddenRequests).toEqual([]);
  });

  test("requires original-task attestation and exact approved digest", async () => {
    const preview = await prepareTicketReport(context, { key });
    await expect(submitTicketReport(context, { ...approve(preview), digest: "0".repeat(64) })).rejects.toThrow("changed");
    await expect(submitTicketReport(context, { ...approve(preview), attestation: { fingerprint: "0".repeat(64), unrestrictedTask: true } })).rejects.toThrow("changed");
    const receipt = await submitTicketReport(context, approve(preview));
    expect({ state: receipt.state, writes: wire.writes.map((write) => write.method) }).toEqual({ state: "submitted", writes: ["POST"] });
  });

  test("requires a fresh approval after editing notes without changing recorded evidence", async () => {
    const first = await prepareTicketReport(context, { key });
    const edited = await prepareTicketReport(context, { key, body: "The reviewer requested another validation pass." });
    await expect(submitTicketReport(context, approve(first))).rejects.toThrow("changed");
    const delivered = await submitTicketReport(context, approve(edited));
    expect({ state: delivered.state, marker: first.marker === edited.marker, notes: edited.notes, writes: wire.writes.length }).toEqual({ state: "submitted", marker: true, notes: "The reviewer requested another validation pass.", writes: 1 });
    expect(wire.comments[0].body).toBe(edited.body);
    expect(wire.comments[0].body).toContain("not been independently verified");
  });

  test("serializes duplicate approvals into one external comment", async () => {
    const preview = await prepareTicketReport(context, { key });
    const receipts = await Promise.all([submitTicketReport(context, approve(preview)), submitTicketReport(context, approve(preview))]);
    expect(receipts.map((receipt) => ({ state: receipt.state, id: receipt.commentId }))).toEqual([{ state: "submitted", id: 101 }, { state: "submitted", id: 101 }]);
    expect(wire.writes).toEqual([{ method: "POST", issueId: 21, body: preview.body }]);
  });

  test("reconciles a lost acknowledgment after durable reload without reposting", async () => {
    const preview = await prepareTicketReport(context, { key });
    wire.lost = true;
    const lost = await submitTicketReport(context, approve(preview));
    expect({ state: lost.state, id: lost.commentId }).toEqual({ state: "unknown", id: null });
    await storage.close();
    storage = new PrivateStorage(join(directory, "private"));
    await storage.initialize();
    context.storage = storage;
    const recovered = await reconcileTicketReport(context, { key });
    expect({ state: recovered.state, id: recovered.commentId, count: wire.writes.length }).toEqual({ state: "submitted", id: 101, count: 1 });
  });

  test("preserves a pre-POST durable fence across reload without a blind first retry", async () => {
    const preview = await prepareTicketReport(context, { key });
    await storage.update(key, (record) => ({ ...record, ticketReport: { ...record.ticketReport!, state: "submitting", attestation: approve(preview).attestation } }));
    await storage.close();
    storage = new PrivateStorage(join(directory, "private"));
    await storage.initialize();
    context.storage = storage;
    const reconciled = await reconcileTicketReport(context, { key });
    const attempted = await submitTicketReport(context, approve(preview));
    expect({ state: reconciled.state, attempted: attempted.state, writes: wire.writes }).toEqual({ state: "unknown", attempted: "unknown", writes: [] });
  });

  test("reconciles a lost update acknowledgment to the original comment identity", async () => {
    const first = await prepareTicketReport(context, { key });
    await submitTicketReport(context, approve(first));
    const update = await prepareTicketReport(context, { key, body: "A reviewer is still evaluating validation evidence." });
    wire.lost = true;
    const lost = await submitTicketReport(context, approve(update));
    const recovered = await reconcileTicketReport(context, { key });
    expect({ lost: lost.state, recovered: recovered.state, id: recovered.commentId }).toEqual({ lost: "unknown", recovered: "submitted", id: 101 });
    expect(wire.writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  });

  test("keeps partial and unavailable feeds unknown even with a visible exact match", async () => {
    const preview = await prepareTicketReport(context, { key });
    wire.lost = true;
    await submitTicketReport(context, approve(preview));
    wire.complete = false;
    const partial = await reconcileTicketReport(context, { key });
    wire.unavailable = true;
    const unavailable = await reconcileTicketReport(context, { key });
    await expect(prepareTicketReport(context, { key, body: "A replacement" })).rejects.toThrow("unknown");
    wire.unavailable = false;
    wire.complete = true;
    const complete = await reconcileTicketReport(context, { key });
    expect({ partial: partial.state, unavailable: unavailable.state, complete: complete.state, writes: wire.writes.length }).toEqual({ partial: "unknown", unavailable: "unknown", complete: "submitted", writes: 1 });
  });

  test("never treats a complete empty feed as permission to repost", async () => {
    const preview = await prepareTicketReport(context, { key });
    wire.lost = true;
    await submitTicketReport(context, approve(preview));
    wire.comments = [];
    const reconciled = await reconcileTicketReport(context, { key });
    const duplicate = await submitTicketReport(context, approve(preview));
    expect({ state: reconciled.state, duplicate: duplicate.state, writes: wire.writes.length }).toEqual({ state: "unknown", duplicate: "unknown", writes: 1 });
  });

  test("rejects spoofed actors, edited bodies and duplicate markers as receipts", async () => {
    const preview = await prepareTicketReport(context, { key });
    wire.lost = true;
    await submitTicketReport(context, approve(preview));
    wire.comments[0].actorId = "other-bot";
    const actor = await reconcileTicketReport(context, { key });
    wire.comments[0].actorId = "bot-user-9";
    wire.comments[0].body += " Edited outside the approval.";
    const body = await reconcileTicketReport(context, { key });
    wire.comments[0].body = preview.body;
    wire.comments.push({ id: 102, actorId: "human", body: preview.body });
    const duplicate = await reconcileTicketReport(context, { key });
    wire.comments.pop();
    const verified = await reconcileTicketReport(context, { key });
    expect([actor.state, body.state, duplicate.state, verified.state]).toEqual(["unknown", "unknown", "unknown", "submitted"]);
    expect(wire.writes.length).toBe(1);
  });

  test("refuses to update another actor's comment or an externally edited report", async () => {
    const preview = await prepareTicketReport(context, { key });
    await submitTicketReport(context, approve(preview));
    wire.comments[0].actorId = "human";
    await expect(prepareTicketReport(context, { key, body: "Updated note" })).rejects.toThrow("belongs to this bot");
    wire.comments[0].actorId = "bot-user-9";
    wire.comments[0].body += " Changed";
    await expect(prepareTicketReport(context, { key, body: "Updated note" })).rejects.toThrow("belongs to this bot");
    wire.comments[0].body = preview.body;
    const update = await prepareTicketReport(context, { key, body: "Updated note" });
    expect({ operation: update.operation, body: update.notes, writes: wire.writes.length }).toEqual({ operation: "update", body: "Updated note", writes: 1 });
  });

  test("requires a complete available feed before preparing an update", async () => {
    const preview = await prepareTicketReport(context, { key });
    await submitTicketReport(context, approve(preview));
    wire.complete = false;
    await expect(prepareTicketReport(context, { key, body: "Updated note" })).rejects.toThrow("complete authoritative feed");
    wire.complete = true;
    wire.unavailable = true;
    await expect(prepareTicketReport(context, { key, body: "Updated note" })).rejects.toThrow("Feed denied");
    wire.unavailable = false;
    const update = await prepareTicketReport(context, { key, body: "Updated note" });
    expect({ state: update.state, operation: update.operation, writes: wire.writes.length }).toEqual({ state: "prepared", operation: "update", writes: 1 });
  });

  test("rejects private body tampering instead of posting it", async () => {
    const preview = await prepareTicketReport(context, { key });
    await storage.update(key, (record) => ({ ...record, ticketReport: { ...record.ticketReport!, body: "Forged report" } }));
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow("changed");
    expect({ state: storage.get(key)?.ticketReport?.state, body: storage.get(key)?.ticketReport?.body, writes: wire.writes }).toEqual({ state: "prepared", body: "Forged report", writes: [] });
  });

  test("rejects secrets, raw links and injected report markers while allowing plain reviewed notes", async () => {
    for (const body of ["private-execution-key", "https://assets.example/private.png", "@another-agent", "<!-- paseo-ticket-report:spoof -->", "authorization: bearer something"]) {
      await expect(prepareTicketReport(context, { key, body })).rejects.toThrow();
    }
    const safe = await prepareTicketReport(context, { key, body: "Manual review is pending." });
    expect({ notes: safe.notes, state: safe.state, writes: wire.writes }).toEqual({ notes: "Manual review is pending.", state: "prepared", writes: [] });
  });
});

describe("report source boundaries", () => {
  test("invalidates approval when saved configuration changes", async () => {
    const preview = await prepareTicketReport(context, { key });
    context.config.defaultModeId = "changed";
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow();
    expect({ state: storage.get(key)?.ticketReport?.state, writes: wire.writes }).toEqual({ state: "prepared", writes: [] });
  });

  test("invalidates approval when credentials or execution actor change", async () => {
    const preview = await prepareTicketReport(context, { key });
    await storage.saveSecrets({ apiKey: "new-execution-key" });
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow();
    await storage.saveSecrets({ apiKey: "private-execution-key" });
    wire.actorId = "replacement-bot";
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow();
    wire.actorId = "bot-user-9";
    const accepted = await submitTicketReport(context, approve(preview));
    expect({ state: accepted.state, writes: wire.writes.length }).toEqual({ state: "submitted", writes: 1 });
  });

  test("blocks a moved issue, active native turn and changed authoritative task", async () => {
    const preview = await prepareTicketReport(context, { key });
    wire.issueProjectId = 8;
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow();
    wire.issueProjectId = 7;
    native.active = true;
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow();
    native.active = false;
    wire.source.prompt = "A different task";
    await expect(submitTicketReport(context, approve(preview))).rejects.toThrow();
    wire.source.prompt = "Implement the parser";
    const accepted = await submitTicketReport(context, approve(preview));
    expect({ state: accepted.state, writes: wire.writes.length }).toEqual({ state: "submitted", writes: 1 });
  });

  test("blocks missing provenance and failed or uncertain source runs", async () => {
    const original = storage.get(key)!;
    for (const change of [{ taskProvenance: undefined }, { task: undefined }, { taskIssue: undefined }, { result: { status: "failed" as const, error: "Failed" } }, { phase: "uncertain" as const }]) {
      await storage.put({ ...original, ...change });
      await expect(prepareTicketReport(context, { key })).rejects.toThrow();
    }
    await storage.put(original);
    const accepted = await prepareTicketReport(context, { key });
    expect({ state: accepted.state, writes: wire.writes }).toEqual({ state: "prepared", writes: [] });
  });

  test("never approves known restricted tasks even with captured provenance", async () => {
    const original = storage.get(key)!;
    if (original.task?.kind !== "run") throw new Error("Test run is missing");
    for (const request of ["This is a smoke test.", "Reply exactly: OK", "Do not use tools.", "Do not post comments on the issue."]) {
      const restricted = { ...original, intent: { ...original.intent!, request }, task: { kind: "run" as const, run: { ...original.task.run, prompt: request } } };
      restricted.taskProvenance = captureProvenance(context.config, wire.actorId, restricted.intent, restricted.task.run.systemPrompt, issue);
      await storage.put(restricted);
      await expect(prepareTicketReport(context, { key })).rejects.toThrow();
    }
    await storage.put(original);
    const accepted = await prepareTicketReport(context, { key });
    expect({ state: accepted.state, writes: wire.writes }).toEqual({ state: "prepared", writes: [] });
  });
});
