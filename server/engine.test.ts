import { afterEach, describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { defaults, type Config, type Selection } from "../shared/config";
import type { AgUiEvent, Result, Run, SessionRecord, Task } from "../shared/models";
import type { Gateway, Journal, Protocol, SessionSnapshot } from "./contracts";
import { Engine, taskKey } from "./engine";
import { Client, RequestError } from "./protocol";
import { ConfigurationError, StorageError } from "./errors";
import type { LocalRepository } from "./repository-matching";
import { resolvePreferences } from "./plan";
import type { ExecutionEvidence, RerunRequest } from "../shared/experience";
import { smokeComment } from "./task";

class MemoryJournal implements Journal {
  values = new Map<string, SessionRecord>();
  threads = new Map<string, { agentId: string; projectId: string }>();
  requests = new Map<string, RerunRequest>();
  records() { return structuredClone([...this.values.values()]); }
  get(key: string) { const value = this.values.get(key); return value && structuredClone(value); }
  request(id: string) { const value = this.requests.get(id); return value && structuredClone(value); }
  async put(record: SessionRecord) { this.values.set(record.key, structuredClone(record)); }
  async putMany(records: SessionRecord[]) { const next = structuredClone(records); for (const record of next) this.values.set(record.key, record); }
  async update(key: string, change: (record: SessionRecord) => SessionRecord | undefined) { const updated = change(this.get(key)!); if (updated) await this.put(updated); }
  thread(id: string) { return this.threads.get(id); }
  async bindThread(id: string, binding: { agentId: string; projectId: string }) { this.threads.set(id, binding); }
}
class CodingSessions implements Gateway {
  sessions = new Map<string, SessionSnapshot>();
  sent: { id: string; prompt: string }[] = [];
  created: Parameters<Gateway["create"]>[0][] = [];
  canceled: string[] = [];
  delay = 2;
  result: Result = { status: "success", output: "Implemented; tests passed in the coding session", usage: { inputTokens: 100, outputTokens: 20 } };
  evidence: ExecutionEvidence | undefined;
  async host() { return { id: "native-host", label: "Test host" }; }
  async catalog() { return []; }
  repositoriesList: LocalRepository[] = [];
  async repositories() { return this.repositoriesList; }
  async select(config: Config, project: Config["projects"][string], override: Partial<Selection> = {}) {
    const { selection } = resolvePreferences(config, project, override);
    if (selection.provider === "unavailable") throw new ConfigurationError("Selected Paseo provider is unavailable");
    return selection;
  }
  async create(input: Parameters<Gateway["create"]>[0]) {
    this.created.push(input);
    const value: SessionSnapshot = { id: input.agentId, workspaceId: `workspace-${this.created.length}`, cwd: input.project.repository, provider: input.selection.provider, model: input.selection.model || "resolved-default", modeId: input.selection.modeId || "resolved-mode", pendingPermissionCount: 0, active: false, archived: false };
    this.sessions.set(value.id, value);
    return value;
  }
  async inspect(id: string) { return this.sessions.get(id) ?? null; }
  async send(id: string, prompt: string) { this.sent.push({ id, prompt }); this.sessions.get(id)!.active = true; }
  async wait(id: string, _timeout: number, onText: (text: string) => void, signal: AbortSignal): Promise<Result & { evidence?: ExecutionEvidence }> {
    await sleep(this.delay, undefined, { signal });
    onText("Implemented; ");
    onText("tests passed in the coding session");
    this.sessions.get(id)!.active = false;
    return { ...this.result, evidence: this.evidence };
  }
  async cancel(id: string) { this.canceled.push(id); const value = this.sessions.get(id); if (value) value.active = false; }
  async close() {}
}
function protocol() {
  const reports: (Result & { attempt?: number })[] = [];
  const events: AgUiEvent[] = [];
  let beats = 0;
  let canceled = false;
  const api: Protocol = {
    claim: async () => null, claimChat: async () => null,
    heartbeat: async () => { beats++; }, report: async (_id, result) => { reports.push(result); },
    runEvents: async (_run, _offset, batch) => { events.push(...batch); },
    chatHeartbeat: async () => { beats++; return canceled; }, chatEvents: async (_id, batch) => { events.push(...batch); return canceled; },
    chatResult: async (_id, result) => { reports.push(result); }, projects: async () => [], repositories: async () => [],
    issue: async (id) => ({ id, projectId: id === 8 ? 2 : 1, identifier: `PRJ-${id}`, title: "Acceptance requirements", description: "Implement the requested change" }),
    intent: async (run, issue) => ({ version: 1, source: "task", request: "Original task intent", projectId: String(issue?.projectId ?? 2), sourceRunId: run.id }),
    search: async () => [], transition: async () => { throw new Error("Unexpected automatic issue transition"); }, test: async () => {},
  };
  return { api, reports, events, beats: () => beats, cancel: () => { canceled = true; } };
}
const running: Engine[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((engine) => engine.stop())); });
function setup(patch: Partial<Config> = {}) {
  const config = { ...defaults(), serverUrl: "http://127.0.0.1:9876", defaultProvider: "omp", defaultModel: "model", defaultModeId: "ask", projects: {
    "1": { repository: "/configured/one", provider: "", model: "", modeId: "", workspaceId: "", automatic: true, worktree: true, baseBranch: "main" },
    "2": { repository: "/configured/two", provider: "codex", model: "code-model", modeId: "review", workspaceId: "", automatic: true, worktree: false, baseBranch: "" },
  }, ...patch };
  const wire = protocol();
  const coding = new CodingSessions();
  const journal = new MemoryJournal();
  const engine = new Engine(config, wire.api, coding, journal, {}, { heartbeatMs: 10, flushMs: 5, backoffMs: 10 });
  running.push(engine);
  const run: Run = { id: 31, attempts: 1, traceEvents: true, trigger: "delegation", prompt: "Issue requirements and acceptance criteria", systemPrompt: "Follow the issue", issueId: 8, issueIdentifier: "PRJ-8" };
  return { config, wire, coding, journal, engine, task: { kind: "run", run } as const };
}
async function until(check: () => boolean) {
  for (let step = 0; step < 200 && !check(); step++) await sleep(2);
  expect(check()).toBe(true);
}

describe("external execution coordination", () => {
  test("routes a claimed issue, keeps heartbeats alive, reports output and persists its session without completing the issue", async () => {
    const value = setup();
    value.coding.delay = 35;
    await value.engine.dispatch(value.task);
    const record = value.journal.get(taskKey(value.config.serverUrl, value.task))!;
    expect(record).toMatchObject({ projectId: "2", cwd: "/configured/two", provider: "codex", phase: "finished", issueId: 8, attempt: 1 });
    expect(record.workspaceId).toBe("workspace-1");
    expect(value.wire.reports).toEqual([{ status: "success", output: "Implemented; tests passed in the coding session", usage: { inputTokens: 100, outputTokens: 20 }, attempt: 1 }]);
    expect(value.wire.beats()).toBeGreaterThan(1);
    const beats = value.wire.beats();
    await sleep(25);
    expect(value.wire.beats()).toBe(beats);
    expect(value.wire.events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("")).toBe("Implemented; tests passed in the coding session");
  });
  test("duplicate claims cannot create or prompt two coding sessions", async () => {
    const value = setup();
    await Promise.all([value.engine.dispatch(value.task), value.engine.dispatch(value.task)]);
    await value.engine.dispatch(value.task);
    expect(value.coding.created).toHaveLength(1);
    expect(value.coding.sent).toHaveLength(1);
    expect(value.wire.reports).toHaveLength(1);
  });
  test("an unmapped project fails without starting or canceling an arbitrary coding session", async () => {
    const value = setup({ projects: {} });
    await value.engine.dispatch(value.task);
    expect(value.coding.created).toEqual([]);
    expect(value.coding.canceled).toEqual([]);
    expect(value.wire.reports[0]).toMatchObject({ status: "failed", attempt: 1 });
  });
  test("unavailable provider is an actionable failure and never falls back", async () => {
    const value = setup({ defaultProvider: "unavailable", projects: { "2": { ...defaults().projects["2"], repository: "/configured/two", provider: "unavailable", model: "", modeId: "", workspaceId: "", automatic: true, worktree: false, baseBranch: "" } } });
    await value.engine.dispatch(value.task);
    expect(value.coding.created).toEqual([]);
    expect(value.wire.reports[0].error).toBe("Selected Paseo provider is unavailable");
  });
  test("timeout cancels the turn and reports failed rather than an unsupported timeout status", async () => {
    const value = setup({ executionTimeoutMs: 20 });
    value.coding.delay = 1000;
    await value.engine.dispatch(value.task);
    expect(value.coding.canceled).toHaveLength(1);
    expect(value.wire.reports[0]).toMatchObject({ status: "failed", error: "Execution timeout exceeded; session preserved" });
    expect(value.journal.records()[0].agentId).toBe(value.coding.canceled[0]);
  });
  test("known lease rejection stops execution and never reports a stale result", async () => {
    const value = setup();
    value.coding.delay = 1000;
    value.wire.api.heartbeat = async () => { if (value.coding.sent.length) throw new RequestError(404, "Expired"); };
    await value.engine.dispatch(value.task);
    expect(value.coding.canceled).toHaveLength(1);
    expect(value.wire.reports).toEqual([]);
    expect(value.journal.records()[0].phase).toBe("lease-lost");
  });
  test("native Paseo cancellation cannot be mistaken for a successful idle turn", async () => {
    const value = setup();
    value.coding.delay = 1000;
    const work = value.engine.dispatch(value.task);
    await until(() => value.coding.sent.length === 1);
    value.engine.observeTurnEnd(value.coding.sent[0].id, "canceled");
    await work;
    expect(value.wire.reports[0]).toMatchObject({ status: "failed", error: "Agent turn canceled in Paseo" });
  });
  test("result delivery is retried without re-executing and concurrent retry passes share one request", async () => {
    const value = setup();
    let offline = true;
    let calls = 0;
    value.wire.api.report = async (_id, result) => { calls++; if (offline) throw new RequestError(503, "Offline"); await sleep(20); value.wire.reports.push(result); };
    await value.engine.dispatch(value.task);
    expect(value.journal.records()[0].phase).toBe("reporting");
    expect(value.journal.records()[0].result?.status).toBe("success");
    offline = false;
    await Promise.all([value.engine.retryReports(), value.engine.retryReports(), value.engine.retryReports()]);
    expect(calls).toBe(2);
    expect(value.journal.records()[0].phase).toBe("finished");
    expect(value.coding.sent).toHaveLength(1);
  });
  test("lost result acknowledgment followed by 404 remains uncertain, never another prompt", async () => {
    const value = setup();
    let calls = 0;
    value.wire.api.report = async () => { if (++calls === 1) throw new RequestError(0, "Acknowledgment lost"); throw new RequestError(404, "Already final"); };
    await value.engine.dispatch(value.task);
    await value.engine.retryReports();
    await value.engine.dispatch(value.task);
    expect(value.journal.records()[0]).toMatchObject({ phase: "uncertain", result: { status: "success" } });
    expect(value.coding.sent).toHaveLength(1);
  });
  test("a reclaimed attempt reuses a durable outcome instead of repeating side effects", async () => {
    const value = setup();
    value.wire.api.report = async () => { throw new RequestError(503, "Offline"); };
    await value.engine.dispatch(value.task);
    value.wire.api.report = async (_id, result) => { value.wire.reports.push(result); };
    const retry: Task = { kind: "run", run: { ...value.task.run, attempts: 2 } };
    await value.engine.dispatch(retry);
    expect(value.coding.sent).toHaveLength(1);
    expect(value.wire.reports[0]).toMatchObject({ status: "success", attempt: 2 });
    expect(value.journal.get(taskKey(value.config.serverUrl, retry))?.phase).toBe("finished");
  });
  test("reload recovery waits on an active persisted session instead of sending its prompt again", async () => {
    const value = setup();
    await value.engine.dispatch(value.task);
    const record = value.journal.records()[0];
    await value.journal.put({ ...record, phase: "running", result: undefined, pendingEvents: [] });
    value.coding.sessions.get(record.agentId)!.active = true;
    const reloaded = new Engine(value.config, value.wire.api, value.coding, value.journal, {}, { heartbeatMs: 10 });
    running.push(reloaded);
    await reloaded.dispatch(value.task);
    expect(value.coding.sent).toHaveLength(1);
    expect(value.journal.get(record.key)?.phase).toBe("finished");
  });
  test("restart with an ambiguous idle turn reports failed without replaying it", async () => {
    const value = setup();
    await value.engine.dispatch(value.task);
    const record = value.journal.records()[0];
    await value.journal.put({ ...record, phase: "sending", result: undefined, pendingEvents: [] });
    await value.engine.dispatch(value.task);
    expect(value.coding.sent).toHaveLength(1);
    expect(value.wire.reports.at(-1)?.error).toContain("durable turn outcome");
  });
  test("chat follows a stable thread mapping and resumes the authoritative Paseo session", async () => {
    const value = setup({ chatProjects: { thread: "1" } });
    const chat: Task = { kind: "chat", message: { id: 20, attempts: 1, threadId: "thread", prompt: "Initial request", systemPrompt: "Rules", sessionId: null } };
    await value.engine.dispatch(chat);
    const id = value.journal.thread("thread")!.agentId;
    await value.engine.dispatch({ kind: "chat", message: { ...chat.message, id: 21, prompt: "Follow-up", sessionId: id } });
    expect(value.coding.created).toHaveLength(1);
    expect(value.coding.sent.map((entry) => entry.id)).toEqual([id, id]);
    expect(value.coding.sent.at(-1)?.prompt).toBe("Follow-up");
    expect(value.journal.records().map((record) => record.phase)).toEqual(["finished", "finished"]);
  });
  test("chat cancellation from heartbeats stops silently writing or reporting another result", async () => {
    const value = setup({ chatProjects: { thread: "1" } });
    value.coding.delay = 1000;
    const chat: Task = { kind: "chat", message: { id: 20, threadId: "thread", prompt: "Request", systemPrompt: "Rules", sessionId: null } };
    const work = value.engine.dispatch(chat);
    await until(() => value.coding.sent.length === 1);
    value.wire.cancel();
    await work;
    expect(value.journal.records()[0].phase).toBe("canceled");
    expect(value.wire.reports).toEqual([]);
    expect(value.coding.canceled).toHaveLength(1);
  });
  test("plugin shutdown cancels active turns, preserves associations, and reports failed", async () => {
    const value = setup();
    value.coding.delay = 1000;
    const work = value.engine.dispatch(value.task);
    await until(() => value.coding.sent.length === 1);
    await value.engine.stop();
    await work;
    expect(value.coding.canceled).toHaveLength(1);
    expect(value.journal.records()[0].agentId).toBe(value.coding.sent[0].id);
    expect(value.wire.reports[0]).toMatchObject({ status: "failed" });
    expect(value.wire.reports[0].error).toContain("Plugin stopped");
  });
});

describe("automatic repository routing", () => {
  function matched() {
    const value = setup();
    value.config.projects["2"]!.repository = "";
    value.wire.api.repositories = async () => [{ id: 4, provider: "gitea", fullName: "team/app", webUrl: "https://forge.test/team/app" }];
    value.coding.repositoriesList = [{ paseoProjectId: "native-project", name: "App", repository: "/registered/app", common: "/registered/app/.git", remotes: ["https://forge.test/team/app"] }];
    return value;
  }
  test("routes an opted-in project by linked repository and persists the resolved checkout", async () => {
    const value = matched();
    await value.engine.dispatch(value.task);
    expect(value.journal.records()[0]).toMatchObject({ phase: "finished", cwd: "/registered/app", projectMapping: { repository: "/registered/app", automatic: true } });
    expect(value.wire.reports[0]).toMatchObject({ status: "success", attempt: 1 });
  });
  test("independent matching clones fail before session creation", async () => {
    const value = matched();
    value.coding.repositoriesList.push({ ...value.coding.repositoriesList[0]!, paseoProjectId: "other", repository: "/other/app", common: "/other/app/.git" });
    await value.engine.dispatch(value.task);
    expect(value.coding.created).toEqual([]);
    expect(value.wire.reports[0]).toMatchObject({ status: "failed", attempt: 1 });
    expect(value.journal.records()[0]?.phase).toBe("finished");
  });
  test("an explicit override works without access to upstream repository metadata", async () => {
    const value = setup();
    value.wire.api.repositories = async () => { throw new RequestError(403, "Denied"); };
    value.coding.repositories = async () => { throw new Error("Catalog unavailable"); };
    await value.engine.dispatch(value.task);
    expect(value.journal.records()[0]).toMatchObject({ phase: "finished", cwd: "/configured/two" });
    expect(value.wire.reports[0]?.status).toBe("success");
  });
  test("a preparing execution remains pinned across restart even when the discovered checkout changes", async () => {
    const value = matched();
    const key = taskKey(value.config.serverUrl, value.task);
    const create = value.coding.create.bind(value.coding);
    let preparation!: SessionRecord;
    value.coding.create = async () => { preparation = value.journal.get(key)!; throw new Error("Simulated process loss"); };
    await value.engine.dispatch(value.task);
    await value.journal.put(preparation);
    value.coding.create = create;
    value.coding.repositoriesList[0]!.repository = "/new/app";
    const restarted = new Engine(value.config, value.wire.api, value.coding, value.journal, {}, { heartbeatMs: 10 });
    running.push(restarted);
    await restarted.start();
    await until(() => value.journal.get(key)?.phase === "finished");
    expect(value.journal.get(key)).toMatchObject({ cwd: "/registered/app", projectMapping: { repository: "/registered/app" } });
    expect(value.coding.sessions.get(preparation.agentId)?.cwd).toBe("/registered/app");
    expect(value.journal.get(key)?.result?.status).toBe("success");
  });
  test("matching does not grant automatic execution permission", async () => {
    const value = matched();
    value.config.projects["2"]!.automatic = false;
    await value.engine.dispatch(value.task);
    expect(value.coding.created).toEqual([]);
    expect(value.wire.reports[0]?.status).toBe("failed");
  });
  test("follow-up chat retains its original checkout when automatic repository discovery changes", async () => {
    const value = matched();
    value.config.chatProjects = { thread: "2" };
    const chat: Task = { kind: "chat", message: { id: 20, attempts: 1, threadId: "thread", prompt: "Initial", systemPrompt: "Rules", sessionId: null } };
    await value.engine.dispatch(chat);
    const agentId = value.journal.thread("thread")!.agentId;
    value.coding.repositoriesList[0]!.repository = "/new/app";
    await value.engine.dispatch({ kind: "chat", message: { ...chat.message, id: 21, prompt: "Follow-up", sessionId: agentId } });
    expect(value.coding.created).toHaveLength(1);
    expect(value.journal.records()[1]).toMatchObject({ phase: "finished", agentId, cwd: "/registered/app", projectMapping: { repository: "/registered/app" } });
    expect(value.wire.reports.map((result) => result.status)).toEqual(["success", "success"]);
  });
  test("manual issue starts use a unique match without a saved project override", async () => {
    const value = matched();
    value.config.projects = {};
    const record = await value.engine.manual(await value.wire.api.issue(8), value.coding);
    expect(record).toMatchObject({ phase: "running", cwd: "/registered/app", projectMapping: { repository: "/registered/app", automatic: false } });
    expect(value.coding.sessions.get(record.agentId)?.active).toBe(true);
    expect(value.wire.reports).toEqual([]);
  });
});

test("real HTTP polling recovers after disconnect and reserves capacity across both feeds", async () => {
  const value = setup({ automatic: true, maxConcurrent: 1, pollIntervalMs: 5 });
  value.coding.delay = 35;
  let requests = 0;
  let handed = false;
  let maxCoding = 0;
  let result: unknown;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (request.headers.get("x-api-key") !== "integration-key") return new Response(null, { status: 401 });
    if (path === "/agent-runs/claim") {
      if (++requests === 1) return new Response(null, { status: 503 });
      maxCoding = Math.max(maxCoding, value.coding.sessions.size);
      if (!handed) { handed = true; return Response.json({ run: value.task.run }); }
      return Response.json({ run: null });
    }
    if (path === "/agent-chats/claim") return Response.json({ message: null });
    if (path === "/issues/8") return Response.json({ id: 8, projectId: 2, identifier: "PRJ-8", title: "Requirements" });
    if (path === "/me") return Response.json({ authenticated: true, user: { id: "bot-user", isAgent: true, username: "bot" } });
    if (path === "/agent-runs/queue") return Response.json({ items: [{ id: 31, agentId: 9, username: "bot", projectRef: "project-ref", issueId: 8, sequenceNumber: 8, prompt: "Original task intent", trigger: "delegation", status: "pending", executionState: "running", attempts: 1, createdAt: "2026-01-01T00:00:00Z", nextAttemptAt: "2026-01-01T00:00:00Z" }], total: 1, page: 1, pageSize: 100 });
    if (path === "/projects/search") return Response.json({ items: [{ id: 2, ref: "project-ref", key: "PRJ", name: "Project" }], total: 1, page: 1, pageSize: 100 });
    if (path.endsWith("/result")) { result = await request.json(); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 204 });
  } });
  const config = { ...value.config, serverUrl: server.url.toString().replace(/\/$/, "") };
  const engine = new Engine(config, new Client({ url: config.serverUrl, apiKey: "integration-key" }), value.coding, value.journal, {}, { heartbeatMs: 10, backoffMs: 5 });
  running.push(engine);
  try {
    await engine.start();
    await until(() => Boolean(result));
    await until(() => value.journal.records()[0]?.phase === "finished");
    expect(result).toMatchObject({ status: "success", attempt: 1 });
    expect(value.coding.sent).toHaveLength(1);
    expect(requests).toBeGreaterThan(1);
    expect(maxCoding).toBeLessThanOrEqual(1);
  } finally { await engine.stop(); await server.stop(true); }
});

test("invalid credentials halt polling rather than retrying forever", async () => {
  const value = setup({ automatic: true });
  let claims = 0;
  value.wire.api.claim = async () => { claims++; throw new RequestError(401, "Rejected"); };
  value.wire.api.claimChat = async () => { claims++; throw new RequestError(401, "Rejected"); };
  await value.engine.start();
  await until(() => value.engine.state === "authentication-error");
  const stopped = claims;
  await sleep(30);
  expect(claims).toBe(stopped);
  expect(value.coding.created).toEqual([]);
});

test("journal failure after prompt acceptance cancels the owned turn before releasing it", async () => {
  const value = setup();
  const put = value.journal.put.bind(value.journal);
  value.journal.put = async (record) => { if (record.phase === "running") throw new StorageError("Disk failed"); await put(record); };
  await value.engine.dispatch(value.task);
  expect(value.engine.state).toBe("storage-error");
  expect(value.coding.canceled).toEqual([value.coding.sent[0].id]);
  expect(value.coding.sessions.get(value.coding.sent[0].id)?.active).toBe(false);
  expect(value.wire.reports).toEqual([]);
});

test("cancellation while sending-state persistence is pending cannot start a later turn", async () => {
  const value = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let blocked = false;
  const put = value.journal.put.bind(value.journal);
  value.journal.put = async (record) => { if (record.phase === "sending") { blocked = true; await gate; } await put(record); };
  const work = value.engine.dispatch(value.task);
  await until(() => blocked);
  const cancellation = value.engine.cancel(taskKey(value.config.serverUrl, value.task));
  release();
  await Promise.all([work, cancellation]);
  expect(value.coding.sent).toEqual([]);
  expect(value.wire.reports[0].status).toBe("failed");
});

test("cancellation before an in-flight send settles cancels again after acceptance", async () => {
  const value = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let blocked = false;
  const send = value.coding.send.bind(value.coding);
  value.coding.send = async (id, prompt) => { blocked = true; await gate; await send(id, prompt); };
  const work = value.engine.dispatch(value.task);
  await until(() => blocked);
  const cancellation = value.engine.cancel(taskKey(value.config.serverUrl, value.task));
  release();
  await Promise.all([work, cancellation]);
  expect(value.coding.canceled).toHaveLength(2);
  expect(value.coding.sessions.get(value.coding.sent[0].id)?.active).toBe(false);
  expect(value.wire.reports[0].status).toBe("failed");
});

test("periodic event journal failure stops native execution rather than being discarded", async () => {
  const value = setup();
  value.coding.delay = 1000;
  const put = value.journal.put.bind(value.journal);
  value.journal.put = async (record) => { if (record.pendingEvents?.length) throw new StorageError("Disk failed during stream"); await put(record); };
  await value.engine.dispatch(value.task);
  expect(value.engine.state).toBe("storage-error");
  expect(value.coding.canceled).toHaveLength(1);
  expect(value.wire.reports).toEqual([]);
});

test("shutdown preserves a completed successful outcome while delivery is pending", async () => {
  const value = setup();
  value.wire.api.report = async (_id, _result, signal) => { await sleep(1000, undefined, { signal }); };
  const work = value.engine.dispatch(value.task);
  await until(() => value.journal.records()[0]?.phase === "reporting");
  await value.engine.stop();
  await work;
  expect(value.journal.records()[0].result?.status).toBe("success");
  expect(value.journal.records()[0].phase).toBe("reporting");
  expect(value.coding.canceled).toEqual([]);
});

test("a follow-up can resume while the preceding native turn is only acknowledging its result", async () => {
  const value = setup({ chatProjects: { thread: "1" } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  value.wire.api.chatResult = async (id, result) => { if (id === 20) await gate; value.wire.reports.push(result); };
  const first: Task = { kind: "chat", message: { id: 20, threadId: "thread", prompt: "Initial", systemPrompt: "Rules", sessionId: null } };
  const before = value.engine.dispatch(first);
  await until(() => value.journal.records()[0]?.phase === "reporting");
  const id = value.journal.thread("thread")!.agentId;
  const after = value.engine.dispatch({ kind: "chat", message: { ...first.message, id: 21, prompt: "Follow-up", sessionId: id } });
  await after;
  release();
  await before;
  expect(value.coding.sent.map((message) => message.prompt)).toEqual(["Initial", "Follow-up"]);
  expect(value.coding.canceled).toEqual([]);
  expect(value.journal.records().map((record) => record.phase)).toEqual(["finished", "finished"]);
});

test("reclaimed chat attempts reconstruct the answer the upstream server erased", async () => {
  const value = setup({ chatProjects: { thread: "1" } });
  const chat: Task = { kind: "chat", message: { id: 20, attempts: 1, threadId: "thread", prompt: "Initial", systemPrompt: "Rules", sessionId: null } };
  value.wire.api.chatResult = async () => { throw new RequestError(503, "Offline"); };
  await value.engine.dispatch(chat);
  value.wire.events.length = 0;
  value.wire.api.chatResult = async (_id, result) => { value.wire.reports.push(result); };
  await value.engine.dispatch({ kind: "chat", message: { ...chat.message, attempts: 2 } });
  expect(value.coding.sent).toHaveLength(1);
  expect(value.wire.events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("")).toBe(value.coding.result.output!);
  expect(value.wire.reports[0].status).toBe("success");
});

test("recovery repairs a thread binding lost between session creation and its binding commit", async () => {
  const value = setup({ chatProjects: { thread: "1" } });
  const chat: Task = { kind: "chat", message: { id: 20, threadId: "thread", prompt: "Initial", systemPrompt: "Rules", sessionId: null } };
  const bind = value.journal.bindThread.bind(value.journal);
  value.journal.bindThread = async () => { throw new StorageError("Crash before binding"); };
  await value.engine.dispatch(chat);
  expect(value.coding.sent).toEqual([]);
  expect(value.journal.records()[0].phase).toBe("created");
  value.journal.bindThread = bind;
  const reloaded = new Engine(value.config, value.wire.api, value.coding, value.journal, {});
  running.push(reloaded);
  await reloaded.dispatch(chat);
  const sessionId = value.journal.thread("thread")!.agentId;
  await reloaded.dispatch({ kind: "chat", message: { ...chat.message, id: 21, sessionId, prompt: "Follow-up" } });
  expect(value.coding.sent.map((message) => message.id)).toEqual([sessionId, sessionId]);
});

test("an interrupted outcome transfer leaves the completed prior attempt recoverable", async () => {
  const value = setup();
  value.wire.api.report = async () => { throw new RequestError(503, "Offline"); };
  await value.engine.dispatch(value.task);
  const transaction = value.journal.putMany.bind(value.journal);
  value.journal.putMany = async () => { throw new StorageError("Crash during transfer"); };
  await value.engine.dispatch({ kind: "run", run: { ...value.task.run, attempts: 2 } });
  expect(value.journal.get(taskKey(value.config.serverUrl, value.task))?.phase).toBe("reporting");
  value.journal.putMany = transaction;
  value.wire.api.report = async (_id, result) => { value.wire.reports.push(result); };
  const reloaded = new Engine(value.config, value.wire.api, value.coding, value.journal, {});
  running.push(reloaded);
  await reloaded.dispatch({ kind: "run", run: { ...value.task.run, attempts: 3 } });
  expect(value.coding.sent).toHaveLength(1);
  expect(value.wire.reports[0]).toMatchObject({ status: "success", attempt: 3 });
});

test("a new attempt reuses a completed outcome even after the old lease report became uncertain", async () => {
  const value = setup();
  value.wire.api.report = async () => { throw new RequestError(503, "Offline"); };
  await value.engine.dispatch(value.task);
  value.wire.api.report = async () => { throw new RequestError(404, "Old lease rejected"); };
  await value.engine.retryReports();
  expect(value.journal.records()[0].phase).toBe("uncertain");
  value.wire.api.report = async (_id, result) => { value.wire.reports.push(result); };
  await value.engine.dispatch({ kind: "run", run: { ...value.task.run, attempts: 2 } });
  expect(value.coding.sent).toHaveLength(1);
  expect(value.wire.reports).toEqual([{ ...value.coding.result, attempt: 2 }]);
});

test.each(["missing", "archived"])("restart reports a %s session without attempting to cancel a nonexistent turn", async (condition) => {
  const value = setup();
  await value.engine.dispatch(value.task);
  const record = value.journal.records()[0];
  await value.journal.put({ ...record, phase: "running", result: undefined });
  if (condition === "missing") value.coding.sessions.delete(record.agentId);
  else value.coding.sessions.get(record.agentId)!.archived = true;
  value.wire.reports.length = 0;
  await value.engine.dispatch(value.task);
  expect(value.wire.reports[0]).toMatchObject({ status: "failed", error: "Paseo session is missing or archived" });
  expect(value.coding.sent).toHaveLength(1);
  expect(value.coding.canceled).toEqual([]);
});

test("explicit milestone transitions select the issue project's policy before the global column", async () => {
  const value = setup({ statusPolicy: { "tests-passed": 10 } });
  value.config.projects["2"].statusPolicy = { "tests-passed": 20 };
  const transitions: { issueId: number; columnId: number; evidence: string }[] = [];
  value.wire.api.transition = async (issueId, columnId, evidence) => { transitions.push({ issueId, columnId, evidence }); };
  await value.engine.dispatch(value.task);
  expect(transitions).toEqual([]);
  const key = taskKey(value.config.serverUrl, value.task);
  await value.engine.milestone(key, "tests-passed", "bun test: exit 0");
  expect(transitions).toEqual([{ issueId: 8, columnId: 20, evidence: "[Paseo: tests-passed]\nbun test: exit 0" }]);
  delete value.config.projects["2"].statusPolicy;
  await value.engine.milestone(key, "tests-passed", "Verified again");
  expect(transitions[1].columnId).toBe(10);
  await expect(value.engine.milestone(key, "issue-completed", "No completion evidence")).rejects.toThrow("Configure a target column");
  expect(transitions).toHaveLength(2);
});

test("a completed ticket report is not acceptance evidence or authorization to change the issue", async () => {
  const value = setup({ statusPolicy: { "tests-passed": 20, "issue-completed": 30 } });
  value.config.projects["2"].statusPolicy = { "issue-completed": 40 };
  value.coding.result = {
    status: "success",
    output: [
      "Outcome: Completed",
      "Changes: Implementation finished.",
      "Validation: All tests passed.",
      "Decisions and Discoveries: Ready for review.",
      "Remaining Work: None; the issue is fully completed.",
      "References: None.",
    ].join("\n"),
  };
  let transitions = 0;
  value.wire.api.transition = async () => { transitions++; };
  await value.engine.dispatch(value.task);
  const record = value.journal.get(taskKey(value.config.serverUrl, value.task))!;
  expect(record.phase).toBe("finished");
  expect(record.acceptance?.status).toBe("not-assessed");
  expect(transitions).toBe(0);
  expect(value.wire.reports[0]?.status).toBe("success");
  expect(value.coding.canceled).toEqual([]);
});

test("structured task intent replaces runner framing and persists plan, actual selection, and independent acceptance", async () => {
  const value = setup();
  value.task.run.prompt = "Opaque runner wrapper instructing MCP delivery";
  value.task.run.systemPrompt = "Complete upstream instructions\nKeep this exact operator rule.";
  value.wire.api.intent = async () => ({ version: 1, source: "smoke", projectId: "2", sourceRunId: 31, request: "Return only READY without tools", acceptance: { expectedOutput: "READY", noTools: true } });
  value.coding.result = { status: "success", output: "WRONG" };
  value.coding.evidence = { toolCallCount: 0, historyComplete: true };
  await value.engine.dispatch(value.task);
  const record = value.journal.records()[0];
  expect(record).toMatchObject({ phase: "finished", model: "code-model", modeId: "review", plan: { selection: { provider: "codex", model: "code-model", modeId: "review" }, sources: { provider: "project", model: "project", mode: "project" } }, acceptance: { status: "failed" } });
  expect(value.coding.sent[0].prompt).toContain("Return only READY without tools");
  expect(value.coding.sent[0].prompt).not.toContain("Opaque runner wrapper");
  expect(value.coding.created[0].systemPrompt.startsWith("Complete upstream instructions\nKeep this exact operator rule.\n")).toBe(true);
  expect(value.wire.reports[0]).toEqual({ status: "success", output: "WRONG", attempt: 1 });
});

test("safe settings changes do not interrupt or reroute an accepted execution", async () => {
  const value = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const issue = value.wire.api.issue;
  value.wire.api.issue = async (id) => { await gate; return issue(id); };
  const work = value.engine.dispatch(value.task);
  await until(() => value.wire.beats() > 0);
  value.engine.updateConfiguration({ ...value.config, automatic: false, executionTimeoutMs: 1, projects: { ...value.config.projects, "2": { ...value.config.projects["2"], model: "new-model", modeId: "plan" } } });
  release();
  await work;
  expect(value.journal.records()[0]).toMatchObject({ phase: "finished", model: "code-model", modeId: "review", result: { status: "success" } });
  expect(value.coding.canceled).toEqual([]);
  await value.engine.dispatch({ kind: "run", run: { ...value.task.run, id: 32 } });
  expect(value.coding.created[1].selection).toEqual({ provider: "codex", model: "new-model", modeId: "plan" });
});

test("pause stops claims while preserving the active lease and can resume", async () => {
  const value = setup({ automatic: true, maxConcurrent: 1, pollIntervalMs: 5 });
  let claims = 0;
  value.wire.api.claim = async () => ++claims === 1 ? value.task.run : null;
  value.coding.delay = 100;
  await value.engine.start();
  await until(() => value.coding.sent.length === 1);
  value.engine.setPaused(true);
  const beats = value.wire.beats();
  await sleep(25);
  expect(value.engine.runtime()).toMatchObject({ paused: true, claiming: false, active: 1 });
  expect(value.wire.beats()).toBeGreaterThan(beats);
  expect(value.coding.sessions.get(value.coding.sent[0].id)?.active).toBe(true);
  expect(value.coding.canceled).toEqual([]);
  await until(() => value.journal.records()[0]?.phase === "finished");
  value.engine.setPaused(false);
  await until(() => claims > 1);
  expect(value.engine.runtime().claiming).toBe(true);
});

test("stop cannot confirm cancellation while the native session or permission remains active", async () => {
  const value = setup();
  value.coding.delay = 1000;
  value.coding.cancel = async () => {};
  const work = value.engine.dispatch(value.task);
  await until(() => value.coding.sent.length === 1);
  value.coding.sessions.get(value.coding.sent[0].id)!.pendingPermissionCount = 1;
  expect(await value.engine.stopActive()).toBe(false);
  await work;
  expect(value.journal.records()[0]).toMatchObject({ phase: "uncertain", cancellation: "unconfirmed" });
  expect(value.wire.reports).toEqual([]);
  expect(value.coding.sessions.get(value.coding.sent[0].id)?.active).toBe(true);
});

test.each(["model", "mode", "unknown-default"])("chat refuses an incompatible %s without discarding its conversation", async (change) => {
  const value = setup({ chatProjects: { thread: "1" } });
  const chat: Task = { kind: "chat", message: { id: 20, threadId: "thread", prompt: "Initial", systemPrompt: "Rules", sessionId: null } };
  await value.engine.dispatch(chat);
  const first = value.journal.thread("thread")!.agentId;
  value.engine.updateConfiguration({ ...value.config, ...(change === "model" ? { defaultModel: "new-model" } : change === "mode" ? { defaultModeId: "plan" } : { defaultModel: "" }) });
  await value.engine.dispatch({ kind: "chat", message: { ...chat.message, id: 21, sessionId: first } });
  expect(value.coding.created).toHaveLength(1);
  expect(value.coding.sent).toHaveLength(1);
  expect(value.wire.reports.at(-1)?.status).toBe("failed");
  expect(value.journal.thread("thread")!.agentId).toBe(first);
});

test("connection draining waits for the durable result outbox without canceling coding", async () => {
  const value = setup();
  value.coding.delay = 35;
  let offline = true;
  value.wire.api.report = async () => { if (offline) throw new RequestError(503, "Offline"); };
  const work = value.engine.dispatch(value.task);
  await until(() => value.coding.sent.length === 1);
  let drained = false;
  const drain = value.engine.drain().then(() => { drained = true; });
  await work;
  expect(drained).toBe(false);
  expect(value.journal.records()[0].phase).toBe("reporting");
  expect(value.coding.canceled).toEqual([]);
  offline = false;
  await value.engine.retryReports();
  await drain;
  expect(value.journal.records()[0].phase).toBe("finished");
});

test("a claim resolving after stop starts is journaled without sending a native prompt", async () => {
  const value = setup({ automatic: true, maxConcurrent: 1 });
  let release!: (run: Run) => void;
  let claiming = false;
  value.wire.api.claim = async () => {
    claiming = true;
    return new Promise<Run>((resolve) => { release = resolve; });
  };
  await value.engine.start();
  await until(() => claiming);
  const stop = value.engine.stopActive();
  release(value.task.run);
  expect(await stop).toBe(true);
  expect(value.journal.records()[0]).toMatchObject({ phase: "finished", result: { status: "failed" } });
  expect(value.coding.sent).toEqual([]);
});

test.each(["model", "mode"])("a retry does not reuse a session whose actual %s changed", async (changed) => {
  const value = setup();
  await value.engine.dispatch(value.task);
  const first = value.coding.sent[0].id;
  value.coding.sessions.get(first)![changed === "model" ? "model" : "modeId"] = "externally-changed";
  await value.engine.dispatch({ kind: "run", run: { ...value.task.run, attempts: 2 } });
  expect(value.coding.created).toHaveLength(2);
  expect(value.coding.sent[1].id).not.toBe(first);
  expect(value.journal.records()[1]).toMatchObject({ phase: "finished", model: "code-model", modeId: "review" });
});

test("canceling a completed execution cannot discard its pending result delivery", async () => {
  const value = setup();
  value.wire.api.report = async () => { throw new RequestError(503, "Offline"); };
  await value.engine.dispatch(value.task);
  await expect(value.engine.cancel(taskKey(value.config.serverUrl, value.task))).rejects.toThrow("already has a durable outcome");
  expect(value.journal.records()[0]).toMatchObject({ phase: "reporting", result: { status: "success" } });
  value.wire.api.report = async (_id, result) => { value.wire.reports.push(result); };
  await value.engine.retryReports();
  expect(value.journal.records()[0].phase).toBe("finished");
  expect(value.coding.canceled).toEqual([]);
});

test("stopping a manual start during session creation prevents prompt acceptance", async () => {
  const value = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let creating = false;
  const create = value.coding.create.bind(value.coding);
  value.coding.create = async (input) => { creating = true; await gate; return create(input); };
  const work = value.engine.manual(await value.wire.api.issue(8), value.coding).catch(() => {});
  await until(() => creating);
  const stopped = value.engine.stopActive();
  release();
  await work;
  expect(await stopped).toBe(true);
  expect(value.journal.records()[0]).toMatchObject({ phase: "canceled", cancellation: "confirmed", model: "code-model" });
  expect(value.coding.sent).toEqual([]);
});

test("a canonical request ID admits one upstream run across concurrent dispatch and restart", async () => {
  const value = setup();
  const requestId = "e8c7e5f2-2dc5-4d9e-92d5-415ac5919051";
  value.wire.api.intent = async () => ({ version: 1, source: "smoke", projectId: "2", sourceRunId: 10, requestId, request: "Return READY", acceptance: { expectedOutput: "READY", noTools: true } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let blocked = false;
  const put = value.journal.put.bind(value.journal);
  value.journal.put = async (record) => {
    if (record.externalId === 31 && record.intent?.requestId && !blocked) { blocked = true; await gate; }
    await put(record);
  };
  const first = value.engine.dispatch(value.task);
  await until(() => blocked);
  await value.engine.dispatch({ kind: "run", run: { ...value.task.run, id: 32 } });
  expect(value.journal.records().find((record) => record.externalId === 32)).toMatchObject({
    phase: "finished", result: { status: "failed", error: "This execution request was already accepted by another upstream run; create a new request to run it again" },
  });
  release();
  await first;
  await value.engine.dispatch(value.task);
  const restarted = new Engine(value.config, value.wire.api, value.coding, value.journal, {});
  running.push(restarted);
  await restarted.dispatch({ kind: "run", run: { ...value.task.run, id: 33 } });
  expect(value.journal.records().find((record) => record.externalId === 33)?.result?.status).toBe("failed");
  expect(value.coding.sent).toHaveLength(1);
  expect(value.journal.records().find((record) => record.externalId === 31)).toMatchObject({ phase: "finished", intent: { requestId } });
});

test("recovery cannot start claims while native cancellation is unresolved", async () => {
  const value = setup({ automatic: true });
  await value.engine.dispatch(value.task);
  const record = value.journal.records()[0];
  await value.journal.put({ ...record, phase: "uncertain", result: undefined, cancellation: "unconfirmed" });
  value.coding.sessions.get(record.agentId)!.active = true;
  value.coding.cancel = async () => { throw new Error("Still active"); };
  let claims = 0;
  value.wire.api.claim = async () => { claims++; return null; };
  value.wire.api.claimChat = async () => { claims++; return null; };
  const recovered = new Engine(value.config, value.wire.api, value.coding, value.journal, {});
  running.push(recovered);
  await recovered.start();
  await sleep(10);
  expect(recovered.runtime()).toMatchObject({ claiming: false, active: 0 });
  expect(value.journal.get(record.key)).toMatchObject({ phase: "uncertain", cancellation: "unconfirmed" });
  expect(claims).toBe(0);
});

test("unchanged native defaults preserve the existing chat conversation", async () => {
  const value = setup({ defaultModel: "", defaultModeId: "", chatProjects: { thread: "1" } });
  const first: Task = { kind: "chat", message: { id: 120, threadId: "thread", prompt: "Initial context", systemPrompt: "Rules", sessionId: null } };
  await value.engine.dispatch(first);
  const agentId = value.coding.sent[0]!.id;
  await value.engine.dispatch({ kind: "chat", message: { ...first.message, id: 121, prompt: "Continue the same conversation", sessionId: agentId } });
  expect(value.coding.created).toHaveLength(1);
  expect(value.coding.sent.map((sent) => sent.id)).toEqual([agentId, agentId]);
  expect(value.journal.thread("thread")?.agentId).toBe(agentId);
});

test("uncertain cancellation keeps its lease until native stop is confirmed", async () => {
  const value = setup();
  value.coding.delay = 1000;
  value.coding.cancel = async () => {};
  const work = value.engine.dispatch(value.task);
  await until(() => value.coding.sent.length === 1);
  expect(await value.engine.stopActive()).toBe(false);
  await work;
  const beats = value.wire.beats();
  await sleep(15);
  await value.engine.retryReports();
  expect(value.wire.beats()).toBeGreaterThan(beats);
  expect(value.wire.reports).toEqual([]);
  const native = value.coding.sessions.get(value.coding.sent[0]!.id)!;
  native.active = false;
  await value.engine.retryReports();
  expect(value.journal.records()[0]).toMatchObject({ phase: "finished", cancellation: "confirmed", result: { status: "failed" } });
  expect(value.wire.reports).toHaveLength(1);
  expect(value.coding.sent).toHaveLength(1);
});

function smokeExecution() {
  const value = setup({ automatic: true });
  const id = "c2cb9991-d792-4801-a047-8bd3f614de60";
  const request: RerunRequest = { id, sourceKey: "issue:test:8", source: { kind: "issue", agentId: 3, actorId: "builder-user", username: "builder" }, executionActorId: "builder-user", serverUrl: value.config.serverUrl, issueId: 8, projectId: "2", operation: "smoke", state: "unknown", createdAt: 1, updatedAt: 1, commentId: null, runId: null, body: smokeComment("builder", id, { issueId: 8, projectId: "2", agentId: 3 }), planDigest: "reviewed", delivery: "browser" };
  value.journal.requests.set(id, request);
  const task = { kind: "run" as const, run: { ...value.task.run, trigger: "mention" as const } };
  const client = new Client({ url: value.config.serverUrl, apiKey: "execution-key", fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/me") return Response.json({ authenticated: true, user: { id: "builder-user", isAgent: true, username: "builder" } });
    if (url.pathname === "/agent-runs/claim" && init?.method === "POST") return Response.json({ run: task.run });
    if (url.pathname === "/projects/search") return Response.json({ items: [{ id: 2, key: "PRJ", name: "Project", ref: "team.PRJ" }], total: 1, page: 1, pageSize: 100 });
    if (url.pathname === "/agent-runs/queue") {
      const runId = Number(url.searchParams.get("runId"));
      return Response.json({ items: [{ id: runId, agentId: 3, username: "builder", projectRef: "team.PRJ", issueId: 8, sequenceNumber: 8, prompt: request.body, trigger: "mention", status: "pending", executionState: "running", attempts: 1, createdAt: "2026-10-25T00:00:00Z", nextAttemptAt: "2026-10-25T00:00:00Z" }], total: 1, page: 1, pageSize: 100 });
    }
    throw new Error(`Unexpected smoke execution request ${url.pathname}`);
  }) as typeof fetch });
  value.wire.api.intent = client.intent.bind(client);
  value.coding.result = { status: "success", output: "PASEO_IAP_SMOKE_OK" };
  value.coding.evidence = { toolCallCount: 0, historyComplete: true };
  return { ...value, task, request, client };
}

test("a first-run smoke follows the normal authoritative claim and intent path without prior sessions", async () => {
  const value = smokeExecution();
  expect(value.journal.records()).toEqual([]);
  const run = await value.client.claim();
  if (!run) throw new Error("Expected the smoke claim");
  await value.engine.dispatch({ kind: "run", run });
  expect(value.journal.records()[0]).toMatchObject({ phase: "finished", intent: { source: "smoke", sourceRunId: 31, requestId: value.request.id, acceptance: { expectedOutput: "PASEO_IAP_SMOKE_OK", noTools: true } }, acceptance: { status: "passed" } });
  expect(value.wire.reports).toEqual([{ status: "success", output: "PASEO_IAP_SMOKE_OK", attempt: 1 }]);
  expect(value.coding.sent).toHaveLength(1);
  expect(value.coding.sent[0]!.prompt).toContain("Reply exactly: PASEO_IAP_SMOKE_OK");
  expect(value.coding.sent[0]!.prompt).not.toContain("Implement the requested change");
});

test("a forged or untouched issue-smoke nonce cannot start native execution", async () => {
  for (const state of ["missing", "prepared", "dismissed"] as const) {
    const value = smokeExecution();
    if (state === "missing") value.journal.requests.clear();
    else value.journal.requests.set(value.request.id, { ...value.request, state });
    await value.engine.dispatch(value.task);
    expect(value.journal.records()[0]).toMatchObject({ phase: "finished", result: { status: "failed", error: "The issue-origin smoke request is not backed by a matching durable handed-off request for this actor, issue, and project" } });
    expect(value.coding.sent).toEqual([]);
  }
});

test("a recovered persisted first-run intent must still prove its durable handoff", async () => {
  const value = smokeExecution();
  const issue = await value.wire.api.issue(8);
  const intent = await value.client.intent(value.task.run, issue, undefined, (id) => value.journal.request(id));
  const key = taskKey(value.config.serverUrl, value.task);
  await value.journal.put({ key, kind: "run", serverUrl: value.config.serverUrl, externalId: 31, attempt: 1, issueId: 8, issueIdentifier: "PRJ-8", projectId: "2", agentId: "not-created", workspaceId: null, cwd: "", provider: "codex", phase: "preparing", createdAt: Date.now(), updatedAt: Date.now(), eventOffset: 0, task: value.task, intent });
  value.journal.requests.set(value.request.id, { ...value.request, state: "dismissed" });
  await value.engine.dispatch(value.task);
  expect(value.journal.get(key)).toMatchObject({ phase: "finished", result: { status: "failed", error: "The issue-origin smoke request is not backed by a matching durable handed-off request for this actor, issue, and project" } });
  expect(value.coding.created).toEqual([]);
});

test("duplicate first-run comments admit only one native execution across concurrent claims and restart", async () => {
  const value = smokeExecution();
  value.coding.delay = 20;
  await Promise.all([value.engine.dispatch(value.task), value.engine.dispatch({ kind: "run", run: { ...value.task.run, id: 32 } })]);
  const restarted = new Engine(value.config, value.wire.api, value.coding, value.journal, {});
  running.push(restarted);
  await restarted.dispatch({ kind: "run", run: { ...value.task.run, id: 33 } });
  expect(value.journal.records().filter((record) => record.result?.status === "success").map((record) => record.externalId)).toEqual([31]);
  expect(value.journal.records().find((record) => record.externalId === 33)).toMatchObject({ phase: "finished", result: { status: "failed", error: "This execution request was already accepted by another upstream run; create a new request to run it again" } });
  expect(value.coding.sent).toHaveLength(1);
});
