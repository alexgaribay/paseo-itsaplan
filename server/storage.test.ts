import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaults, configSchema, httpUrl } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import { PrivateStorage } from "./storage";
import type { RerunRequest } from "../shared/experience";

const directories: string[] = [];
const stores: PrivateStorage[] = [];
afterEach(async () => {
  for (const storage of stores.splice(0)) await storage.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function store() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-itsaplan-test-")));
  directories.push(directory);
  const storage = new PrivateStorage(directory);
  await storage.initialize();
  stores.push(storage);
  return storage;
}
function record(key: string): SessionRecord {
  return { key, kind: "run", serverUrl: "https://plan.example", externalId: 10, attempt: 1, issueId: 5, issueIdentifier: "PLAN-5", projectId: "2", agentId: "agent-id", workspaceId: "workspace-id", cwd: "/configured/repository", provider: "omp", phase: "running", eventOffset: 4, createdAt: 1, updatedAt: 2 };
}

test("associations, attempt state and thread routing survive plugin restart", async () => {
  const first = await store();
  await first.put(record("run:10:1"));
  await first.bindThread("chat:thread", { agentId: "agent-id", projectId: "2" });
  await first.close();
  const second = new PrivateStorage(first.directory);
  stores.push(second);
  await second.initialize();
  expect(second.get("run:10:1")).toEqual(record("run:10:1"));
  expect(second.thread("chat:thread")).toEqual({ agentId: "agent-id", projectId: "2" });
  const result = second.get("run:10:1")!;
  result.phase = "finished";
  expect(second.get("run:10:1")?.phase).toBe("running");
});

test("concurrent state commits do not lose another execution association", async () => {
  const storage = await store();
  await Promise.all([storage.put(record("first")), storage.put(record("second")), storage.bindThread("thread", { agentId: "agent", projectId: "2" })]);
  const persisted = JSON.parse(await readFile(join(storage.directory, "sessions.json"), "utf8"));
  expect(Object.keys(persisted.records).sort()).toEqual(["first", "second"]);
  expect(persisted.threads.thread).toEqual({ agentId: "agent", projectId: "2" });
});

test("credentials stay separate, private and replaceable without changing other secrets", async () => {
  const storage = await store();
  await storage.saveSecrets({ apiKey: "execution-key", mcpToken: "different-mcp-key" });
  await storage.saveSecrets({ paseoPassword: "daemon-password" });
  await storage.saveSecrets({ apiKey: "" });
  expect(await storage.secrets()).toEqual({ mcpToken: "different-mcp-key", paseoPassword: "daemon-password" });
  expect((await stat(join(storage.directory, "credentials.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(storage.directory)).mode & 0o777).toBe(0o700);
  await storage.put(record("run"));
  expect(await readFile(join(storage.directory, "sessions.json"), "utf8")).not.toContain("different-mcp-key");
});

test("corrupt persisted data is preserved rather than reset into duplicate execution", async () => {
  const storage = await store();
  await storage.close();
  const path = join(storage.directory, "sessions.json");
  await writeFile(path, "{broken journal");
  const reload = new PrivateStorage(storage.directory);
  stores.push(reload);
  await expect(reload.initialize()).rejects.toThrow("preserved");
  expect(await readFile(path, "utf8")).toBe("{broken journal");
});

test("a second backend cannot own the same execution journal", async () => {
  const first = await store();
  const competing = new PrivateStorage(first.directory);
  await expect(competing.initialize()).rejects.toThrow("Another integration backend");
});

test("credential reads refuse symlink replacement", async () => {
  const storage = await store();
  await writeFile(join(storage.directory, "other.json"), JSON.stringify({ apiKey: "hidden" }));
  await symlink(join(storage.directory, "other.json"), join(storage.directory, "credentials.json"));
  await expect(storage.secrets()).rejects.toThrow("preserved");
});

test("configuration rejects credential-bearing URLs and unsafe execution limits", () => {
  expect(httpUrl.safeParse("https://user:password@plan.example").success).toBe(false);
  expect(httpUrl.safeParse("http://remote.example").success).toBe(false);
  expect(httpUrl.safeParse("https://plan.example?key=secret").success).toBe(false);
  expect(httpUrl.parse("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  expect(configSchema.safeParse({ maxConcurrent: 0 }).success).toBe(false);
  expect(configSchema.safeParse({ pollIntervalMs: 999 }).success).toBe(false);
  expect(configSchema.safeParse({ paseoUrl: "ws://user:secret@localhost/ws" }).success).toBe(false);
  expect(configSchema.safeParse({ paseoUrl: "file:///repo" }).success).toBe(false);
  expect(configSchema.parse({ serverUrl: "https://plan.example/" }).serverUrl).toBe("https://plan.example");
  expect(defaults().automatic).toBe(false);
  expect(defaults().projects).toEqual({});
});

test("legacy custom host overrides survive migration while defaults use discovery", () => {
  expect(configSchema.parse({ paseoUrl: "wss://paseo.example/ws" }).paseoConnectionMode).toBe("manual");
  expect(configSchema.parse({ paseoUrl: "ws://100.64.1.2:6767/ws" }).paseoConnectionMode).toBe("manual");
  expect(configSchema.parse({ paseoUrl: "ws://127.0.0.1:6767/ws" }).paseoConnectionMode).toBe("auto");
  expect(configSchema.parse({ paseoConnectionMode: "auto", paseoUrl: "wss://paseo.example/ws" }).paseoConnectionMode).toBe("auto");
  expect(configSchema.safeParse({ paseoConnectionMode: "manual" }).success).toBe(false);
  expect(configSchema.parse({ projects: { "1": { automatic: true } } }).projects["1"]?.repository).toBe("");
});

test("simultaneous stale-PID recovery admits exactly one replacement journal owner", async () => {
  const first = await store();
  await first.close();
  const lock = join(first.directory, "backend.lock");
  await mkdir(lock);
  await writeFile(join(lock, `owner-99999999-${randomUUID()}`), "");
  const contenders = [new PrivateStorage(first.directory), new PrivateStorage(first.directory)];
  stores.push(...contenders);
  const outcomes = await Promise.allSettled(contenders.map((storage) => storage.initialize()));
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  const winner = contenders[outcomes.findIndex((result) => result.status === "fulfilled")];
  await winner.put(record("recovered"));
  expect(winner.get("recovered")?.phase).toBe("running");
});

test("concurrent credential replacement cannot resurrect a cleared execution key", async () => {
  const storage = await store();
  await storage.saveSecrets({ apiKey: "execution-key", mcpToken: "mcp-key" });
  await Promise.all([storage.saveSecrets({ apiKey: "" }), storage.saveSecrets({ paseoPassword: "new-password" })]);
  expect(await storage.secrets()).toEqual({ mcpToken: "mcp-key", paseoPassword: "new-password" });
});

test("effective HTTP credentials cannot be reused for optional coding-agent MCP", async () => {
  const storage = await store();
  await expect(storage.saveSecrets({ apiKey: "same-key ", mcpToken: " same-key" })).rejects.toThrow("different credential");
  expect(await storage.secrets()).toEqual({});
  await storage.saveSecrets({ apiKey: " execution-key " });
  expect(await storage.secrets()).toEqual({ apiKey: "execution-key" });
});

test("a shutdown update queued behind a successful commit cannot overwrite the completed outcome", async () => {
  const storage = await store();
  const active = record("completion-race");
  await storage.put(active);
  const completing = storage.put({ ...active, phase: "reporting", result: { status: "success", output: "Completed before shutdown" } });
  const stopping = storage.update(active.key, (current) => current.phase === "reporting" && current.result ? undefined :
    { ...current, phase: "reporting", result: { status: "failed", error: "Shutdown" } });
  await Promise.all([completing, stopping]);
  expect(storage.get(active.key)?.result).toEqual({ status: "success", output: "Completed before shutdown" });
});

test("paused claiming and uncertain request delivery survive restart alongside concurrent session commits", async () => {
  const first = await store();
  const request: RerunRequest = {
    id: "a4d50be5-f7da-411b-a086-2b7f3ab0dff1", sourceKey: "run:10:1", serverUrl: "https://plan.example", issueId: 5, projectId: "2",
    operation: "rerun", state: "submitting", createdAt: 1, updatedAt: 2, commentId: null, runId: null,
    body: "Explicit request metadata", planDigest: "plan-version", delivery: "api",
  };
  await Promise.all([first.put(record("run:10:1")), first.setPaused(true), first.putRequest(request)]);
  await first.updateRequest(request.id, (current) => ({ ...current, state: "unknown" }));
  await first.close();
  const reloaded = new PrivateStorage(first.directory);
  stores.push(reloaded);
  await reloaded.initialize();
  expect(reloaded.paused()).toBe(true);
  expect(reloaded.request(request.id)).toMatchObject({ state: "unknown", delivery: "api", commentId: null });
  expect(reloaded.get("run:10:1")?.phase).toBe("running");
  const copy = reloaded.request(request.id)!;
  copy.state = "failed";
  expect(reloaded.request(request.id)?.state).toBe("unknown");
});

test("legacy execution journals retain associations when new controls are first persisted", async () => {
  const first = await store();
  await first.close();
  await writeFile(join(first.directory, "sessions.json"), JSON.stringify({ version: 1, records: { original: record("original") }, threads: {} }));
  const reloaded = new PrivateStorage(first.directory);
  stores.push(reloaded);
  await reloaded.initialize();
  await reloaded.setPaused(true);
  expect(reloaded.get("original")).toEqual(record("original"));
  const persisted = JSON.parse(await readFile(join(first.directory, "sessions.json"), "utf8")) as { paused: boolean; records: Record<string, SessionRecord> };
  expect(persisted.paused).toBe(true);
  expect(persisted.records.original?.agentId).toBe("agent-id");
});

test("human rerun credentials cannot become agent execution or MCP credentials", async () => {
  const storage = await store();
  await storage.saveSecrets({ requestApiKey: "human-key", apiKey: "bot-key", mcpToken: "mcp-key" });
  await expect(storage.saveSecrets({ apiKey: "human-key" })).rejects.toThrow("separate human");
  await expect(storage.saveSecrets({ mcpToken: " human-key " })).rejects.toThrow("separate human");
  await expect(storage.saveSecrets({ requestApiKey: "bot-key" })).rejects.toThrow("separate human");
  expect(await storage.secrets()).toMatchObject({ requestApiKey: "human-key", apiKey: "bot-key", mcpToken: "mcp-key" });
});

test("closed storage cannot overwrite the replacement backend's journal", async () => {
  const previous = await store();
  await previous.put(record("old-owner"));
  await previous.close();
  const current = new PrivateStorage(previous.directory);
  stores.push(current);
  await current.initialize();
  await current.put(record("new-owner"));
  await expect(previous.put(record("late-callback"))).rejects.toThrow();
  await expect(previous.saveSecrets({ apiKey: "late-key" })).rejects.toThrow();
  const persisted = JSON.parse(await readFile(join(previous.directory, "sessions.json"), "utf8")) as { records: Record<string, SessionRecord> };
  expect(persisted.records["new-owner"]?.agentId).toBe("agent-id");
  expect(persisted.records["late-callback"]).toBeUndefined();
});
