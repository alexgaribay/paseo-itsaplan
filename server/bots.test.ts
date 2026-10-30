import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { configSchema, defaults, type Config } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import type { Gateway, Secrets } from "./contracts";
import { BotRegistry } from "./bots";
import { atomicJson, PrivateStorage } from "./storage";
import { taskKey } from "./engine";
import { sessionMcp } from "./session-mcp";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function botsConfig(): Config {
  return { ...defaults(), bots: {
    default: { name: "Legacy", profileId: "profile-a", enabled: true },
    second: { name: "Second", profileId: "profile-b", enabled: true },
  } };
}

function record(key: string, agentId: string): SessionRecord {
  return { key, kind: "manual", serverUrl: "https://plan.example.com", externalId: 0, attempt: 0, issueId: 9, issueIdentifier: "PRJ-9", projectId: "1", agentId, workspaceId: "workspace", cwd: "/repo", provider: "omp", phase: "running", createdAt: 1, updatedAt: 1, eventOffset: 0 };
}

async function fixture(config = botsConfig(), connect?: (config: Config, secrets: Secrets) => Promise<Gateway>, before?: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-bots-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await before?.(directory);
  const settings: PluginSettings<typeof configSchema> = {
    read: async () => ({ status: "ready", revision: "fixture", values: structuredClone(config) }),
    subscribe: () => { throw new Error("The registry must not own the settings subscription"); },
  };
  const registry = new BotRegistry(directory, settings, connect);
  cleanups.push(() => registry.close());
  await registry.initialize();
  return { registry, directory, settings };
}

function upstream(identity = (key: string) => key) {
  const claims = new Map<string, Set<string>>();
  const { promise: polled, resolve: complete } = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const path = new URL(request.url).pathname;
    if (path === "/me") return Response.json({ authenticated: true, user: { id: identity(key), username: identity(key), isAgent: true } });
    if (path.endsWith("/claim")) {
      const paths = claims.get(key) ?? new Set<string>();
      paths.add(path);
      claims.set(key, paths);
      if (claims.size === 2 && [...claims.values()].every((value) => value.size === 2)) complete();
      return Response.json(path === "/agent-runs/claim" ? { run: null } : { message: null });
    }
    return new Response(null, { status: 204 });
  } });
  cleanups.push(async () => { await server.stop(true); });
  return { server, claims, polled };
}

function gateway(closed: string[], botId: string): Gateway {
  return {
    host: async () => ({ id: "host", label: "Host" }), catalog: async () => [], repositories: async () => [],
    select: async () => ({ provider: "omp", model: "model", modeId: "ask" }),
    create: async () => { throw new Error("A queue preview must not create an agent"); },
    inspect: async () => null, send: async () => { throw new Error("No work is queued"); },
    wait: async () => { throw new Error("No work is queued"); },
    cancel: async () => { throw new Error("Configuration must not cancel existing work"); },
    close: async () => { closed.push(botId); },
  };
}

test("legacy root credentials and history remain the default while other bots get independent journals and keys", async () => {
  const value = await fixture(botsConfig(), undefined, async (directory) => {
    const storage = new PrivateStorage(directory);
    await storage.initialize();
    await storage.saveSecrets({ apiKey: "legacy-key", mcpToken: "shared-mcp", paseoPassword: "shared-password", requestApiKey: "shared-human" });
    await storage.put(record("manual:legacy", "agent-a"));
    await storage.close();
  });
  const first = await value.registry.service();
  const second = await value.registry.service("second");
  await second.storage.put(record("manual:second", "agent-b"));
  expect(first.storage.directory).toBe(value.directory);
  expect(second.storage.directory).toBe(join(value.directory, "bots", "second"));
  expect((await first.status()).sessions.map((session) => session.key)).toEqual(["manual:legacy"]);
  expect((await second.status()).sessions.map((session) => session.key)).toEqual(["manual:second"]);
  expect(await second.storage.secrets()).toEqual({ mcpToken: "shared-mcp", paseoPassword: "shared-password", requestApiKey: "shared-human" });
  expect((await second.status()).credentialPresent).toBe(false);
  await value.registry.credentials("second", { apiKey: "second-key", mcpToken: "updated-mcp" });
  expect(await second.storage.secrets()).toEqual({ apiKey: "second-key", mcpToken: "updated-mcp", paseoPassword: "shared-password", requestApiKey: "shared-human" });
  expect(await first.storage.secrets()).toEqual({ apiKey: "legacy-key", mcpToken: "updated-mcp", paseoPassword: "shared-password", requestApiKey: "shared-human" });
  expect(JSON.parse(await readFile(join(second.storage.directory, "credentials.json"), "utf8"))).toEqual({ apiKey: "second-key" });
  expect(await second.status()).toMatchObject({ credentialPresent: true, mcpCredentialPresent: true, passwordPresent: true, requestCredentialPresent: true });
  await first.control("pause");
  expect(first.runtime().paused).toBe(true);
  expect(second.runtime().paused).toBe(false);
  await expect(value.registry.service("missing")).rejects.toThrow("Unknown bot");
  await expect(value.registry.credentials("missing", { apiKey: "wrong-key" })).rejects.toThrow("Unknown bot");
  expect((await first.storage.secrets()).apiKey).toBe("legacy-key");
});

test("session-open MCP is bound to its journaled agent and follows credential rotation", async () => {
  const config = botsConfig();
  config.mcp = { enabled: true, url: "https://plan.example.com/mcp", providers: ["omp"], preapprovedTools: [] };
  const { registry } = await fixture(config);
  const bot = await registry.service("second");
  await bot.storage.put({ ...record("bot:second:manual:one", "agent-b"), mcpLaunch: { url: config.mcp.url, provider: "omp" } });
  await registry.credentials("second", { mcpToken: "first-token" });
  const request: PluginBeforeRequests["agent.session_open"] = {
    agentId: "agent-b", workspaceId: "workspace", provider: "omp", cwd: "/repo",
    reason: "create", purpose: "interactive", title: null,
    labels: { "itsaplan.key": "bot:second:manual:one", "itsaplan.mcp-launch": "1" },
    env: {}, tools: [], mcpServers: {},
  };
  const open = (input = request) => sessionMcp(input, (agentId, key, provider) => registry.sessionMcp(agentId, key, provider));
  expect((await open())?.mcpServers.itsaplan).toEqual({ type: "http", url: config.mcp.url, headers: { Authorization: "Bearer first-token" } });
  expect(await open({ ...request, agentId: "other-agent" })).toBeUndefined();
  expect(await open({ ...request, provider: "other-provider" })).toBeUndefined();
  expect(await open({ ...request, purpose: "history" })).toBeUndefined();
  expect(await open({ ...request, labels: { "itsaplan.key": "bot:second:manual:one" } })).toBeUndefined();
  await registry.credentials("second", { mcpToken: "rotated-token" });
  expect((await open({ ...request, reason: "resume" }))?.mcpServers.itsaplan).toEqual({ type: "http", url: config.mcp.url, headers: { Authorization: "Bearer rotated-token" } });
  await registry.credentials("second", { mcpToken: "" });
  expect(await open({ ...request, reason: "refresh" })).toBeUndefined();
  await registry.credentials("second", { mcpToken: "another-token" });
  await registry.configure({ ...config, mcp: { ...config.mcp, url: "https://other.example/mcp" } });
  expect(await open()).toBeUndefined();
});

test("shared snapshots overlay profiles and enable flags without duplicating project mappings", async () => {
  const config = botsConfig();
  config.automatic = true;
  const value = await fixture(config);
  const first = await value.registry.service();
  const second = await value.registry.service("second");
  await second.storage.put(record("manual:active", "agent-b"));
  const next = structuredClone(config);
  next.bots.second!.enabled = false;
  next.defaultModel = "shared-model";
  await value.registry.configure(next);
  expect(first.configuration()).toMatchObject({ botId: "default", profileId: "profile-a", automatic: true, defaultModel: "shared-model" });
  expect(second.configuration()).toMatchObject({ botId: "second", profileId: "profile-b", automatic: false, defaultModel: "shared-model" });
  expect(second.storage.get("manual:active")?.phase).toBe("running");
  next.defaultModel = "mutated-after-save";
  expect(second.configuration().defaultModel).toBe("shared-model");
  await value.registry.turnEnded("agent-b", { kind: "completed" });
  expect(second.storage.get("manual:active")).toMatchObject({ phase: "finished", result: { status: "success" } });
});

test("removed bots stop claiming but retain turn outcomes and recover their private history across restart", async () => {
  const config = botsConfig();
  const value = await fixture(config);
  const second = await value.registry.service("second");
  await second.storage.put(record("manual:removed", "agent-b"));
  await value.registry.credentials("second", { apiKey: "second-key" });
  const removed = structuredClone(config);
  delete removed.bots.second;
  await value.registry.configure(removed);
  expect(second.configuration().automatic).toBe(false);
  await expect(value.registry.service("second")).rejects.toThrow("Unknown bot");
  await value.registry.turnEnded("agent-b", { kind: "completed" });
  expect(second.storage.get("manual:removed")).toMatchObject({ phase: "finished", result: { status: "success" } });
  await value.registry.close();
  const settings: PluginSettings<typeof configSchema> = { ...value.settings, read: async () => ({ status: "ready", revision: "fixture", values: removed }) };
  const reopened = new BotRegistry(value.directory, settings);
  cleanups.push(() => reopened.close());
  await reopened.initialize();
  await expect(reopened.service("second")).rejects.toThrow("Unknown bot");
  await reopened.configure(config);
  const restored = await reopened.service("second");
  expect((await restored.status()).sessions).toMatchObject([{ key: "manual:removed", phase: "finished", result: { status: "success" } }]);
  expect((await restored.storage.secrets()).apiKey).toBe("second-key");
});

test("duplicate keys and shared credentials that collide with any bot execution key are rejected before writes", async () => {
  const value = await fixture();
  await value.registry.credentials(undefined, { apiKey: "first-key", requestApiKey: "human-key" });
  await expect(value.registry.credentials("second", { apiKey: " first-key " })).rejects.toThrow("already registered");
  await value.registry.credentials("second", { apiKey: "second-key" });
  await expect(value.registry.credentials(undefined, { mcpToken: "second-key" })).rejects.toThrow("MCP must use a different");
  await expect(value.registry.credentials("second", { apiKey: "human-key" })).rejects.toThrow("separate human API credential");
  expect(await (await value.registry.service()).storage.secrets()).toEqual({ apiKey: "first-key", requestApiKey: "human-key" });
  expect((await (await value.registry.service("second")).storage.secrets()).apiKey).toBe("second-key");
});

test("two different keys for the same authenticated account cannot register two bots, even with automatic execution disabled", async () => {
  const remote = upstream(() => "same-account");
  const config = botsConfig();
  config.serverUrl = remote.server.url.origin;
  const value = await fixture(config);
  await value.registry.credentials(undefined, { apiKey: "first-key" });
  await expect(value.registry.credentials("second", { apiKey: "different-key" })).rejects.toThrow("already registered to another bot");
  expect((await (await value.registry.service()).status()).credentialPresent).toBe(true);
  expect((await (await value.registry.service("second")).status()).credentialPresent).toBe(false);
});

test("bot pollers use independent execution keys and profiles, and all owned connections close", async () => {
  const remote = upstream();
  const config = botsConfig();
  config.serverUrl = remote.server.url.origin;
  config.automatic = true;
  const connections: { botId: string; profileId: string; apiKey: string | undefined }[] = [];
  const closed: string[] = [];
  const value = await fixture(config, async (snapshot, secrets) => {
    connections.push({ botId: snapshot.botId, profileId: snapshot.profileId, apiKey: secrets.apiKey });
    return gateway(closed, snapshot.botId);
  });
  await value.registry.credentials(undefined, { apiKey: "first-key" });
  await value.registry.credentials("second", { apiKey: "second-key" });
  await remote.polled;
  expect([...remote.claims].map(([key, paths]) => [key, [...paths].sort()]).sort()).toEqual([
    ["first-key", ["/agent-chats/claim", "/agent-runs/claim"]],
    ["second-key", ["/agent-chats/claim", "/agent-runs/claim"]],
  ]);
  expect(connections).toEqual([
    { botId: "default", profileId: "profile-a", apiKey: "first-key" },
    { botId: "second", profileId: "profile-b", apiKey: "second-key" },
  ]);
  expect((await value.registry.service()).runtime().claiming).toBe(true);
  expect((await value.registry.service("second")).runtime().claiming).toBe(true);
  const disabled = structuredClone(config);
  disabled.bots.second!.enabled = false;
  await value.registry.configure(disabled);
  expect((await value.registry.service("second")).runtime().claiming).toBe(false);
  expect((await value.registry.service()).runtime().claiming).toBe(true);
  await value.registry.close();
  expect(closed.sort()).toEqual(["default", "second"]);
});

test("a removed bot recovers and delivers a pending result after restart without claiming new work", async () => {
  const { promise: delivered, resolve } = Promise.withResolvers<{ key: string | null; body: unknown }>();
  const claims: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/me") return Response.json({ authenticated: true, user: { id: "retired-agent", username: "retired-agent", isAgent: true } });
    if (path.endsWith("/claim")) claims.push(path);
    if (path === "/agent-runs/7/result") resolve({ key: request.headers.get("x-api-key"), body: await request.json() });
    return new Response(null, { status: 204 });
  } });
  cleanups.push(async () => { await server.stop(true); });
  const config = botsConfig();
  delete config.bots.second;
  config.serverUrl = server.url.origin;
  config.automatic = true;
  const task = { kind: "run" as const, run: { id: 7, attempts: 1, trigger: "delegation" as const, prompt: "Task", systemPrompt: "Rules", issueId: 9, issueIdentifier: "PRJ-9" } };
  const closed: string[] = [];
  const value = await fixture(config, async (snapshot) => gateway(closed, snapshot.botId), async (directory) => {
    const storage = new PrivateStorage(directory);
    await storage.initialize();
    await atomicJson(join(directory, "bots.json"), {
      default: config.bots.default,
      second: { name: "Retired bot", profileId: "profile-b", enabled: true },
    });
    await storage.close();
    const retired = new PrivateStorage(join(directory, "bots", "second"));
    await retired.initialize();
    await retired.saveSecrets({ apiKey: "retired-key" });
    await retired.put({ ...record(taskKey(config.serverUrl, task, "second"), "retired-session"), kind: "run", serverUrl: config.serverUrl, externalId: 7, attempt: 1, task, phase: "reporting", result: { status: "success", output: "Preserved result" } });
    await retired.close();
  });
  expect(await delivered).toEqual({ key: "retired-key", body: { status: "success", output: "Preserved result", attempt: 1 } });
  await expect(value.registry.service("second")).rejects.toThrow("Unknown bot");
  expect(claims).toEqual([]);
  await value.registry.close();
  expect(closed).toEqual(["second"]);
});
