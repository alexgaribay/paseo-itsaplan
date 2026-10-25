import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { configSchema, defaults, type Config } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import type { Gateway, Secrets, SessionSnapshot } from "./contracts";
import { IntegrationService } from "./service";
import { PrivateStorage } from "./storage";
import { setTimeout as sleep } from "node:timers/promises";

const cleanup: { service: IntegrationService; directory: string }[] = [];
afterEach(async () => {
  for (const { service, directory } of cleanup.splice(0)) {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(connect?: (config: Config, secrets: Secrets) => Promise<Gateway>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-manual-")));
  const storage = new PrivateStorage(directory);
  const settings: PluginSettings<typeof configSchema> = {
    read: async () => { throw new Error("Status must not load settings or connect to the external server"); },
    subscribe: () => { throw new Error("Status must not subscribe to settings"); },
  };
  const service = new IntegrationService(storage, settings, connect);
  cleanup.push({ service, directory });
  await service.status();
  const old = Date.now() - 61000;
  const record: SessionRecord = { key: "manual:one", kind: "manual", serverUrl: "https://plan.example.com", externalId: 0, attempt: 0, issueId: 9, issueIdentifier: "PRJ-9", projectId: "1", agentId: "agent-1", workspaceId: "workspace-1", cwd: "/configured", provider: "provider", phase: "running", createdAt: old, updatedAt: old, eventOffset: 0 };
  await storage.put(record);
  const snapshot: SessionSnapshot = { id: record.agentId, workspaceId: record.workspaceId, cwd: record.cwd, provider: record.provider, model: "actual-model", modeId: "ask", pendingPermissionCount: 0, active: false, archived: false };
  const gateway: Pick<Gateway, "inspect"> = { inspect: async () => snapshot };
  return { service, storage, record, snapshot, gateway };
}

test("a manual native turn still active after reload remains running", async () => {
  const value = await fixture();
  value.snapshot.active = true;
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0]).toMatchObject({ phase: "running", updatedAt: value.record.updatedAt });
  expect(state.sessions[0].result).toBeUndefined();
});

test("an idle manual session with a missed event is uncertain, never inferred successful", async () => {
  const value = await fixture();
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0]).toMatchObject({ phase: "uncertain", error: "Manual session is idle without an observed turn outcome; inspect native history before retrying" });
  expect(state.sessions[0].result).toBeUndefined();
  expect(value.storage.get(value.record.key)?.phase).toBe("uncertain");
});

test.each(["missing", "archived"])("a %s manual session is a persisted failure rather than stale active work", async (condition) => {
  const value = await fixture();
  value.gateway.inspect = async () => condition === "missing" ? null : { ...value.snapshot, archived: true };
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0]).toMatchObject({ phase: "finished", result: { status: "failed", error: "Manual Paseo session is missing or archived" } });
  expect(value.storage.get(value.record.key)?.phase).toBe("finished");
});

test("a recent in-flight manual send is not reconciled before acknowledgment can settle", async () => {
  const value = await fixture();
  await value.storage.put({ ...value.record, phase: "sending", updatedAt: Date.now() });
  value.gateway.inspect = async () => null;
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0].phase).toBe("sending");
  expect(state.sessions[0].error).toBeUndefined();
});

test("temporary native lookup failure cannot turn manual work into a missing session", async () => {
  const value = await fixture();
  value.gateway.inspect = async () => { throw new Error("Temporary disconnection"); };
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0]).toMatchObject({ phase: "running", updatedAt: value.record.updatedAt });
  expect(state.sessions[0].result).toBeUndefined();
});

test("an observed native completion wins over an older idle reconciliation snapshot", async () => {
  const value = await fixture();
  value.gateway.inspect = async () => {
    await value.service.turnEnded(value.record.agentId, { kind: "completed" });
    return value.snapshot;
  };
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0]).toMatchObject({ phase: "finished", result: { status: "success" } });
  expect(state.sessions[0].error).toBeUndefined();
});

test("an authenticated non-agent account blocks automatic execution without exposing its credentials or identity", async () => {
  const value = await fixture();
  await value.storage.saveSecrets({ apiKey: "private-fixture-api-key" });
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ authenticated: true, user: { id: "private-regular-account", isAgent: false } });
    },
  });
  try {
    await value.service.configure({ ...defaults(), serverUrl: server.url.origin, automatic: true, paseoUrl: "ws://127.0.0.1:1/ws" });
    const state = await value.service.status();
    expect(state.state).toBe("authentication-error");
    expect(requests).toEqual(["GET /me"]);
    expect(value.service.engine).toBeUndefined();
    expect(state.message).not.toContain("private-fixture-api-key");
    expect(state.message).not.toContain("private-regular-account");
  } finally {
    await value.service.close();
    await server.stop(true);
  }
});

test("pause survives service replacement and resume refuses globally disabled execution", async () => {
  const value = await fixture();
  await value.service.configure(defaults());
  const paused = await value.service.control("pause");
  expect(paused).toMatchObject({ ok: true, runtime: { paused: true, claiming: false } });
  expect(await value.service.control("resume")).toMatchObject({ ok: false, runtime: { paused: true } });
  await value.service.close();
  const reopened = new PrivateStorage(value.storage.directory);
  await reopened.initialize();
  expect(reopened.paused()).toBe(true);
  await reopened.close();
});

test("status exposes actual permissions and selection without transporting the original task", async () => {
  const value = await fixture();
  value.snapshot.active = true;
  value.snapshot.pendingPermissionCount = 2;
  await value.storage.put({ ...value.record, intent: { version: 1, source: "comment", request: "private original task", projectId: "1", sourceRunId: 1 },
    task: { kind: "run", run: { id: 1, attempts: 1, trigger: "mention", prompt: "private wrapper", systemPrompt: "private rules", issueId: 9, issueIdentifier: "PRJ-9" } },
    pendingEvents: [{ type: "RUN_ERROR", message: "private event" }] });
  const state = await value.service.status(value.gateway);
  expect(state.sessions[0]).toMatchObject({ phase: "running", model: "actual-model", modeId: "ask", pendingPermissionCount: 2 });
  expect(JSON.stringify(state)).not.toContain("private original task");
  expect(JSON.stringify(state)).not.toContain("private wrapper");
  expect(JSON.stringify(state)).not.toContain("private event");
});

test("safe settings retain the managed connection and connection changes drain instead of interrupting", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-drain-")));
  const storage = new PrivateStorage(directory);
  let connections = 0;
  let closes = 0;
  let native: SessionSnapshot | undefined;
  let finish!: () => void;
  const nativeTurn = new Promise<void>((resolve) => { finish = resolve; });
  const gateway: Gateway = {
    host: async () => ({ id: "host", label: "Host" }), catalog: async () => [], repositories: async () => [],
    select: async () => ({ provider: "omp", model: "model", modeId: "ask" }),
    create: async (input) => native = { id: input.agentId, workspaceId: null, cwd: input.project.repository, provider: "omp", model: "model", modeId: "ask", pendingPermissionCount: 0, active: false, archived: false },
    inspect: async () => native ?? null,
    send: async () => { native!.active = true; },
    wait: async (_id, _timeout, _text, signal) => {
      await Promise.race([nativeTurn, new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      native!.active = false;
      return { status: "success", output: "Complete" };
    },
    cancel: async () => { throw new Error("Settings must not cancel coding"); },
    close: async () => { closes++; },
  };
  const settings: PluginSettings<typeof configSchema> = { read: async () => { throw new Error("Unused"); }, subscribe: () => { throw new Error("Unused"); } };
  const service = new IntegrationService(storage, settings, async () => { connections++; return gateway; });
  cleanup.push({ service, directory });
  await service.status();
  await storage.saveSecrets({ apiKey: "first-key" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/me") return Response.json({ authenticated: true, user: { id: "bot", username: "bot", isAgent: true } });
    if (path === "/agent-runs/claim") return Response.json({ run: null });
    if (path === "/agent-chats/claim") return Response.json({ message: null });
    if (path === "/issues/9") return Response.json({ id: 9, projectId: 1, identifier: "PRJ-9", title: "Task", description: "Implement" });
    if (path === "/agent-runs/queue") return Response.json({ items: [{ id: 1, agentId: 2, username: "bot", projectRef: "ref", issueId: 9, sequenceNumber: 9, prompt: "Original", trigger: "delegation", status: "pending", executionState: "running", attempts: 1, createdAt: "2026-01-01T00:00:00Z", nextAttemptAt: "2026-01-01T00:00:00Z" }], total: 1, page: 1, pageSize: 100 });
    if (path === "/projects/search") return Response.json({ items: [{ id: 1, ref: "ref", key: "PRJ", name: "Project" }], total: 1, page: 1, pageSize: 100 });
    return new Response(null, { status: 204 });
  } });
  const config = { ...defaults(), serverUrl: server.url.origin, automatic: true, projects: { "1": { repository: "/configured", workspaceId: "", provider: "omp", model: "model", modeId: "ask", automatic: true, worktree: false, baseBranch: "" } } };
  try {
    await service.configure(config);
    const engine = service.engine!;
    const work = engine.dispatch({ kind: "run", run: { id: 1, attempts: 1, trigger: "delegation", prompt: "Framed", systemPrompt: "Rules", issueId: 9, issueIdentifier: "PRJ-9" } });
    for (let step = 0; step < 200 && !native?.active; step++) await sleep(2);
    expect(native?.active).toBe(true);
    await service.configure({ ...config, defaultModel: "future-model" });
    expect(service.engine).toBe(engine);
    expect({ connections, closes, nativeActive: native?.active }).toEqual({ connections: 1, closes: 0, nativeActive: true });
    await service.credentials({ apiKey: "replacement-key" });
    expect(service.runtime()).toMatchObject({ claiming: false, pendingConfiguration: true, active: 1 });
    expect({ connections, closes, nativeActive: native?.active }).toEqual({ connections: 1, closes: 0, nativeActive: true });
    finish();
    await work;
    for (let step = 0; step < 200 && service.runtime().pendingConfiguration; step++) await sleep(2);
    for (let step = 0; step < 200 && connections < 2; step++) await sleep(2);
    expect(storage.records()[0]).toMatchObject({ phase: "finished", result: { status: "success" }, model: "model", modeId: "ask" });
    expect(connections).toBe(2);
    expect(closes).toBe(1);
  } finally { finish(); await service.close(); await server.stop(true); }
});

test("stop persists an unconfirmed outcome when the native connection is unavailable", async () => {
  const value = await fixture(async () => { throw new Error("Native connection unavailable"); });
  await value.service.configure(defaults());
  expect(await value.service.control("stop")).toMatchObject({ ok: false, runtime: { paused: true, claiming: false } });
  expect(value.storage.get(value.record.key)).toMatchObject({ phase: "uncertain", cancellation: "unconfirmed" });
  expect(await value.service.control("resume")).toMatchObject({ ok: false, runtime: { paused: true } });
});

test("a connection change cannot pair a captured server URL with a later request configuration", async () => {
  const value = await fixture();
  await value.storage.saveSecrets({ apiKey: "test-bot-key" });
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ authenticated: true, user: { id: "first-bot", username: "first", isAgent: true } }) });
  const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ authenticated: true, user: { id: "second-bot", username: "second", isAgent: true } }) });
  try {
    await value.service.configure({ ...defaults(), serverUrl: first.url.origin });
    const config = value.service.configuration();
    expect(await (await value.service.protocol(config)).identity()).toEqual({ id: "first-bot", username: "first", isAgent: true });
    const pending = value.service.protocol(config);
    const changing = value.service.configure({ ...defaults(), serverUrl: second.url.origin });
    await expect(pending).rejects.toThrow();
    await changing;
    expect(await (await value.service.protocol()).identity()).toEqual({ id: "second-bot", username: "second", isAgent: true });
  } finally { await first.stop(true); await second.stop(true); }
});

test("request contexts retain a coherent credential snapshot and expire across connection changes", async () => {
  const value = await fixture();
  const requests: { server: string; key: string | null }[] = [];
  const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    requests.push({ server: "first", key: request.headers.get("x-api-key") });
    return Response.json({ authenticated: true, user: { id: "first-bot", username: "first", isAgent: true } });
  } });
  const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    requests.push({ server: "second", key: request.headers.get("x-api-key") });
    return Response.json({ authenticated: true, user: { id: "second-bot", username: "second", isAgent: true } });
  } });
  try {
    await value.storage.saveSecrets({ apiKey: "first-execution", requestApiKey: "first-human" });
    await value.service.configure({ ...defaults(), serverUrl: first.url.origin });
    const captured = await value.service.experience({} as PaseoApi);
    const pendingCredentials = captured.credentials();
    expect(await captured.protocol.identity()).toMatchObject({ id: "first-bot" });
    await value.service.credentials({ apiKey: "second-execution", requestApiKey: "second-human" });
    await value.service.configure({ ...defaults(), serverUrl: second.url.origin });
    expect(await pendingCredentials).toMatchObject({ apiKey: "first-execution", requestApiKey: "first-human" });
    expect(() => captured.assertCurrent()).toThrow();
    expect(() => captured.credentials()).toThrow();
    await expect(captured.protocol.identity()).rejects.toThrow();
    const current = await value.service.experience({} as PaseoApi);
    expect(await current.credentials()).toMatchObject({ apiKey: "second-execution", requestApiKey: "second-human" });
    expect(await current.protocol.identity()).toMatchObject({ id: "second-bot" });
    expect(requests).toEqual([{ server: "first", key: "first-execution" }, { server: "second", key: "second-execution" }]);
  } finally { await first.stop(true); await second.stop(true); }
});

test("a request snapshot interrupted during credential loading cannot bind new secrets to an old URL", async () => {
  const value = await fixture();
  await value.storage.saveSecrets({ apiKey: "old-execution", requestApiKey: "old-human" });
  await value.service.configure({ ...defaults(), serverUrl: "https://first.example" });
  const secrets = value.storage.secrets.bind(value.storage);
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const loading = new Promise<void>(resolve => { entered = resolve; });
  let firstRead = true;
  value.storage.secrets = async () => {
    if (firstRead) { firstRead = false; entered(); await blocked; }
    return secrets();
  };
  const preparing = value.service.experience({} as PaseoApi);
  await loading;
  try {
    await value.storage.saveSecrets({ apiKey: "new-execution", requestApiKey: "new-human" });
    await value.service.configure({ ...defaults(), serverUrl: "https://second.example" });
    release();
    await expect(preparing).rejects.toThrow();
    const current = await value.service.experience({} as PaseoApi);
    expect(current.config.serverUrl).toBe("https://second.example");
    expect(await current.credentials()).toMatchObject({ apiKey: "new-execution", requestApiKey: "new-human" });
  } finally { release(); }
});
