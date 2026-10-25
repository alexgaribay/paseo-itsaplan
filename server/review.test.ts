import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import type { Gateway, SessionSnapshot } from "./contracts";
import type { ExperienceContext } from "./experience";
import { Client, type UpstreamRun } from "./protocol";
import { markExecutionReviewed, reviewExecution } from "./review";
import { PrivateStorage } from "./storage";

let directory: string;
let storage: PrivateStorage;
let context: ExperienceContext;
let snapshot: SessionSnapshot | null;
let wire: ReviewClient;
let nativeWrites: number;
let upstreamWrites: number;
const key = "historical-run";

class ReviewClient extends Client {
  run: UpstreamRun | null = {
    id: 1, agentId: 9, username: "builder", projectId: "7", projectName: "Project", issueId: 21,
    issueIdentifier: "PRJ-21", prompt: "Original task", trigger: "mention", status: "failed", executionState: "failed",
    attempts: 1, createdAt: "2026-10-24T00:00:00Z", nextAttemptAt: "2026-10-24T00:00:00Z",
  };
  actor = { id: "bot-9", username: "builder", isAgent: true };
  agentDetails: Awaited<ReturnType<Client["agent"]>> = { id: 9, username: "builder", kind: "external", invocationUrl: null, delegationDelaySec: 0 };
  override async agent() { return this.agentDetails ? structuredClone(this.agentDetails) : null; }
  override async identity() { return { ...this.actor }; }
  override async getRun() { return this.run ? structuredClone(this.run) : null; }
}

function record(): SessionRecord {
  return {
    key, kind: "run", externalId: 1, attempt: 1, serverUrl: "https://review.example", issueId: 21,
    issueIdentifier: "PRJ-21", projectId: "7", agentId: "native-1", workspaceId: "workspace-1", cwd: "/configured",
    provider: "omp", phase: "uncertain", createdAt: 1, updatedAt: 2, eventOffset: 4,
    result: { status: "failed", error: "Result acknowledgment lost" },
  };
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-review-")));
  storage = new PrivateStorage(directory);
  await storage.initialize();
  await storage.put(record());
  await storage.setPaused(true);
  snapshot = { id: "native-1", workspaceId: "workspace-1", cwd: "/configured", provider: "omp", model: "model", modeId: "ask", pendingPermissionCount: 0, active: false, archived: true };
  nativeWrites = 0;
  upstreamWrites = 0;
  wire = new ReviewClient({ url: "https://review.example", apiKey: "fixture-key", fetch: Object.assign(async () => {
    upstreamWrites++;
    throw new Error("Review may not mutate upstream state");
  }, { preconnect: fetch.preconnect }) });
  const forbidden = async (): Promise<never> => { nativeWrites++; throw new Error("Review may not change native execution"); };
  const gateway: Gateway = {
    host: forbidden, catalog: forbidden, repositories: forbidden, select: forbidden, create: forbidden,
    send: forbidden, wait: forbidden, cancel: forbidden, close: async () => {},
    inspect: async () => snapshot,
  };
  context = {
    config: configSchema.parse({ serverUrl: "https://review.example" }), protocol: wire, gateway, storage,
    runtime: { claiming: false, paused: true, active: 0, reservations: 0, pendingConfiguration: false, lastPollAt: null },
    credentials: () => storage.secrets(), assertCurrent() {},
  };
});

afterEach(async () => {
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

test("comparison separates failed upstream outcome from unknown acknowledgment without writing state", async () => {
  const before = await readFile(join(directory, "sessions.json"), "utf8");
  const comparison = await reviewExecution(context, { key });
  expect(comparison).toMatchObject({ upstream: "failed", upstreamAttempt: 1, native: "archived", pendingPermissionCount: 0, delivery: "unknown", acceptance: "not-assessed", canMarkReviewed: true, reviewedAt: null });
  expect(await readFile(join(directory, "sessions.json"), "utf8")).toBe(before);
  expect({ nativeWrites, upstreamWrites }).toEqual({ nativeWrites: 0, upstreamWrites: 0 });
});

test("acknowledgment survives reload without clearing result, phase, pause or delivery uncertainty", async () => {
  const before = storage.get(key)!;
  const comparison = await reviewExecution(context, { key });
  const reviewed = await markExecutionReviewed(context, { key, fingerprint: comparison.fingerprint });
  if (reviewed.reviewedAt === null) throw new Error("Review acknowledgment was not persisted");
  expect(storage.get(key)).toEqual({ ...before, review: { reviewedAt: reviewed.reviewedAt, fingerprint: comparison.fingerprint, observation: expect.objectContaining({ upstream: "failed", native: "archived", delivery: "unknown", acceptance: "not-assessed" }) } });
  await storage.close();
  storage = new PrivateStorage(directory);
  await storage.initialize();
  context.storage = storage;
  const reloaded = await reviewExecution(context, { key });
  expect(reloaded).toMatchObject({ reviewedAt: reviewed.reviewedAt, fingerprint: comparison.fingerprint, delivery: "unknown", acceptance: "not-assessed" });
  expect(storage.paused()).toBe(true);
  expect({ nativeWrites, upstreamWrites }).toEqual({ nativeWrites: 0, upstreamWrites: 0 });
});

test.each(["missing-native", "native-error", "foreign-native", "active-native", "pending-approval", "unconfirmed-stop", "new-attempt", "queued", "running", "missing-run", "foreign-issue", "foreign-project", "foreign-actor", "foreign-agent-id", "internal-agent", "missing-agent", "push-agent", "personal-key", "inconsistent-terminal", "draining"])("review acknowledgment rejects %s evidence", async (condition) => {
  switch (condition) {
    case "missing-native": snapshot = null; break;
    case "native-error": context.gateway.inspect = async () => { throw new Error("Disconnected"); }; break;
    case "foreign-native": snapshot!.id = "other-native"; break;
    case "active-native": snapshot!.active = true; break;
    case "pending-approval": snapshot!.pendingPermissionCount = 1; break;
    case "unconfirmed-stop": await storage.update(key, current => ({ ...current, cancellation: "unconfirmed" })); break;
    case "new-attempt": wire.run!.attempts = 2; break;
    case "queued": wire.run!.status = "pending"; wire.run!.executionState = "queued"; break;
    case "running": wire.run!.status = "pending"; wire.run!.executionState = "running"; break;
    case "missing-run": wire.run = null; break;
    case "foreign-issue": wire.run!.issueId = 22; break;
    case "foreign-project": wire.run!.projectId = "8"; break;
    case "foreign-actor": wire.actor.username = "other-bot"; break;
    case "foreign-agent-id": wire.agentDetails!.id = 10; break;
    case "internal-agent": wire.agentDetails!.kind = "internal"; break;
    case "missing-agent": wire.agentDetails = null; break;
    case "push-agent": wire.agentDetails!.invocationUrl = "https://push.example/agent"; break;
    case "personal-key": wire.actor.isAgent = false; break;
    case "inconsistent-terminal": wire.run!.status = "pending"; break;
    case "draining": context.runtime.pendingConfiguration = true; break;
  }
  const comparison = await reviewExecution(context, { key });
  expect(comparison.canMarkReviewed).toBe(false);
  await expect(markExecutionReviewed(context, { key, fingerprint: comparison.fingerprint })).rejects.toThrow();
  expect(storage.get(key)?.review).toBeUndefined();
  expect(storage.get(key)?.phase).toBe("uncertain");
});

test("a comparison cannot acknowledge evidence after the native state changes", async () => {
  const comparison = await reviewExecution(context, { key });
  snapshot!.active = true;
  await expect(markExecutionReviewed(context, { key, fingerprint: comparison.fingerprint })).rejects.toThrow();
  expect(storage.get(key)?.review).toBeUndefined();
});

test("local execution changes queued during review commit win over acknowledgment", async () => {
  const comparison = await reviewExecution(context, { key });
  const update = storage.update.bind(storage);
  storage.update = async (recordKey, change) => {
    await update(recordKey, current => ({ ...current, cancellation: "unconfirmed", eventOffset: 5 }));
    await update(recordKey, change);
  };
  await expect(markExecutionReviewed(context, { key, fingerprint: comparison.fingerprint })).rejects.toThrow();
  expect(storage.get(key)).toMatchObject({ phase: "uncertain", cancellation: "unconfirmed", eventOffset: 5 });
  expect(storage.get(key)?.review).toBeUndefined();
});

test("a changed connection cannot acknowledge a historical execution", async () => {
  const comparison = await reviewExecution(context, { key });
  context.config.serverUrl = "https://different.example";
  await expect(markExecutionReviewed(context, { key, fingerprint: comparison.fingerprint })).rejects.toThrow();
  expect(storage.get(key)?.review).toBeUndefined();
});

test("historical review uses native metadata without requiring conversation access", async () => {
  context.gateway.inspect = async (_id, options) => {
    if (options?.includeHistory !== false) throw new Error("Conversation history unavailable");
    return snapshot;
  };
  expect(await reviewExecution(context, { key })).toMatchObject({ native: "archived", canMarkReviewed: true });
});
