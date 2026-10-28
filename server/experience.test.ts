import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configSchema, projectMappingSchema, selectionSchema } from "../shared/config";
import type { LinkedRepository, SessionRecord } from "../shared/models";
import type { Gateway, SessionSnapshot } from "./contracts";
import { diagnostics } from "./diagnostics";
import { ConfigurationError } from "./errors";
import { planForIssue, queuePreview, readiness, type ExperienceContext } from "./experience";
import { resolvePreferences } from "./plan";
import { Client, RequestError, type UpstreamRun } from "./protocol";
import { discardRerun, prepareRerun, prepareSmoke, reconcileRerun, recoverHandoff, submitRerun } from "./rerun";
import { PrivateStorage } from "./storage";
import { parseRequestComment } from "./task";

const execute = promisify(execFile);
const originalFetch = globalThis.fetch;
let directory: string;
let storage: PrivateStorage;
let context: ExperienceContext;
let wire: PreviewClient;
let native: SessionSnapshot | null;
let postCount: number;
let postMode: "ok" | "lost" | "denied";
let submittedBody: string;
let humanIsAgent: boolean;
let humanId: string;
let failQueueAfterPost: boolean;
let nativeWrites: number;
let upstreamWrites: number;

class PreviewClient extends Client {
  queueError: Error | null = null;
  complete = true;
  personal = false;
  invocationUrl: string | null = null;
  agentVisible = true;
  actorId = "actor-9";
  username = "builder";
  agentId = 9;
  issueProjectId = 7;
  source: UpstreamRun = { id: 11, agentId: 9, username: "builder", projectId: "7", projectName: "Token Watch", issueId: 21, issueIdentifier: "TW-21", prompt: "Original human task", trigger: "mention", status: "failed", executionState: "failed", attempts: 1, createdAt: "2026-10-24T00:00:00Z", nextAttemptAt: "2026-10-24T00:00:00Z" };
  items: UpstreamRun[] = [];
  override async identity() { return { id: this.actorId, username: this.username, isAgent: !this.personal }; }
  override async agent() { return this.agentVisible ? { id: this.agentId, username: this.username, kind: "external" as const, invocationUrl: this.invocationUrl, delegationDelaySec: 0 } : null; }
  override async projects() { return [{ id: 7, key: "TW", name: "Token Watch" }, { id: 8, key: "OTHER", name: "Unconfigured" }]; }
  override async repositories(): Promise<LinkedRepository[]> { return []; }
  override async issue(id: number) { return { id, projectId: this.issueProjectId, identifier: `TW-${id}`, title: "Task" }; }
  override async queue() { if (this.queueError) throw this.queueError; return { items: structuredClone(this.items), complete: this.complete }; }
  override async getRun(id: number) { return structuredClone(id === this.source.id ? this.source : this.items.find((item) => item.id === id) ?? null); }
  override async claim(): Promise<never> { upstreamWrites++; throw new Error("Readiness must never claim"); }
  override async claimChat(): Promise<never> { upstreamWrites++; throw new Error("Readiness must never claim chat"); }
}

function session(): SessionRecord {
  return { key: "run-11", kind: "run", externalId: 11, attempt: 1, serverUrl: "https://plan.example", issueId: 21, issueIdentifier: "TW-21", projectId: "7", agentId: "native-11", workspaceId: null, cwd: directory, provider: "omp", phase: "finished", createdAt: 1, updatedAt: 2, eventOffset: 0, result: { status: "failed", error: "Original failure" } };
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-experience-")));
  await execute("git", ["init", "--initial-branch=main", directory]);
  storage = new PrivateStorage(join(directory, "private"));
  await storage.initialize();
  await storage.put(session());
  wire = new PreviewClient({ url: "https://plan.example", apiKey: "execution-key" });
  native = { id: "native-11", workspaceId: null, cwd: directory, provider: "omp", model: "model-1", modeId: "ask", active: false, archived: false, pendingPermissionCount: 0 };
  nativeWrites = 0;
  upstreamWrites = 0;
  postCount = 0;
  postMode = "ok";
  humanIsAgent = false;
  humanId = "human-1";
  failQueueAfterPost = false;
  submittedBody = "";
  const gateway: Gateway = {
    host: async () => ({ id: "host-1", label: "Desktop" }),
    catalog: async () => [{ id: "omp", available: true, models: [{ id: "model-1", name: "Model one" }], modes: [{ id: "ask", name: "Ask" }] }],
    repositories: async () => [],
    select: async (config, project, override) => resolvePreferences(config, project, override).selection,
    inspect: async () => native,
    create: async () => { nativeWrites++; throw new Error("Preview must not create a native session"); },
    send: async () => { nativeWrites++; throw new Error("Preview must not send a task"); },
    wait: async () => { throw new Error("Preview must not wait for a task"); },
    cancel: async () => { nativeWrites++; throw new Error("Preview must not cancel a task"); },
    close: async () => {},
  };
  context = { config: configSchema.parse({ serverUrl: "https://plan.example", automatic: true, defaultProvider: "omp", defaultModel: "model-1", defaultModeId: "ask", projects: { "7": { repository: directory, automatic: true } } }), protocol: wire, gateway, storage, credentials: () => storage.secrets(), assertCurrent: () => {}, runtime: { claiming: true, paused: false, active: 0, reservations: 0, pendingConfiguration: false, lastPollAt: null } };
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/me") return Response.json({ authenticated: true, user: { id: humanId, username: "operator", isAgent: humanIsAgent } });
    if (url.pathname === "/issues/21/comments" && init?.method === "POST") {
      postCount++;
      expect(storage.requests()[0]?.state).toBe("submitting");
      const payload = JSON.parse(String(init.body)) as { body: string };
      submittedBody = payload.body;
      if (postMode === "denied") return new Response(null, { status: 403 });
      wire.items.push({ ...wire.source, id: 12, prompt: payload.body, status: "pending", executionState: "queued" });
      if (failQueueAfterPost) wire.queueError = new RequestError(403, "forbidden");
      if (postMode === "lost") throw new Error("Connection closed after commit");
      return Response.json({ id: 101 });
    }
    throw new Error(`Unexpected test request ${url.pathname}`);
  }, { preconnect: originalFetch.preconnect });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

describe("non-claiming experience reads", () => {
  test("enables unsaved projects by default while an unresolved repository still fails closed", async () => {
    const before = await readFile(join(storage.directory, "sessions.json"), "utf8");
    const result = await readiness(context);
    expect(result.ready).toBe(true);
    expect(result.projects.map((project) => ({ id: project.projectId, ready: project.ready, automatic: project.automatic }))).toEqual([{ id: "7", ready: true, automatic: true }, { id: "8", ready: false, automatic: true }]);
    expect({ nativeWrites, upstreamWrites, journal: await readFile(join(storage.directory, "sessions.json"), "utf8") }).toEqual({ nativeWrites: 0, upstreamWrites: 0, journal: before });
  });

  test("distinguishes missing queue permission from an available empty queue", async () => {
    const available = await queuePreview(context);
    wire.queueError = new RequestError(403, "forbidden");
    const unavailable = await queuePreview(context);
    expect({ availability: available.availability, complete: available.complete, queued: available.queued }).toEqual({ availability: "available", complete: true, queued: 0 });
    expect({ availability: unavailable.availability, complete: unavailable.complete, items: unavailable.items }).toEqual({ availability: "unavailable", complete: false, items: [] });
    expect((await readiness(context)).ready).toBe(false);
  });

  test("exposes partial counts and unfiltered claims for an unsaved project", async () => {
    wire.complete = false;
    wire.items = [{ ...wire.source, id: 30, projectId: "8", executionState: "queued", status: "pending" }];
    const preview = await queuePreview(context);
    expect({ complete: preview.complete, queued: preview.queued, unfiltered: preview.unfilteredClaims, configured: preview.items[0]?.configured, automatic: preview.items[0]?.automatic }).toEqual({ complete: false, queued: 1, unfiltered: true, configured: false, automatic: true });
  });

  test("fails polling readiness for personal credentials and push invocation", async () => {
    wire.personal = true;
    expect((await readiness(context)).checks.find((check) => check.id === "identity")?.state).toBe("fail");
    wire.personal = false;
    wire.invocationUrl = "https://push.example/invoke";
    const push = await readiness(context);
    expect({ ready: push.ready, invocation: push.checks.find((check) => check.id === "invocation")?.state }).toEqual({ ready: false, invocation: "fail" });
    wire.invocationUrl = null;
    wire.agentVisible = false;
    expect((await readiness(context)).checks.find((check) => check.id === "invocation")?.state).toBe("unknown");
  });

  test("retains per-field plan provenance when only mode is manually changed", async () => {
    context.config.issueOverrides["21"] = { provider: "omp", model: "issue-model", modeId: "ask" };
    const plan = await planForIssue(context, { issueId: 21, modeId: "plan" });
    expect({ selection: plan.selection, sources: plan.sources, hostId: plan.hostId, repository: plan.repository, enforcement: plan.noToolsEnforcement }).toEqual({ selection: { provider: "omp", model: "issue-model", modeId: "plan" }, sources: { provider: "issue", model: "issue", mode: "manual" }, hostId: "host-1", repository: directory, enforcement: "instruction-only" });
    const switched = await planForIssue(context, { issueId: 21, provider: "other" });
    expect({ model: switched.selection.model, mode: switched.selection.modeId, unresolved: switched.defaultModelUnresolved }).toEqual({ model: "", mode: "", unresolved: true });
  });

  test("rejects a non-Git working directory before producing an executable plan", async () => {
    context.config.projects["7"]!.repository = storage.directory;
    await expect(planForIssue(context, { issueId: 21 })).rejects.toThrow("canonical Git checkout root");
  });
});

describe("durable human rerun delivery", () => {
  test("reuses a browser preview and never pretends that copying queues a run", async () => {
    const first = await prepareRerun(context, { key: "run-11", operation: "smoke" });
    const second = await prepareRerun(context, { key: "run-11", operation: "smoke" });
    const result = await submitRerun(context, { requestId: first.requestId, planDigest: first.planDigest });
    expect({ reused: first.requestId === second.requestId, requests: storage.requests().length, delivery: first.delivery, state: result.state, runId: result.runId, posts: postCount }).toEqual({ reused: true, requests: 1, delivery: "browser", state: "unknown", runId: null, posts: 0 });
    expect("comment" in first).toBe(false);
    expect(result.comment).toContain("@builder");
    expect(result.comment).not.toContain("Original human task");
  });

  test("never upgrades or discards an exposed browser handoff after credentials change", async () => {
    const browser = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    await submitRerun(context, browser);
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const submission = await submitRerun(context, browser);
    const discarded = await discardRerun(context, browser);
    expect({ submission: submission.state, discard: discarded.state, posts: postCount }).toEqual({ submission: "unknown", discard: "unknown", posts: 0 });
    await expect(prepareRerun(context, { key: "run-11", operation: "smoke" })).rejects.toThrow();
  });

  test("reuses one prepared operation under concurrent preview requests", async () => {
    const previews = await Promise.all([prepareRerun(context, { key: "run-11", operation: "rerun" }), prepareRerun(context, { key: "run-11", operation: "rerun" })]);
    expect({ sameId: previews[0]!.requestId === previews[1]!.requestId, count: storage.requests().length, state: storage.requests()[0]?.state }).toEqual({ sameId: true, count: 1, state: "prepared" });
  });

  test("discarding an untouched preview releases its source without exposing a reusable comment", async () => {
    const first = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    expect("comment" in first).toBe(false);
    const discarded = await discardRerun(context, first);
    const second = await prepareRerun(context, { key: "run-11", operation: "smoke" });
    expect(discarded.state).toBe("dismissed");
    expect(second.requestId).not.toBe(first.requestId);
    expect((await submitRerun(context, first)).state).toBe("dismissed");
    expect(postCount).toBe(0);
  });

  test("serializes concurrent submits and observes a real queued run", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    const results = await Promise.all([submitRerun(context, preview), submitRerun(context, preview)]);
    expect(results.map((result) => ({ state: result.state, runId: result.runId, commentId: result.commentId }))).toEqual([{ state: "submitted", runId: 12, commentId: 101 }, { state: "submitted", runId: 12, commentId: 101 }]);
    expect({ postCount, requests: storage.requests().length }).toEqual({ postCount: 1, requests: 1 });
    expect(parseRequestComment(submittedBody, "builder")).toMatchObject({ requestId: preview.requestId, sourceRunId: 11, operation: "rerun" });
    await expect(prepareRerun(context, { key: "run-11", operation: "smoke" })).rejects.toThrow("Reconcile");
  });

  test("lost ACK remains unknown and never reposts before authoritative recovery", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    postMode = "lost";
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    const lost = await submitRerun(context, preview);
    const queued = wire.items;
    wire.items = [];
    wire.complete = false;
    const uncertain = await submitRerun(context, preview);
    expect({ lost: lost.state, repeated: uncertain.state, posts: postCount }).toEqual({ lost: "unknown", repeated: "unknown", posts: 1 });
    await expect(prepareRerun(context, { key: "run-11", operation: "smoke" })).rejects.toThrow("unknown delivery");
    wire.items = queued;
    const recovered = await reconcileRerun(context, preview);
    expect({ state: recovered.state, runId: recovered.runId, commentId: recovered.commentId, posts: postCount }).toEqual({ state: "submitted", runId: 12, commentId: null, posts: 1 });
  });

  test("recovers a persisted submitting state without posting after a restart", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    await storage.updateRequest(preview.requestId, (request) => ({ ...request, state: "submitting" }));
    await storage.close();
    storage = new PrivateStorage(join(directory, "private"));
    await storage.initialize();
    context.storage = storage;
    const recovered = await submitRerun(context, preview);
    expect({ state: recovered.state, posts: postCount, persisted: storage.request(preview.requestId)?.state }).toEqual({ state: "unknown", posts: 0, persisted: "unknown" });
    await expect(prepareRerun(context, { key: "run-11", operation: "rerun" })).rejects.toThrow("unknown delivery");
  });

  test("rejects changed routing and bot-authored request credentials before posting", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    context.config.projects["7"]!.worktree = false;
    await expect(submitRerun(context, preview)).rejects.toThrow("plan or request scope changed");
    expect({ state: storage.request(preview.requestId)?.state, posts: postCount }).toEqual({ state: "prepared", posts: 0 });
    context.config.projects["7"]!.worktree = true;
    humanIsAgent = true;
    await expect(submitRerun(context, preview)).rejects.toThrow("human account");
    expect(postCount).toBe(0);
  });
  test("does not post when the durable submitting transition cannot commit", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    const commit = storage.putRequest.bind(storage);
    storage.putRequest = async (request) => {
      if (request.state === "submitting") throw new Error("Journal unavailable");
      return commit(request);
    };
    await expect(submitRerun(context, preview)).rejects.toThrow("Journal unavailable");
    expect({ posts: postCount, state: storage.request(preview.requestId)?.state }).toEqual({ posts: 0, state: "prepared" });
  });

  test("allows a fresh request only after the observed next run is terminal", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const first = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    expect((await submitRerun(context, first)).runId).toBe(12);
    await expect(prepareRerun(context, { key: "run-11", operation: "smoke" })).rejects.toThrow("active");
    wire.items[0]!.executionState = "success";
    wire.items[0]!.status = "success";
    const second = await prepareRerun(context, { key: "run-11", operation: "smoke" });
    expect({ differentId: second.requestId !== first.requestId, requests: storage.requests().length, operation: second.operation }).toEqual({ differentId: true, requests: 2, operation: "smoke" });
  });

  test("rejects a changed source actor or project without posting", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    wire.source.username = "another-agent";
    await expect(submitRerun(context, preview)).rejects.toThrow("another agent, issue, or project");
    wire.source.username = "builder";
    wire.source.projectId = "8";
    await expect(submitRerun(context, preview)).rejects.toThrow("another agent, issue, or project");
    expect({ posts: postCount, state: storage.request(preview.requestId)?.state }).toEqual({ posts: 0, state: "prepared" });
  });

  test("requires authoritative terminal state and an idle native session", async () => {
    wire.source.executionState = "running";
    await expect(prepareRerun(context, { key: "run-11", operation: "rerun" })).rejects.toThrow("queued or running");
    wire.source.executionState = "failed";
    native = { id: "native-11", workspaceId: null, cwd: directory, provider: "omp", model: "model-1", modeId: "ask", active: false, archived: false, pendingPermissionCount: 1 };
    await expect(prepareRerun(context, { key: "run-11", operation: "rerun" })).rejects.toThrow("awaiting permission");
    native.pendingPermissionCount = 0;
    expect((await prepareRerun(context, { key: "run-11", operation: "rerun" })).plan.issueId).toBe(21);
  });

  test("does not adopt a matching body from another issue, project, or actor", async () => {
    const preview = await prepareRerun(context, { key: "run-11", operation: "smoke" });
    await submitRerun(context, preview);
    const body = storage.request(preview.requestId)!.body;
    wire.items = [{ ...wire.source, id: 12, prompt: body, issueId: 22 }, { ...wire.source, id: 13, prompt: body, projectId: "8" }, { ...wire.source, id: 14, prompt: body, agentId: 10 }];
    const rejected = await reconcileRerun(context, preview);
    expect({ runId: rejected.runId, posts: postCount }).toEqual({ runId: null, posts: 0 });
    wire.items.push({ ...wire.source, id: 15, prompt: body, executionState: "queued" });
    expect((await reconcileRerun(context, preview)).runId).toBe(15);
  });
  test("comment acknowledgement without queue access remains unknown", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    failQueueAfterPost = true;
    const acknowledged = await submitRerun(context, preview);
    expect({ state: acknowledged.state, commentId: acknowledged.commentId, runId: acknowledged.runId, posts: postCount }).toEqual({ state: "unknown", commentId: 101, runId: null, posts: 1 });
    await expect(prepareRerun(context, { key: "run-11", operation: "smoke" })).rejects.toThrow("unknown delivery");
    wire.queueError = null;
    const observed = await reconcileRerun(context, preview);
    expect({ state: observed.state, runId: observed.runId, posts: postCount }).toEqual({ state: "submitted", runId: 12, posts: 1 });
  });

  test("crashing after comment acknowledgement cannot cause another POST", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    const commit = storage.putRequest.bind(storage);
    let failAcknowledgement = true;
    storage.putRequest = async (request) => {
      if (request.state === "unknown" && failAcknowledgement) {
        failAcknowledgement = false;
        throw new Error("Acknowledgement persistence failed");
      }
      return commit(request);
    };
    await expect(submitRerun(context, preview)).rejects.toThrow("Acknowledgement persistence failed");
    expect({ persisted: storage.request(preview.requestId)?.state, posts: postCount }).toEqual({ persisted: "submitting", posts: 1 });
    const recovered = await submitRerun(context, preview);
    expect({ state: recovered.state, runId: recovered.runId, posts: postCount }).toEqual({ state: "submitted", runId: 12, posts: 1 });
  });

  test("multiple matching upstream runs require review rather than arbitrary adoption", async () => {
    const preview = await prepareRerun(context, { key: "run-11", operation: "smoke" });
    await submitRerun(context, preview);
    const body = storage.request(preview.requestId)!.body;
    wire.items = [{ ...wire.source, id: 12, prompt: body }, { ...wire.source, id: 13, prompt: body }];
    const ambiguous = await reconcileRerun(context, preview);
    expect({ state: ambiguous.state, runId: ambiguous.runId, persisted: storage.request(preview.requestId)?.state }).toEqual({ state: "unknown", runId: null, persisted: "unknown" });
    await expect(prepareRerun(context, { key: "run-11", operation: "rerun" })).rejects.toThrow("unknown delivery");
  });


  test("known rejection is failed rather than a fabricated queued state", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    postMode = "denied";
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    const rejected = await submitRerun(context, preview);
    expect({ state: rejected.state, runId: rejected.runId, posts: postCount }).toEqual({ state: "failed", runId: null, posts: 1 });
  });
});

test("diagnostics exports only structural execution metadata", async () => {
  const sensitive = "PROMPT_SECRET https://secret.example/private /Users/alex/private key-secret";
  const record = { ...session(), cwd: sensitive, error: sensitive, pendingEvents: [{ type: "RUN_ERROR" as const, message: sensitive }], result: { status: "failed" as const, output: sensitive, error: sensitive }, intent: { version: 1 as const, source: "task" as const, request: sensitive, projectId: "7", sourceRunId: 11 }, acceptance: { status: "failed" as const, checkedAt: 4, enforcement: "instruction-only" as const, checks: [{ id: "output" as const, status: "failed" as const, message: sensitive }] } };
  context.config.projects["8"] = projectMappingSchema.parse({ repository: sensitive, provider: "https://secret.example", model: "/Users/alex/model", automatic: false });
  const report = await diagnostics(context, { state: "ready", credentialPresent: true, mcpCredentialPresent: false, passwordPresent: false, requestCredentialPresent: true, sessions: [record] });
  const bundle = JSON.parse(report.text) as { sessions: { externalId: number; result: object; acceptance: { checks: object[] } }[]; credentials: object; configuration: { projects: object[] } };
  expect(bundle.credentials).toEqual({ execution: true, mcp: false, paseoPassword: false, humanRequest: true });
  expect(bundle.sessions[0]?.externalId).toBe(11);
  expect(bundle.sessions[0]?.result).toEqual({ status: "failed", outputPresent: true, errorPresent: true, inputTokens: null, outputTokens: null });
  expect(bundle.sessions[0]?.acceptance.checks).toEqual([{ id: "output", status: "failed" }]);
  expect(bundle.configuration.projects[1]).toEqual({ id: "8", automatic: false, repositoryConfigured: true, workspaceConfigured: false, worktree: true, provider: null, model: null, modeId: null });
  for (const excluded of ["PROMPT_SECRET", "secret.example", "/Users/", "key-secret", "Original failure", "serverUrl", "cwd", "pendingEvents", "request\""]) expect(report.text).not.toContain(excluded);
});

test("diagnostics redacts a credential even if entered into a valid model identifier", async () => {
  await storage.saveSecrets({ apiKey: "model-1" });
  const report = await diagnostics(context, { state: "connected", credentialPresent: true, mcpCredentialPresent: false, passwordPresent: false, requestCredentialPresent: false, sessions: [] });
  expect(report.text).not.toContain("model-1");
  expect(JSON.parse(report.text).state).toBe("connected");
});

async function emptyJournal(): Promise<void> {
  await storage.close();
  storage = new PrivateStorage(join(directory, "first-run"));
  await storage.initialize();
  context.storage = storage;
  native = null;
}

describe("issue-origin smoke and browser recovery", () => {
  test("hands off one fixed smoke with no session history or previous run lookup", async () => {
    await emptyJournal();
    wire.getRun = async () => { throw new Error("A first-run smoke has no previous run"); };
    const first = await prepareSmoke(context, { issueId: 21 });
    const second = await prepareSmoke(context, { issueId: 21 });
    const delivered = await submitRerun(context, first);
    expect({ requestId: second.requestId, state: delivered.state, planIssue: first.plan.issueId, history: storage.records(), posts: postCount, nativeWrites, upstreamWrites }).toEqual({ requestId: first.requestId, state: "unknown", planIssue: 21, history: [], posts: 0, nativeWrites: 0, upstreamWrites: 0 });
    expect(parseRequestComment(delivered.comment!, "builder")).toEqual({ version: 2, requestId: first.requestId, issueId: 21, projectId: "7", agentId: 9, operation: "smoke" });
    expect(storage.request(first.requestId)?.source).toEqual({ kind: "issue", agentId: 9, actorId: "actor-9", username: "builder" });
    expect((await submitRerun(context, first)).state).toBe("unknown");
    expect((await discardRerun(context, first)).state).toBe("unknown");
    await expect(prepareSmoke(context, { issueId: 21 })).rejects.toThrow("unknown delivery");
  });

  test("delivers an issue smoke through one human POST without local dispatch", async () => {
    await emptyJournal();
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareSmoke(context, { issueId: 21 });
    const results = await Promise.all([submitRerun(context, preview), submitRerun(context, preview)]);
    expect(results.map(({ state, runId, commentId }) => ({ state, runId, commentId }))).toEqual([{ state: "submitted", runId: 12, commentId: 101 }, { state: "submitted", runId: 12, commentId: 101 }]);
    expect({ posts: postCount, history: storage.records(), nativeWrites, upstreamWrites }).toEqual({ posts: 1, history: [], nativeWrites: 0, upstreamWrites: 0 });
    await expect(recoverHandoff(context, preview)).rejects.toThrow("previously handed-off browser");
    expect(parseRequestComment(submittedBody, "builder")).toMatchObject({ version: 2, issueId: 21, agentId: 9, operation: "smoke" });
  });

  test("recovers the exact body across reload and reconciles without a new nonce or POST", async () => {
    await emptyJournal();
    const preview = await prepareSmoke(context, { issueId: 21 });
    await expect(recoverHandoff(context, preview)).rejects.toThrow("previously handed-off browser");
    const handoff = await submitRerun(context, preview);
    await storage.close();
    storage = new PrivateStorage(join(directory, "first-run"));
    await storage.initialize();
    context.storage = storage;
    await storage.saveSecrets({ requestApiKey: "human-key" });
    wire.queueError = new RequestError(403, "unavailable");
    const unknown = await recoverHandoff(context, preview);
    expect({ state: unknown.state, body: unknown.comment, issueId: unknown.issueId, projectId: unknown.projectId, requestId: unknown.requestId, requests: storage.requests().length, posts: postCount }).toEqual({ state: "unknown", body: handoff.comment!, issueId: 21, projectId: "7", requestId: preview.requestId, requests: 1, posts: 0 });
    wire.queueError = null;
    wire.items = [{ ...wire.source, id: 12, prompt: handoff.comment!, status: "pending", executionState: "queued" }];
    const observed = await recoverHandoff(context, preview);
    expect({ state: observed.state, runId: observed.runId, comment: observed.comment, delivery: storage.request(preview.requestId)?.delivery, posts: postCount }).toEqual({ state: "submitted", runId: 12, comment: handoff.comment!, delivery: "browser", posts: 0 });
    expect(observed.message).toContain("Do not post it twice");
  });

  test("keeps old v1 browser handoffs byte-for-byte without source metadata", async () => {
    const preview = await prepareRerun(context, { key: "run-11", operation: "rerun" });
    const handedOff = await submitRerun(context, preview);
    await storage.updateRequest(preview.requestId, ({ source: _source, executionActorId: _actor, ...request }) => request);
    const recovered = await recoverHandoff(context, preview);
    expect({ body: recovered.comment, version: parseRequestComment(recovered.comment, "builder")?.version, state: recovered.state, posts: postCount }).toEqual({ body: handedOff.comment!, version: 1, state: "unknown", posts: 0 });
  });

  test("rejects recovery for untouched, failed, dismissed, and API requests", async () => {
    await emptyJournal();
    const preview = await prepareSmoke(context, { issueId: 21 });
    for (const state of ["prepared", "failed", "dismissed"] as const) {
      await storage.updateRequest(preview.requestId, (request) => ({ ...request, state }));
      await expect(recoverHandoff(context, preview)).rejects.toThrow("previously handed-off browser");
    }
    await storage.updateRequest(preview.requestId, (request) => ({ ...request, state: "unknown", delivery: "api" }));
    await expect(recoverHandoff(context, preview)).rejects.toThrow("previously handed-off browser");
    expect({ state: storage.request(preview.requestId)?.state, posts: postCount, nativeWrites }).toEqual({ state: "unknown", posts: 0, nativeWrites: 0 });
  });

  test("rejects actor, agent, project, and connection changes before delivery or recovery", async () => {
    await emptyJournal();
    const preview = await prepareSmoke(context, { issueId: 21 });
    wire.actorId = "replacement-actor";
    await expect(submitRerun(context, preview)).rejects.toThrow("scope no longer matches");
    wire.actorId = "actor-9";
    wire.agentId = 10;
    await expect(submitRerun(context, preview)).rejects.toThrow("scope no longer matches");
    wire.agentId = 9;
    context.config.projects["8"] = { ...context.config.projects["7"]! };
    wire.issueProjectId = 8;
    await expect(submitRerun(context, preview)).rejects.toThrow("scope no longer matches");
    wire.issueProjectId = 7;
    const handoff = await submitRerun(context, preview);
    wire.username = "replacement-bot";
    await expect(recoverHandoff(context, preview)).rejects.toThrow("scope no longer matches");
    wire.username = "builder";
    context.config.serverUrl = "https://different.example";
    await expect(recoverHandoff(context, preview)).rejects.toThrow("different It's a Plan connection");
    expect({ handedOff: handoff.state, state: storage.request(preview.requestId)?.state, posts: postCount }).toEqual({ handedOff: "unknown", state: "unknown", posts: 0 });
  });

  test("pins API delivery and human identity instead of changing channel or account", async () => {
    await emptyJournal();
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareSmoke(context, { issueId: 21 });
    humanId = "different-human";
    await expect(submitRerun(context, preview)).rejects.toThrow("delivery actor changed");
    humanId = "human-1";
    await storage.saveSecrets({ requestApiKey: "" });
    await expect(submitRerun(context, preview)).rejects.toThrow("delivery actor changed");
    expect({ state: storage.request(preview.requestId)?.state, delivery: storage.request(preview.requestId)?.delivery, posts: postCount }).toEqual({ state: "prepared", delivery: "api", posts: 0 });
    await discardRerun(context, preview);
    expect((await prepareSmoke(context, { issueId: 21 })).delivery).toBe("browser");
  });

  test("fences concurrent requests across run and issue origins", async () => {
    const previews = await Promise.allSettled([prepareRerun(context, { key: "run-11", operation: "rerun" }), prepareSmoke(context, { issueId: 21 })]);
    expect(previews.map((preview) => preview.status)).toEqual(["fulfilled", "rejected"]);
    expect(storage.requests().map(({ operation, state }) => ({ operation, state }))).toEqual([{ operation: "rerun", state: "prepared" }]);
    await discardRerun(context, { requestId: storage.requests()[0]!.id });
    const firstRun = await prepareSmoke(context, { issueId: 21 });
    await expect(prepareRerun(context, { key: "run-11", operation: "smoke" })).rejects.toThrow("this issue");
    expect((await submitRerun(context, firstRun)).state).toBe("unknown");
  });

  test("rejects new visible work and incomplete queue proofs at preview and submit", async () => {
    await emptyJournal();
    wire.complete = false;
    await expect(prepareSmoke(context, { issueId: 21 })).rejects.toThrow("incomplete queue");
    wire.complete = true;
    const preview = await prepareSmoke(context, { issueId: 21 });
    wire.items = [{ ...wire.source, id: 30, status: "pending", executionState: "running" }];
    await expect(submitRerun(context, preview)).rejects.toThrow("queued or running upstream work");
    wire.items = [];
    wire.queueError = new RequestError(403, "unavailable");
    await expect(submitRerun(context, preview)).rejects.toMatchObject({ status: 403 });
    wire.queueError = null;
    wire.complete = false;
    await expect(submitRerun(context, preview)).rejects.toThrow("incomplete queue");
    expect({ state: storage.request(preview.requestId)?.state, posts: postCount }).toEqual({ state: "prepared", posts: 0 });
    wire.complete = true;
    expect((await submitRerun(context, preview)).state).toBe("unknown");
  });

  test("requires fresh plans and enabled automatic execution without resuming anything", async () => {
    await emptyJournal();
    const preview = await prepareSmoke(context, { issueId: 21 });
    context.config.issueOverrides["21"] = selectionSchema.parse({ modeId: "plan" });
    await expect(submitRerun(context, preview)).rejects.toThrow("plan or request scope changed");
    context.config.issueOverrides["21"] = selectionSchema.parse({});
    for (const disabled of ["global", "project", "paused", "draining", "claiming"] as const) {
      context.config.automatic = disabled !== "global";
      context.config.projects["7"]!.automatic = disabled !== "project";
      context.runtime.paused = disabled === "paused";
      context.runtime.pendingConfiguration = disabled === "draining";
      context.runtime.claiming = disabled !== "claiming";
      await expect(submitRerun(context, preview)).rejects.toBeInstanceOf(ConfigurationError);
    }
    expect({ state: storage.request(preview.requestId)?.state, posts: postCount, nativeWrites, upstreamWrites }).toEqual({ state: "prepared", posts: 0, nativeWrites: 0, upstreamWrites: 0 });
  });
});

test("uses the coherent request credential snapshot and rechecks it after the durable POST fence", async () => {
  await emptyJournal();
  context.credentials = async () => ({ requestApiKey: "snapshot-human-key" });
  let current = true;
  context.assertCurrent = () => { if (!current) throw new Error("Request snapshot changed"); };
  const preview = await prepareSmoke(context, { issueId: 21 });
  const commit = storage.putRequest.bind(storage);
  storage.putRequest = async (request) => {
    await commit(request);
    if (request.state === "submitting") current = false;
  };
  await expect(submitRerun(context, preview)).rejects.toThrow("Request snapshot changed");
  expect({ delivery: preview.delivery, state: storage.request(preview.requestId)?.state, posts: postCount }).toEqual({ delivery: "api", state: "submitting", posts: 0 });
  current = true;
  expect((await submitRerun(context, preview)).state).toBe("unknown");
  expect(postCount).toBe(0);
});

test("does not expose a recovered body after its connection snapshot is invalidated", async () => {
  await emptyJournal();
  const preview = await prepareSmoke(context, { issueId: 21 });
  const handoff = await submitRerun(context, preview);
  context.assertCurrent = () => { throw new Error("Request snapshot changed"); };
  await expect(recoverHandoff(context, preview)).rejects.toThrow("Request snapshot changed");
  context.assertCurrent = () => {};
  const recovered = await recoverHandoff(context, preview);
  expect({ body: recovered.comment, requestId: recovered.requestId, state: recovered.state, posts: postCount }).toEqual({ body: handoff.comment!, requestId: preview.requestId, state: "unknown", posts: 0 });
});

test("cannot prepare a new request when historical native stop or issue work is unproven", async () => {
  native = null;
  await expect(prepareRerun(context, { key: "run-11", operation: "rerun" })).rejects.toThrow("idle state is unavailable");
  native = { id: "native-11", workspaceId: null, cwd: directory, provider: "omp", model: "model-1", modeId: "ask", active: false, archived: true, pendingPermissionCount: 0 };
  await storage.update("run-11", (record) => ({ ...record, phase: "running" }));
  await expect(prepareSmoke(context, { issueId: 21 })).rejects.toThrow("active or unresolved native execution");
  await storage.update("run-11", (record) => ({ ...record, phase: "finished" }));
  const preview = await prepareSmoke(context, { issueId: 21 });
  expect({ state: storage.request(preview.requestId)?.state, posts: postCount }).toEqual({ state: "prepared", posts: 0 });
});

test("an untouched preview can be discarded after its source configuration becomes unavailable", async () => {
  const preview = await prepareSmoke(context, { issueId: 21 });
  delete context.config.projects["7"];
  wire.queueError = new RequestError(403, "Project access removed");
  const discarded = await discardRerun(context, preview);
  expect(discarded).toMatchObject({ state: "dismissed", runId: null, commentId: null });
  expect(discarded.comment).toBeUndefined();
  expect(storage.request(preview.requestId)?.state).toBe("dismissed");
  expect(postCount).toBe(0);
});

test("pausing during the final queue check prevents exposing or posting a new request", async () => {
  await emptyJournal();
  const preview = await prepareSmoke(context, { issueId: 21 });
  const queue = wire.queue.bind(wire);
  wire.queue = async () => {
    const result = await queue();
    await storage.setPaused(true);
    return result;
  };
  await expect(submitRerun(context, preview)).rejects.toThrow();
  expect(storage.request(preview.requestId)?.state).toBe("prepared");
  expect(postCount).toBe(0);
});

test("another session's idle metadata cannot authorize a new issue request", async () => {
  native!.id = "different-native-session";
  await expect(prepareSmoke(context, { issueId: 21 })).rejects.toThrow();
  expect(storage.requests()).toEqual([]);
  expect(postCount).toBe(0);
});

test("an unsaved project prepares and delivers a smoke through defaults and repository auto-resolution", async () => {
  await storage.saveSecrets({ requestApiKey: "human-key" });
  delete context.config.projects["7"];
  wire.repositories = async () => [{ id: 1, provider: "github", fullName: "acme/token-watch", webUrl: "https://github.com/acme/token-watch" }];
  context.gateway.repositories = async () => [{ paseoProjectId: "p1", name: "Token Watch", repository: directory, common: directory, remotes: ["https://github.com/acme/token-watch"] }];
  const preview = await prepareSmoke(context, { issueId: 21 });
  expect(preview.plan.repository).toBe(directory);
  const delivered = await submitRerun(context, preview);
  expect({ state: delivered.state, runId: delivered.runId, commentId: delivered.commentId, posts: postCount }).toEqual({ state: "submitted", runId: 12, commentId: 101, posts: 1 });
});
