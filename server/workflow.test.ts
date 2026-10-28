import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configSchema, projectMappingSchema } from "../shared/config";
import type { Issue, Result, Run, SessionRecord } from "../shared/models";
import type { Gateway, Protocol, SessionSnapshot } from "./contracts";
import { Engine } from "./engine";
import { RequestError } from "./protocol";
import { StorageError } from "./errors";
import { PrivateStorage } from "./storage";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { failingCheck?: boolean; outcome?: "completed" | "partial"; denyDone?: boolean; loseDoneAck?: "applied" | "unreadable"; review?: boolean; restriction?: string } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-lifecycle-")));
  const root = join(directory, "repo");
  const remote = join(directory, "remote.git");
  const git = async (...args: string[]) => (await execute("git", ["-C", root, ...args])).stdout.trim();
  await execute("git", ["init", "--bare", "--initial-branch=main", remote]);
  await execute("git", ["init", "--initial-branch=main", root]);
  await git("config", "user.name", "Workflow fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "value.txt"), "old\n");
  await writeFile(join(root, "verify.cjs"), `require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt', 'utf8'), ${JSON.stringify(options.failingCheck ? "not-the-implemented-value\n" : "new\n")});\n`);
  await git("add", "value.txt", "verify.cjs");
  await git("commit", "-m", "Initial fixture");
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  const before = await git("rev-parse", "main");
  const remoteHead = async () => (await execute("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
  const issue: Issue = { id: 8, projectId: 2, identifier: "PROJ-8", title: "Implement the new value", description: `Change value.txt to new and verify it.${options.restriction ? ` ${options.restriction}` : ""}`, columnId: 1, delegateUserId: "fixture-agent" };
  const run: Run = { id: 31, attempts: 1, trigger: "delegation", prompt: "Delegated issue", systemPrompt: "Implement the issue requirements", issueId: 8, issueIdentifier: "PROJ-8" };
  const reports: Result[] = [];
  const columns: number[] = [];
  const comments: string[] = [];
  const native = new Map<string, SessionSnapshot>();
  const sends: string[] = [];
  let issueStateAtStart: number | null | undefined;
  let afterCoding: (() => void | Promise<void>) | undefined;
  let protocolStatus: "pending" | "success" | "failed" = "pending";
  let issueReadsBlocked = false;
  const protocol: Protocol = {
    claim: async () => null, claimChat: async () => null,
    heartbeat: async () => {}, report: async (_id, result) => { reports.push(result); protocolStatus = result.status; },
    runEvents: async () => {}, chatHeartbeat: async () => false, chatEvents: async () => false, chatResult: async () => {},
    projects: async () => [{ id: 2, key: "PROJ", name: "Project" }], repositories: async () => [],
    issue: async () => {
      if (issueReadsBlocked) throw new RequestError(0, "Fixture issue read unavailable");
      return { ...issue };
    },
    intent: async () => ({ version: 1, source: "issue", request: issue.description!, projectId: "2", sourceRunId: 31 }),
    identity: async () => ({ id: "fixture-agent", username: "fixture", isAgent: true }),
    getRun: async () => ({ id: 31, agentId: 9, username: "fixture", projectId: "2", projectName: "Project", issueId: 8, issueIdentifier: "PROJ-8", prompt: "Delegated issue", trigger: "delegation", status: protocolStatus, executionState: protocolStatus === "pending" ? "running" : protocolStatus, attempts: run.attempts, createdAt: new Date().toISOString(), nextAttemptAt: new Date().toISOString() }),
    context: async () => { throw new Error("No optional context in this fixture"); },
    issueSelection: async () => ({}), search: async () => [], transition: async () => { throw new Error("Manual milestones are not the automatic path"); }, test: async () => {},
    columns: async () => [{ id: 1, projectId: 2, name: "Todo", stateType: "unstarted", position: 1 }, { id: 2, projectId: 2, name: "In Progress", stateType: "started", position: 2 }, { id: 3, projectId: 2, name: "Done", stateType: "completed", position: 3 }],
    setColumn: async (_id, columnId) => {
      if (columnId === 3 && options.denyDone) throw new RequestError(403, "Fixture denies Done");
      if (columnId === 3) expect(await remoteHead()).not.toBe(before);
      issue.columnId = columnId;
      columns.push(columnId);
      if (columnId === 3 && options.loseDoneAck) {
        issueReadsBlocked = options.loseDoneAck === "unreadable";
        throw new RequestError(0, "Fixture lost the Done acknowledgment");
      }
    },
    workflowComment: async (_id, _marker, body, allowCreate) => {
      const index = comments.indexOf(body);
      if (index >= 0) return { id: index + 1 };
      if (!allowCreate) return null;
      comments.push(body);
      return { id: comments.length };
    },
  };
  const gateway: Gateway = {
    host: async () => ({ id: "fixture-host", label: "Fixture" }), catalog: async () => [], repositories: async () => [],
    select: async () => ({ provider: "fixture", model: "fixture-model", modeId: "write" }),
    create: async (input) => {
      const cwd = join(directory, `task-${native.size + 1}`);
      await git("worktree", "add", "-b", input.branchName!, cwd, "main");
      const session: SessionSnapshot = { id: input.agentId, workspaceId: `workspace-${native.size + 1}`, cwd, provider: "fixture", model: "fixture-model", modeId: "write", active: false, archived: false, pendingPermissionCount: 0, lastUserMessageAt: null };
      native.set(input.agentId, session);
      return { ...session };
    },
    inspect: async (id) => { const session = native.get(id); return session ? { ...session } : null; },
    send: async (id, prompt, _key, _context, admission) => {
      admission?.onDispatch();
      issueStateAtStart = issue.columnId;
      sends.push(prompt);
      Object.assign(native.get(id)!, { active: true, lastUserMessageAt: new Date().toISOString() });
    },
    wait: async (id, _timeout, _onText, signal) => {
      signal.throwIfAborted();
      await writeFile(join(native.get(id)!.cwd, "value.txt"), "new\n");
      native.get(id)!.active = false;
      await afterCoding?.();
      return { status: "success", output: `Outcome: ${options.outcome === "partial" ? "Partially completed" : "Completed"}\n\n\`\`\`paseo-workflow\n${JSON.stringify({ version: 1, outcome: options.outcome ?? "completed" })}\n\`\`\``, evidence: { toolCallCount: 1, historyComplete: true } };
    },
    cancel: async (id) => { const session = native.get(id); if (session) session.active = false; }, close: async () => {},
  };
  const config = configSchema.parse({ serverUrl: "http://127.0.0.1:9876", automatic: true, workflow: { ...(options.review ? { mode: "review" } : {}), checks: [[process.execPath, "verify.cjs"]] }, projects: { "2": projectMappingSchema.parse({ repository: root, worktree: true, baseBranch: "main" }) } });
  const storage = new PrivateStorage(join(directory, "journal"));
  await storage.initialize();
  const engine = new Engine(config, protocol, gateway, storage, {}, { heartbeatMs: 50, flushMs: 20 });
  const value = { directory, root, remote, git, before, remoteHead, issue, reports, columns, comments, sends, native, config, protocol, gateway, storage, engine, engines: [engine], task: { kind: "run", run } as const, issueStateAtStart: () => issueStateAtStart, afterCoding: (callback: () => void | Promise<void>) => { afterCoding = callback; } };
  cleanups.push(async () => {
    await Promise.all(value.engines.map((entry) => entry.stop()));
    await value.storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return value;
}

test("a delegated implementation reaches Done only after its real checks and remote main integration", async () => {
  const value = await fixture();
  await value.engine.dispatch(value.task);
  expect(value.issueStateAtStart()).toBe(2);
  expect(value.columns).toEqual([2, 3]);
  const record = value.storage.records()[0]!;
  expect(record.workflow?.stage).toBe("completed");
  expect(record.phase).toBe("finished");
  expect(value.reports[0]?.status).toBe("success");
  expect(await value.remoteHead()).toBe(record.workflow!.integratedCommit!);
  expect(await value.git("rev-parse", "main")).toBe(record.workflow!.integratedCommit!);
  expect(await readFile(join(value.root, "value.txt"), "utf8")).toBe("new\n");
  expect(record.workflow!.checks.every((check) => check.exitCode === 0)).toBe(true);
  expect(record.workflow!.checks.some((check) => check.commit === record.workflow!.integratedCommit)).toBe(true);
});

test("a successful agent assertion cannot complete an issue when the actual check fails", async () => {
  const value = await fixture({ failingCheck: true });
  await value.engine.dispatch(value.task);
  expect(value.issue.columnId).toBe(2);
  expect(await value.remoteHead()).toBe(value.before);
  expect(await value.git("rev-parse", "main")).toBe(value.before);
  expect(value.reports[0]?.status).toBe("failed");
  expect(value.storage.records()[0]?.workflow?.stage).toBe("blocked");
  expect(value.storage.records()[0]!.workflow!.notices.some((notice) => notice.kind === "blocked" && notice.state === "delivered")).toBe(true);
  expect(await readFile(join([...value.native.values()][0]!.cwd, "value.txt"), "utf8")).toBe("new\n");
});

test("partial implementation preserves work without committing or completing it", async () => {
  const value = await fixture({ outcome: "partial" });
  await value.engine.dispatch(value.task);
  expect(value.issue.columnId).toBe(2);
  expect(await value.remoteHead()).toBe(value.before);
  expect(value.reports[0]?.status).toBe("failed");
  expect(await value.git("-C", [...value.native.values()][0]!.cwd, "rev-parse", "HEAD")).toBe(value.before);
  expect(await readFile(join([...value.native.values()][0]!.cwd, "value.txt"), "utf8")).toBe("new\n");
});

test("a changed delegate revokes integration instead of merging another agent's work", async () => {
  const value = await fixture();
  value.afterCoding(() => { value.issue.delegateUserId = "another-agent"; });
  await value.engine.dispatch(value.task);
  expect(await value.remoteHead()).toBe(value.before);
  expect(value.issue.columnId).toBe(2);
  expect(value.reports[0]?.status).toBe("failed");
  expect(value.comments).toEqual([]);
});

test("a denied Done update does not masquerade as issue completion after a valid publication", async () => {
  const value = await fixture({ denyDone: true });
  await value.engine.dispatch(value.task);
  const record = value.storage.records()[0]!;
  expect(await value.remoteHead()).toBe(record.workflow!.integratedCommit!);
  expect(value.issue.columnId).toBe(2);
  expect(value.reports[0]?.status).toBe("failed");
  expect(record.workflow?.stage).toBe("blocked");
  expect(record.workflow!.notices.filter((notice) => notice.state === "delivered").map((notice) => notice.kind)).toEqual(["completed", "blocked"]);
});

test("review mode leaves Git and issue states alone even when a delegated coding turn succeeds", async () => {
  const value = await fixture({ review: true });
  await value.engine.dispatch(value.task);
  expect(value.issue.columnId).toBe(1);
  expect(await value.remoteHead()).toBe(value.before);
  expect(value.storage.records()[0]?.workflow).toBeUndefined();
  expect(value.reports[0]?.status).toBe("success");
});

test("an explicit unchanged-status task restriction overrides automatic completion", async () => {
  const value = await fixture({ restriction: "Do not change issue status." });
  await value.engine.dispatch(value.task);
  expect(value.issue.columnId).toBe(1);
  expect(await value.remoteHead()).toBe(value.before);
  expect(value.storage.records()[0]?.workflow).toBeUndefined();
  expect(value.reports[0]?.status).toBe("success");
});

for (const attempt of [1, 2]) test(`interrupted finalization resumes under ${attempt === 1 ? "the same" : "a reclaimed"} execution attempt without replaying code`, async () => {
  const value = await fixture();
  const put = value.storage.put.bind(value.storage);
  let interrupted = false;
  value.storage.put = async (record: SessionRecord) => {
    if (!interrupted && record.workflow?.stage === "publishing") {
      interrupted = true;
      throw new StorageError("Simulated publication checkpoint interruption");
    }
    await put(record);
  };
  await value.engine.dispatch(value.task);
  expect(interrupted).toBe(true);
  expect(value.engine.state).toBe("storage-error");
  expect(value.reports).toEqual([]);
  expect(value.storage.records()[0]?.phase).toBe("finalizing");
  await value.engine.stop();
  await value.storage.close();
  const recovered = new PrivateStorage(join(value.directory, "journal"));
  await recovered.initialize();
  value.storage = recovered;
  value.task.run.attempts = attempt;
  const engine = new Engine(value.config, value.protocol, value.gateway, recovered, {}, { heartbeatMs: 50, flushMs: 20 });
  value.engines.push(engine);
  await engine.dispatch(value.task);
  expect(value.sends).toHaveLength(1);
  const completed = recovered.records().find((record) => record.attempt === attempt)!;
  expect(completed.workflow?.stage).toBe("completed");
  expect(await value.remoteHead()).toBe(completed.workflow!.integratedCommit!);
  expect(value.issue.columnId).toBe(3);
  expect(value.reports[0]?.status).toBe("success");
});

test("a remote changed during coding cannot become an implicitly authorized publication target", async () => {
  const value = await fixture();
  const other = join(value.directory, "other.git");
  await execute("git", ["init", "--bare", "--initial-branch=main", other]);
  value.afterCoding(async () => { await value.git("remote", "set-url", "origin", other); });
  await value.engine.dispatch(value.task);
  expect(value.reports[0]?.status).toBe("failed");
  expect(value.issue.columnId).toBe(2);
  expect(await value.remoteHead()).toBe(value.before);
  expect((await execute("git", ["--git-dir", other, "for-each-ref", "--format=%(refname)"])).stdout).toBe("");
});

test("a lost Done acknowledgment is reconciled through authoritative issue state", async () => {
  const value = await fixture({ loseDoneAck: "applied" });
  await value.engine.dispatch(value.task);
  const record = value.storage.records()[0]!;
  expect(value.issue.columnId).toBe(3);
  expect(value.columns).toEqual([2, 3]);
  expect(record.workflow?.stage).toBe("completed");
  expect(value.reports[0]?.status).toBe("success");
  expect(await value.remoteHead()).toBe(record.workflow!.integratedCommit!);
});

test("unavailable state after a lost Done acknowledgment remains explicitly uncertain", async () => {
  const value = await fixture({ loseDoneAck: "unreadable" });
  await value.engine.dispatch(value.task);
  const record = value.storage.records()[0]!;
  expect(value.issue.columnId).toBe(3);
  expect(value.columns).toEqual([2, 3]);
  expect(record.workflow?.stage).toBe("uncertain");
  expect(value.reports[0]?.status).toBe("failed");
  expect(await value.remoteHead()).toBe(record.workflow!.integratedCommit!);
});
