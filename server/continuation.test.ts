import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configSchema, projectMappingSchema } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import type { Gateway, SessionSnapshot } from "./contracts";
import { assertContinuationGrant, assertSourceCurrent, assertSourceNative, captureProvenance, continuationScope, executionConfigDigest, sourceFacts } from "./continuation";
import { ConfigurationError } from "./errors";
import type { ExperienceContext } from "./experience";
import { makePlan, resolvePreferences } from "./plan";
import { Client, type UpstreamRun } from "./protocol";
import { prepareContinuation, reconcileRerun, recoverHandoff, submitRerun } from "./rerun";
import { PrivateStorage } from "./storage";
import { parseRequestComment } from "./task";

const execute = promisify(execFile);
const originalFetch = globalThis.fetch;
let directory: string;
let storage: PrivateStorage;
let context: ExperienceContext;
let protocol: ContinuationClient;
let native: SessionSnapshot | null;
let source: SessionRecord;
let posts: number;
let loseAck: boolean;
let nativeMutations: number;

class ContinuationClient extends Client {
  actor = "execution-actor";
  description = "Implement the requested behavior";
  source: UpstreamRun = { id: 11, agentId: 9, username: "worker", projectId: "7", projectName: "Project", issueId: 21, issueIdentifier: "TW-21", prompt: "Implement the requested behavior", trigger: "mention", status: "success", executionState: "success", attempts: 1, createdAt: "2026-10-25T00:00:00Z", nextAttemptAt: "2026-10-25T00:00:00Z" };
  items: UpstreamRun[] = [];
  override async identity() { return { id: this.actor, username: "worker", isAgent: true }; }
  override async issue(id: number) { return { id, projectId: 7, identifier: "TW-21", title: "Implementation task", description: this.description }; }
  override async issueSelection() { return {}; }
  override async queue() { return { items: structuredClone(this.items), complete: true }; }
  override async getRun(id: number) { return structuredClone(id === 11 ? this.source : this.items.find((item) => item.id === id) ?? null); }
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-continuation-")));
  await execute("git", ["init", "--initial-branch=main", directory]);
  storage = new PrivateStorage(join(directory, "private"));
  await storage.initialize();
  protocol = new ContinuationClient({ url: "https://plan.example", apiKey: "execution-key" });
  native = { id: "native-original", workspaceId: "workspace-original", cwd: directory, provider: "omp", model: "model", modeId: "ask", active: false, archived: false, pendingPermissionCount: 0, lastUserMessageAt: "2026-10-25T00:00:00Z" };
  nativeMutations = 0;
  posts = 0;
  loseAck = false;
  const gateway: Gateway = {
    host: async () => ({ id: "host", label: "Desktop" }), catalog: async () => [], repositories: async () => [],
    select: async (config, project, explicit) => resolvePreferences(config, project, explicit).selection,
    inspect: async () => native,
    create: async () => { nativeMutations++; throw new Error("A reviewed request never creates a native session directly"); },
    send: async () => { nativeMutations++; throw new Error("A reviewed request never sends directly"); },
    wait: async () => { throw new Error("A request never waits on a native turn"); },
    cancel: async () => { nativeMutations++; }, close: async () => {},
  };
  const config = configSchema.parse({ serverUrl: "https://plan.example", automatic: true, continuation: { enabled: true }, defaultProvider: "omp", defaultModel: "model", defaultModeId: "ask", projects: { "7": { repository: directory, automatic: true, worktree: false } } });
  context = { config, protocol, gateway, storage, credentials: () => storage.secrets(), assertCurrent() {}, runtime: { claiming: true, paused: false, active: 0, reservations: 0, pendingConfiguration: false, lastPollAt: null } };
  const issue = await protocol.issue(21);
  const intent = { version: 1 as const, source: "comment" as const, request: protocol.source.prompt, projectId: "7", sourceRunId: 11 };
  const selection = { provider: "omp", model: "model", modeId: "ask" };
  source = { key: "original", kind: "run", serverUrl: config.serverUrl, externalId: 11, attempt: 1, issueId: 21, issueIdentifier: "TW-21", projectId: "7", agentId: native.id, workspaceId: native.workspaceId, cwd: directory, provider: "omp", model: "model", modeId: "ask", phase: "finished", createdAt: 1, updatedAt: 2, eventOffset: 0, result: { status: "success", output: "Turn ended" }, evidence: { historyComplete: true, toolCallCount: 2 }, intent, taskIssue: issue, nativeLastUserMessageAt: native.lastUserMessageAt!, projectMapping: config.projects["7"], plan: makePlan(config, config.projects["7"]!, selection, { projectId: "7", issueId: 21, issueIdentifier: "TW-21", host: { id: "host", label: "Desktop" } }), task: { kind: "run", run: { id: 11, attempts: 1, trigger: "mention", prompt: "Runner framing for implementation", systemPrompt: "Follow project requirements", issueId: 21, issueIdentifier: "TW-21" } }, taskProvenance: captureProvenance(config, protocol.actor, intent, "Follow project requirements", issue) };
  await storage.put(source);
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/me") return Response.json({ authenticated: true, user: { id: "human-actor", isAgent: false, username: "operator" } });
    if (url.pathname === "/issues/21/comments" && init?.method === "POST") {
      posts++;
      expect(storage.requests()[0]).toMatchObject({ state: "submitting", continuation: { attestation: "same-task-unrestricted", executionActorId: "execution-actor" } });
      const { body } = JSON.parse(String(init.body)) as { body: string };
      protocol.items.push({ ...protocol.source, id: 12, status: "pending", executionState: "queued", prompt: body });
      if (loseAck) throw new Error("Acknowledgment lost");
      return Response.json({ id: 99 });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }, { preconnect: originalFetch.preconnect });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

test("changing the bot's named profile invalidates an existing continuation approval", async () => {
  context.config = { ...context.config, profileId: "different-worker" };
  await expect(assertSourceCurrent(context, source)).rejects.toThrow("configuration");
  expect(nativeMutations).toBe(0);
});

test("a changed named profile bundle invalidates continuation even when the binding id is unchanged", async () => {
  context.config = { ...context.config, profileId: "worker" };
  source.plan!.selection = { ...source.plan!.selection, profileId: "worker", profileName: "Worker", thinkingOptionId: "deep" };
  source.taskProvenance!.configDigest = executionConfigDigest(context.config, source.projectId, source.issueId!);
  await storage.put(source);
  context.gateway.select = async () => ({ ...source.plan!.selection, thinkingOptionId: "fast" });
  await expect(assertSourceCurrent(context, source)).rejects.toThrow("selection changed");
  expect(nativeMutations).toBe(0);
});

test("continuation requires observable matching thinking and feature settings", () => {
  source.plan!.selection = { ...source.plan!.selection, profileId: "worker", profileName: "Worker", thinkingOptionId: "deep", featureValues: { sandbox: true } };
  expect(() => assertSourceNative(source, native)).toThrow("cannot be verified");
  native = { ...native!, thinkingOptionId: "deep", featureValues: { sandbox: true } };
  assertSourceNative(source, native);
  expect(native).toMatchObject({ thinkingOptionId: "deep", featureValues: { sandbox: true } });
  expect(() => assertSourceNative(source, { ...native!, thinkingOptionId: "fast" })).toThrow("changed");
  expect(() => assertSourceNative(source, { ...native!, featureValues: { sandbox: false } })).toThrow("changed");
});

describe("reviewed continuation handoff", () => {
  test("requires human scope attestation over immutable source facts", async () => {
    const preview = await prepareContinuation(context, { key: source.key });
    expect(preview.operation).toBe("continue");
    expect(preview.continuationReview).toMatchObject({ task: "Implement the requested behavior", systemPrompt: "Follow project requirements", sourceAgentId: "native-original" });
    expect(preview.continuationReview!.requirements).toContain("Implementation task");
    expect(storage.requests()[0]!.continuation).toBeUndefined();
    await expect(submitRerun(context, preview)).rejects.toThrow("explicit human review");
    const handed = await submitRerun(context, { ...preview, attestContinuation: true });
    expect(handed.state).toBe("unknown");
    expect(parseRequestComment(handed.comment!, "worker")).toMatchObject({ requestId: preview.requestId, sourceRunId: 11, operation: "continue" });
    expect(storage.requests()[0]!.continuation).toMatchObject({ sourceKey: "original", sourceAgentId: "native-original", executionActorId: "execution-actor", requestId: preview.requestId });
    expect(posts).toBe(0);
    expect(nativeMutations).toBe(0);
  });

  test("reload recovers exactly the handed-off nonce and never transfers its grant", async () => {
    const preview = await prepareContinuation(context, { key: source.key });
    const first = await submitRerun(context, { ...preview, attestContinuation: true });
    if (first.comment === undefined) throw new Error("Expected a browser handoff receipt");
    const grant = storage.requests()[0]!.continuation;
    await storage.close();
    storage = new PrivateStorage(join(directory, "private"));
    await storage.initialize();
    context = { ...context, storage, credentials: () => storage.secrets() };
    await storage.saveSecrets({ requestApiKey: "new-human-key" });
    const recovered = await recoverHandoff(context, { requestId: preview.requestId });
    expect(recovered.comment).toBe(first.comment);
    expect(storage.requests()[0]!.continuation).toEqual(grant);
    await expect(prepareContinuation(context, { key: source.key })).rejects.toThrow("unknown delivery");
    expect((await submitRerun(context, { ...preview, attestContinuation: true })).state).toBe("unknown");
    expect(posts).toBe(0);
  });

  test("API acknowledgment loss keeps one grant and one request until authoritative recovery", async () => {
    await storage.saveSecrets({ requestApiKey: "human-key" });
    const preview = await prepareContinuation(context, { key: source.key });
    loseAck = true;
    expect((await submitRerun(context, { ...preview, attestContinuation: true })).state).toBe("unknown");
    const grant = storage.requests()[0]!.continuation;
    const recovered = await reconcileRerun(context, { requestId: preview.requestId });
    expect(recovered).toMatchObject({ state: "submitted", runId: 12, commentId: null });
    await submitRerun(context, { ...preview, attestContinuation: true });
    expect(posts).toBe(1);
    expect(storage.requests()).toHaveLength(1);
    expect(storage.requests()[0]!.continuation).toEqual(grant);
  });

  test.each(["disabled", "actor", "requirements", "config", "native", "expiry", "task"])("blocks %s changes after human review without handing off", async (change) => {
    const preview = await prepareContinuation(context, { key: source.key });
    if (change === "disabled") context.config.continuation = { enabled: false };
    if (change === "actor") protocol.actor = "other-actor";
    if (change === "requirements") protocol.description = "New requirements";
    if (change === "config") context.config.defaultModeId = "other-mode";
    if (change === "native") native!.active = true;
    if (change === "expiry") await storage.updateRequest(preview.requestId, (request) => ({ ...request, continuationScope: { ...request.continuationScope!, expiresAt: 1 } }));
    if (change === "task") protocol.source.prompt = "Different authoritative task";
    await expect(submitRerun(context, { ...preview, attestContinuation: true })).rejects.toThrow();
    expect(storage.requests()[0]!.state).toBe("prepared");
    expect(storage.requests()[0]!.continuation).toBeUndefined();
    expect(posts).toBe(0);
    expect(nativeMutations).toBe(0);
  });

  test.each(["smoke", "exact", "no-tools", "no-posting", "bounded", "failed", "uncertain", "unknown", "native-active", "native-missing", "native-archived"])("cannot attest away %s provenance", async (restriction) => {
    const text = restriction === "smoke" ? "Run an integration smoke test" : restriction === "exact" ? "Reply exactly OK" : restriction === "no-tools" ? "Do not use tools" : restriction === "no-posting" ? "Do not post comments" : restriction === "bounded" ? "Only inspect the source" : source.intent!.request;
    const intent = { ...source.intent!, request: text };
    source = { ...source, intent, taskProvenance: captureProvenance(context.config, protocol.actor, intent, "Follow project requirements", source.taskIssue!) };
    if (restriction === "failed") source.result = { status: "failed" };
    if (restriction === "uncertain") source.phase = "uncertain";
    if (restriction === "unknown") source.taskProvenance = undefined;
    if (restriction === "native-active") native!.active = true;
    if (restriction === "native-missing") native = null;
    if (restriction === "native-archived") native!.archived = true;
    await storage.put(source);
    await expect(prepareContinuation(context, { key: source.key })).rejects.toThrow();
    expect(storage.requests()).toEqual([]);
    expect(posts).toBe(0);
    expect(nativeMutations).toBe(0);
  });

  test("the source grant is bound to its nonce and immutable requirements", () => {
    const scope = continuationScope(source);
    const requestId = "8a96f7a3-4957-42cd-84ac-6f28e19ee89f";
    const grant = { ...scope, requestId, approvedAt: Date.now(), attestation: "same-task-unrestricted" as const };
    expect(() => assertContinuationGrant(source, grant, requestId)).not.toThrow();
    expect(() => assertContinuationGrant(source, grant, "other-request")).toThrow();
    expect(() => sourceFacts({ ...source, taskIssue: { ...source.taskIssue!, description: "Changed" } })).toThrow();
  });
});

test.each(["activityPrivacy", "executionTimeoutMs", "leaseSafetyMs"] as const)("a handed-off continuation rejects changed %s policy", async (field) => {
  const preview = await prepareContinuation(context, { key: source.key });
  await submitRerun(context, { ...preview, attestContinuation: true });
  context.config = field === "activityPrivacy"
    ? { ...context.config, activityPrivacy: "full" }
    : { ...context.config, [field]: context.config[field] + 1000 };
  await expect(assertSourceCurrent(context, storage.get(source.key)!)).rejects.toThrow();
  expect(nativeMutations).toBe(0);
  expect(posts).toBe(0);
});

test("a handed-off grant binds recorded execution limits and worktree association", async () => {
  const preview = await prepareContinuation(context, { key: source.key });
  await submitRerun(context, { ...preview, attestContinuation: true });
  const grant = storage.requests()[0]!.continuation!;
  for (const change of [
    { limits: { executionTimeoutMs: 900_000, leaseSafetyMs: 120_000 } },
    { branchName: "changed-worktree-association" },
  ]) expect(() => assertContinuationGrant({ ...source, ...change }, grant, grant.requestId)).toThrow();
  expect(nativeMutations).toBe(0);
  expect(posts).toBe(0);
});

test("an unsaved project admits a continuation while a later saved mapping invalidates provenance", async () => {
  delete context.config.projects["7"];
  protocol.repositories = async () => [{ id: 1, provider: "github", fullName: "acme/project", webUrl: "https://github.com/acme/project" }];
  context.gateway.repositories = async () => [{ paseoProjectId: "p1", name: "Project", repository: directory, common: directory, remotes: ["https://github.com/acme/project"] }];
  source = { ...source, taskProvenance: captureProvenance(context.config, protocol.actor, source.intent!, "Follow project requirements", source.taskIssue!) };
  await storage.put(source);
  await assertSourceCurrent(context, source);
  const preview = await prepareContinuation(context, { key: source.key });
  expect(preview.plan.repository).toBe(directory);
  const handed = await submitRerun(context, { ...preview, attestContinuation: true });
  expect({ state: handed.state, posts, nativeMutations }).toEqual({ state: "unknown", posts: 0, nativeMutations: 0 });
  context.config.projects["7"] = projectMappingSchema.parse({ repository: directory, automatic: false });
  await expect(assertSourceCurrent(context, source)).rejects.toBeInstanceOf(ConfigurationError);
});
