import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import { executionContextSchema } from "../shared/task-context";
import type { Gateway } from "./contracts";
import type { ExperienceContext } from "./experience";
import { ConfigurationError } from "./errors";
import { Client } from "./protocol";
import { selectedExecutionContext } from "./selected-context";
import { publicSession } from "./service";
import { PrivateStorage } from "./storage";
import { taskContextDigest } from "./task-context";

let directory: string;
let storage: PrivateStorage;
let context: ExperienceContext;
let projectId: number;
let denied: boolean;
let reads: string[];
const secret = "private-context-that-must-not-leave-the-journal";
const hash = "a".repeat(64);
const marker = "2833406f-a999-44db-aea3-48d722352e68";
const issue = { id: 42, projectId: 7, identifier: "TW-42", title: "Task", description: secret };

function record(): SessionRecord {
  const snapshot = { version: 1 as const, issueId: 42, projectId: 7, capturedAt: 1, text: secret, warnings: [], development: [], assets: [{ id: marker, filename: "image.png", mimeType: "image/png" as const, digest: hash }] };
  return {
    key: "run-1", kind: "run", externalId: 1, attempt: 1, serverUrl: "https://plan.test", issueId: 42,
    issueIdentifier: "TW-42", projectId: "7", agentId: "native-1", workspaceId: null, cwd: "/configured",
    provider: "omp", phase: "finished", createdAt: 1, updatedAt: 2, eventOffset: 0,
    result: { status: "success", output: "Turn finished" }, taskContext: { ...snapshot, digest: taskContextDigest(snapshot) },
    taskIssue: issue, task: { kind: "run", run: { id: 1, attempts: 1, prompt: secret, systemPrompt: secret, trigger: "delegation", issueId: 42, issueIdentifier: "TW-42" } },
    intent: { version: 1, source: "issue", request: secret, projectId: "7", sourceRunId: 1 },
    taskProvenance: { version: 1, actorId: secret, capturedAt: 1, taskDigest: hash, systemDigest: hash, requirementsDigest: hash, configDigest: hash, restrictions: [] },
    ticketReport: { marker, state: "prepared", commentId: null, updatedAt: 1, actorId: secret, scopeDigest: hash, digest: hash, body: secret, notes: secret, baseBody: null },
    ticketReportReceipt: { marker, state: "prepared", commentId: null, updatedAt: 1 },
  };
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "iap-selected-context-")));
  storage = new PrivateStorage(directory);
  await storage.initialize();
  await storage.put(record());
  projectId = 7;
  denied = false;
  reads = [];
  const protocol = new Client({ url: "https://plan.test", apiKey: "fixture-key", fetch: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    if (init?.method !== "GET") throw new Error("Context inspection must be read-only");
    if (denied) return Response.json({}, { status: 403 });
    if (path !== "/issues/42") throw new Error("Context inspection must not traverse documents or attachments");
    return Response.json({ ...issue, projectId, development: [{ id: 8, provider: "gitea", kind: "pull_request", title: "Parser change", state: "open", url: "https://forge.test/team/repo/pulls/8?token=private-token", sourceBranch: "TW-42-itsaplan-abc", targetBranch: "main" }] });
  }) as typeof fetch });
  const forbidden = async (): Promise<never> => { throw new Error("Context inspection must not execute native actions"); };
  const gateway: Gateway = { host: forbidden, catalog: forbidden, repositories: forbidden, select: forbidden, create: forbidden, send: forbidden, wait: forbidden, cancel: forbidden, inspect: forbidden, close: async () => {} };
  context = { config: configSchema.parse({ serverUrl: "https://plan.test" }), protocol, gateway, storage, runtime: { claiming: false, paused: true, active: 0, reservations: 0, pendingConfiguration: false, lastPollAt: null }, credentials: () => storage.secrets(), assertCurrent() {} };
});

afterEach(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });

test("execution overview never exposes captured task, report, provenance or future private fields", () => {
  const source = { ...record(), futurePrivateState: secret };
  const visible = publicSession(source);
  expect(visible).toMatchObject({ key: "run-1", agentId: "native-1", result: { status: "success", output: "Turn finished" }, ticketReportReceipt: { marker, state: "prepared" } });
  expect(JSON.stringify(visible)).not.toContain(secret);
  expect(visible).not.toHaveProperty("taskContext");
  expect(visible).not.toHaveProperty("futurePrivateState");
});

test("selected context exposes bounded metadata and sanitized links, never task text or image references", async () => {
  const result = executionContextSchema.parse(await selectedExecutionContext(context, "run-1"));
  expect(result.captured).toMatchObject({ textChars: secret.length, assetCount: 1 });
  expect(result.latest?.development).toMatchObject([{ id: 8, provider: "gitea", state: "open", url: null }]);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("private-token");
  expect(result.captured).not.toHaveProperty("assets");
});

test("denied current context is distinct from an empty development list and preserves captured facts", async () => {
  denied = true;
  const result = await selectedExecutionContext(context, "run-1");
  expect(result.latest).toBeNull();
  expect(result.warning).not.toBeNull();
  expect(result.captured).toMatchObject({ capturedAt: 1, assetCount: 1 });
});

test("moved issues and changed connections cannot silently reroute a historical execution", async () => {
  projectId = 8;
  await expect(selectedExecutionContext(context, "run-1")).rejects.toBeInstanceOf(ConfigurationError);
  reads = [];
  context.config = { ...context.config, serverUrl: "https://another.test" };
  await expect(selectedExecutionContext(context, "run-1")).rejects.toBeInstanceOf(ConfigurationError);
  expect(reads).toEqual([]);
});
