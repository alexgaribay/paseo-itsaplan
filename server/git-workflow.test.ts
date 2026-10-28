import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { workflowStateSchema, type GitWorkflowInput, type WorkflowState } from "../shared/workflow";
import { ConfigurationError } from "./errors";
import { captureWorkflowRepository, finalizeGitWorkflow as runGitWorkflow } from "./git-workflow";

const run = promisify(execFile);
const roots: string[] = [];
const operations = new Map<Promise<WorkflowState>, AbortController>();
afterEach(async () => {
  const pending = [...operations.keys()];
  for (const controller of operations.values()) controller.abort(new Error("Workflow fixture finished"));
  await Promise.allSettled(pending);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function finalizeGitWorkflow(input: GitWorkflowInput): Promise<WorkflowState> {
  const controller = new AbortController();
  const operation = runGitWorkflow({ ...input, signal: AbortSignal.any([input.signal, controller.signal]) });
  operations.set(operation, controller);
  const finished = () => { operations.delete(operation); };
  void operation.then(finished, finished);
  return operation;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined } })).stdout.trim();
}

interface Fixture {
  root: string;
  source: string;
  remote: string;
  task: string;
  initial: string;
  stop: AbortController;
  input: GitWorkflowInput;
  saved: WorkflowState;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-git-workflow-")));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const task = join(root, "task");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Workflow fixture");
  await git(source, "config", "user.email", "workflow@example.invalid");
  await git(source, "config", "commit.gpgsign", "false");
  await git(source, "config", "core.autocrlf", "false");
  await writeFile(join(source, ".gitignore"), "node_modules\n.build\n");
  await writeFile(join(source, "sum.cjs"), "module.exports = (left, right) => left + right;\n");
  await writeFile(join(source, "check.cjs"), "const assert = require('node:assert/strict'); const fs = require('node:fs'); assert.equal(require('./sum.cjs')(2, 3), 5); assert.ok(!(fs.existsSync('main.flag') && fs.existsSync('task.flag')), 'combined flags are incompatible');\n");
  await git(source, "add", "--all");
  await git(source, "commit", "-m", "Initial tested application");
  await git(root, "init", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "main");
  await git(source, "worktree", "add", "-b", "task-one", task, "main");
  await writeFile(join(task, "implementation.txt"), "Task-owned implementation\n");
  const initial = await git(source, "rev-parse", "HEAD");
  const stop = new AbortController();
  const saved = workflowStateSchema.parse({ version: 1, options: { checks: [[process.execPath, "check.cjs"]] }, stage: "running", inProgressColumnId: 2, doneColumnId: 3 });
  const value: Fixture = {
    root, source, remote, task, initial, stop, saved,
    input: { key: root, repository: source, cwd: task, branchName: "task-one", issueIdentifier: "TEST-1", workflow: saved, signal: stop.signal, checkpoint: async () => {}, assertAuthorized: async () => {} },
  };
  value.input.checkpoint = async (state) => { value.saved = structuredClone(state); };
  return value;
}

async function writer(value: Fixture): Promise<string> {
  const directory = join(value.root, "writer");
  await git(value.root, "clone", "--branch", "main", value.remote, directory);
  await git(directory, "config", "user.name", "External writer");
  await git(directory, "config", "user.email", "writer@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  return directory;
}

async function commitFile(cwd: string, path: string, content: string): Promise<string> {
  await writeFile(join(cwd, path), content);
  await git(cwd, "add", "--all");
  await git(cwd, "commit", "-m", `Change ${path}`);
  return git(cwd, "rev-parse", "HEAD");
}

async function hook(value: Fixture, name: string, body: string): Promise<void> {
  const path = join(value.remote, "hooks", name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
}

async function waitForFile(path: string): Promise<void> {
  const { promise, resolve: ready, reject } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), (_event, filename) => { if (filename === basename(path)) ready(); });
  watcher.on("error", reject);
  try {
    try { await access(path); return; } catch {}
    await promise;
  } finally { watcher.close(); }
}

async function assertUnpublished(value: Fixture): Promise<void> {
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(value.initial);
  expect(await git(value.remote, "rev-parse", "refs/heads/main")).toBe(value.initial);
  expect(await git(value.source, "status", "--porcelain")).toBe("");
  expect(await readFile(join(value.task, "implementation.txt"), "utf8")).toBe("Task-owned implementation\n");
}

test("publishes a checked task and fast-forwards the clean local main checkout", async () => {
  const value = await fixture();
  const result = await finalizeGitWorkflow(value.input);
  expect(result.stage).toBe("published");
  expect(result.checks.map((receipt) => [receipt.commit, receipt.exitCode])).toEqual([[result.taskCommit!, 0], [result.integratedCommit!, 0]]);
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(result.integratedCommit!);
  expect(await git(value.remote, "rev-parse", "refs/heads/main")).toBe(result.integratedCommit!);
  expect(await readFile(join(value.source, "implementation.txt"), "utf8")).toBe("Task-owned implementation\n");
  expect(await git(value.source, "status", "--porcelain")).toBe("");
  expect((await git(value.source, "worktree", "list", "--porcelain")).split("worktree ").length - 1).toBe(2);
  expect(await git(value.task, "rev-list", "--count", "HEAD")).toBe("2");
});

test("retains a coding agent's existing task commit without creating a duplicate", async () => {
  const value = await fixture();
  await git(value.task, "add", "--all");
  await git(value.task, "commit", "-m", "Agent authored implementation");
  const authored = await git(value.task, "rev-parse", "HEAD");
  const result = await finalizeGitWorkflow(value.input);
  expect(result.taskCommit).toBe(authored);
  expect(await git(value.task, "rev-list", "--count", "HEAD")).toBe("2");
  expect(await git(value.remote, "show", "main:implementation.txt")).toBe("Task-owned implementation");
});

test("a real task check failure prevents integration and push but preserves its commit", async () => {
  const value = await fixture();
  await writeFile(join(value.task, "sum.cjs"), "module.exports = (left, right) => left - right;\n");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Validation");
  await assertUnpublished(value);
  expect(await git(value.task, "show", "HEAD:sum.cjs")).toBe("module.exports = (left, right) => left - right;");
  expect(value.saved.integratedCommit).toBeUndefined();
  expect(value.saved.checks).toEqual([]);
});

test("combined-tree checks reject an interaction absent from each task's original tree", async () => {
  const value = await fixture();
  await writeFile(join(value.task, "task.flag"), "task\n");
  value.initial = await commitFile(value.source, "main.flag", "main\n");
  await git(value.source, "push", "origin", "main");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Validation");
  await assertUnpublished(value);
  expect(value.saved.checks.map((receipt) => receipt.commit)).toEqual([value.saved.taskCommit!]);
  expect(await git(value.task, "show", "HEAD:task.flag")).toBe("task");
  expect((await git(value.source, "worktree", "list", "--porcelain")).split("worktree ").length - 1).toBe(2);
});

test("concurrent bot submissions serialize by common Git directory and retain both tasks", async () => {
  const value = await fixture();
  const second = join(value.root, "second-task");
  await git(value.source, "worktree", "add", "-b", "task-two", second, "main");
  await writeFile(join(second, "second.txt"), "Second task implementation\n");
  const secondState = structuredClone(value.input.workflow);
  const [firstResult, secondResult] = await Promise.all([
    finalizeGitWorkflow(value.input),
    finalizeGitWorkflow({ ...value.input, key: `${value.input.key}:second`, cwd: second, branchName: "task-two", workflow: secondState, checkpoint: async () => {} }),
  ]);
  expect([firstResult.stage, secondResult.stage]).toEqual(["published", "published"]);
  expect(await git(value.remote, "show", "main:implementation.txt")).toBe("Task-owned implementation");
  expect(await git(value.remote, "show", "main:second.txt")).toBe("Second task implementation");
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(await git(value.remote, "rev-parse", "main"));
  expect(await git(value.source, "status", "--porcelain")).toBe("");
}, 30_000);

test("integrates a remote fast-forward without overwriting the source checkout", async () => {
  const value = await fixture();
  const external = await writer(value);
  await commitFile(external, "external.txt", "External change\n");
  await git(external, "push", "origin", "main");
  const result = await finalizeGitWorkflow(value.input);
  expect(result.stage).toBe("published");
  expect(await readFile(join(value.source, "external.txt"), "utf8")).toBe("External change\n");
  expect(await readFile(join(value.source, "implementation.txt"), "utf8")).toBe("Task-owned implementation\n");
});

test("a remote writer after the publishing checkpoint causes a non-force push rejection", async () => {
  const value = await fixture();
  const external = await writer(value);
  const externalHead = await commitFile(external, "external.txt", "Winning remote change\n");
  let advanced = false;
  value.input.checkpoint = async (state) => {
    value.saved = structuredClone(state);
    if (state.stage === "publishing" && !advanced) { advanced = true; await git(external, "push", "origin", "main"); }
  };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("publication was rejected");
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(value.initial);
  expect(await git(value.remote, "rev-parse", "main")).toBe(externalHead);
  await expect(finalizeGitWorkflow({ ...value.input, workflow: value.saved })).rejects.toThrow("no push was replayed");
  expect(await git(value.remote, "rev-parse", "main")).toBe(externalHead);
  expect(await readFile(join(value.task, "implementation.txt"), "utf8")).toBe("Task-owned implementation\n");
});

test("remote receive hooks remain enabled and their rejection cannot become published", async () => {
  const value = await fixture();
  await hook(value, "pre-receive", "process.exit(1);");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("publication was rejected");
  await assertUnpublished(value);
  expect(value.saved.stage).toBe("publishing");
  expect(value.saved.remoteBefore).toBe(value.initial);
});

test("authorization revoked after a checkpoint stops publication without losing the task", async () => {
  const value = await fixture();
  value.input.assertAuthorized = async () => { if (value.saved.stage === "publishing") throw new ConfigurationError("Lease expired"); };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Lease expired");
  await assertUnpublished(value);
  expect(value.saved.checks.map((receipt) => receipt.exitCode)).toEqual([0, 0]);
});

test("cancellation terminates running validation and leaves main unpublished", async () => {
  const value = await fixture();
  const started = join(value.root, "validation-started");
  await writeFile(join(value.task, "slow.cjs"), "const fs = require('node:fs'); require('./check.cjs'); fs.writeFileSync(process.argv[2], 'started'); setInterval(() => {}, 1000);\n");
  value.input.workflow.options.checks = [[process.execPath, "slow.cjs", started]];
  const result = finalizeGitWorkflow(value.input).catch((error: unknown) => error);
  await waitForFile(started);
  value.stop.abort(new Error("Stop validation"));
  expect((await result as Error).message).toBe("Stop validation");
  await assertUnpublished(value);
  expect(value.saved.checks).toEqual([]);
});

test("cancellation during the integration lock wait never commits the waiting task", async () => {
  const value = await fixture();
  const started = join(value.root, "validation-started");
  await writeFile(join(value.task, "slow.cjs"), "require('./check.cjs'); require('node:fs').writeFileSync(process.argv[2], 'started'); setInterval(() => {}, 1000);\n");
  value.input.workflow.options.checks = [[process.execPath, "slow.cjs", started]];
  const second = join(value.root, "second-task");
  await git(value.source, "worktree", "add", "-b", "task-two", second, "main");
  await writeFile(join(second, "second.txt"), "Waiting work\n");
  const first = finalizeGitWorkflow(value.input).catch((error: unknown) => error);
  await waitForFile(started);
  const stopped = new AbortController();
  const { promise: queued, resolve: enteredQueue } = Promise.withResolvers<void>();
  let authorizations = 0;
  const waiting = finalizeGitWorkflow({ ...value.input, key: "waiting", cwd: second, branchName: "task-two", signal: stopped.signal, assertAuthorized: async () => { if (++authorizations === 2) enteredQueue(); } }).catch((error: unknown) => error);
  await queued;
  stopped.abort(new Error("Stop waiting"));
  expect((await waiting as Error).message).toBe("Stop waiting");
  expect(await git(second, "rev-parse", "HEAD")).toBe(value.initial);
  expect(await readFile(join(second, "second.txt"), "utf8")).toBe("Waiting work\n");
  value.stop.abort(new Error("Stop active"));
  expect((await first as Error).message).toBe("Stop active");
  await assertUnpublished(value);
});

test("restart reconciles an acknowledged Git commit whose durable receipt was interrupted", async () => {
  const value = await fixture();
  let interrupted = false;
  value.input.checkpoint = async (state) => {
    if (state.taskCommit && !interrupted) { interrupted = true; throw new Error("Checkpoint interrupted"); }
    value.saved = structuredClone(state);
  };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Checkpoint interrupted");
  const authored = await git(value.task, "rev-parse", "HEAD");
  expect(value.saved.stage).toBe("committing");
  expect(value.saved.taskCommit).toBeUndefined();
  const result = await finalizeGitWorkflow({ ...value.input, workflow: value.saved });
  expect(result.taskCommit).toBe(authored);
  expect(await git(value.task, "rev-list", "--count", "HEAD")).toBe("2");
  expect(await git(value.remote, "rev-parse", "main")).toBe(result.integratedCommit!);
});

test("restart proves an accepted push before replay and completes local main without a second push", async () => {
  const value = await fixture();
  const accepted = join(value.root, "accepted-pushes");
  await hook(value, "post-receive", `require('node:fs').appendFileSync(${JSON.stringify(accepted)}, 'accepted\\n');`);
  value.input.assertAuthorized = async () => {
    try { await access(accepted); } catch { return; }
    throw new ConfigurationError("Lease ended after remote acceptance");
  };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Lease ended after remote acceptance");
  expect(value.saved.stage).toBe("publishing");
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(value.initial);
  const acceptedCommit = await git(value.remote, "rev-parse", "main");
  const result = await finalizeGitWorkflow({ ...value.input, workflow: { ...value.saved, stage: "blocked" }, assertAuthorized: async () => {} });
  expect(result.stage).toBe("published");
  expect(result.integratedCommit).toBe(acceptedCommit);
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(acceptedCommit);
  expect(await readFile(accepted, "utf8")).toBe("accepted\n");
  expect(await git(value.task, "rev-list", "--count", "HEAD")).toBe("2");
});

test("restart refuses a changed remote identity rather than publishing to another repository", async () => {
  const value = await fixture();
  value.input.assertAuthorized = async () => { if (value.saved.taskCommit) throw new ConfigurationError("Pause after task commit"); };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Pause after task commit");
  const replacement = join(value.root, "replacement.git");
  await git(value.root, "init", "--bare", replacement);
  await git(value.source, "remote", "set-url", "origin", replacement);
  await expect(finalizeGitWorkflow({ ...value.input, workflow: value.saved, assertAuthorized: async () => {} })).rejects.toThrow("remote identity changed");
  expect(await git(replacement, "for-each-ref")).toBe("");
  expect(await git(value.task, "show", "HEAD:implementation.txt")).toBe("Task-owned implementation");
});

test("dirty source main is preserved and prevents committing task work", async () => {
  const value = await fixture();
  await writeFile(join(value.source, "sum.cjs"), "User's uncommitted change\n");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("dirty");
  expect(await git(value.task, "rev-parse", "HEAD")).toBe(value.initial);
  expect(await readFile(join(value.source, "sum.cjs"), "utf8")).toBe("User's uncommitted change\n");
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.initial);
});

test("an empty remote branch is initialized from existing local main without invented commits", async () => {
  const value = await fixture();
  const empty = join(value.root, "empty.git");
  await git(value.root, "init", "--bare", empty);
  await git(value.source, "remote", "set-url", "origin", empty);
  const result = await finalizeGitWorkflow(value.input);
  expect(result.stage).toBe("published");
  expect(result.remoteBefore).toBeNull();
  expect(await git(empty, "rev-list", "--count", "main")).toBe("3");
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(result.integratedCommit!);
});

test("nested package manifests run their real test and build scripts", async () => {
  const value = await fixture();
  const app = join(value.task, "apps", "web");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "package.json"), JSON.stringify({ private: true, scripts: { test: `${JSON.stringify(process.execPath)} ../../check.cjs`, build: `${JSON.stringify(process.execPath)} build.cjs` } }));
  await writeFile(join(app, "build.cjs"), "const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs'); assert.equal(new vm.Script(fs.readFileSync('../../sum.cjs', 'utf8')).runInNewContext({module: {}})(3,4), 7);\n");
  value.input.workflow.options.checks = [];
  const result = await finalizeGitWorkflow(value.input);
  expect(result.stage).toBe("published");
  expect(result.checks.map((receipt) => [receipt.directory, receipt.command])).toEqual([
    ["apps/web", ["npm", "run", "test"]], ["apps/web", ["npm", "run", "build"]],
    ["apps/web", ["npm", "run", "test"]], ["apps/web", ["npm", "run", "build"]],
  ]);
  expect(await git(value.remote, "rev-parse", "main")).toBe(result.integratedCommit!);
});

test("unsupported repositories and missing validation executables fail without publishing", async () => {
  const value = await fixture();
  value.input.workflow.options.checks = [];
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("No real conventional test/build checks");
  await assertUnpublished(value);
  const next = structuredClone(value.saved);
  next.options.checks = [["itsaplan-nonexistent-validation-tool-65729"]];
  await expect(finalizeGitWorkflow({ ...value.input, workflow: next })).rejects.toThrow("Required tool");
  await assertUnpublished(value);
});

test("ambiguous package managers require explicit validation instead of guessing", async () => {
  const value = await fixture();
  await writeFile(join(value.task, "package.json"), JSON.stringify({ scripts: { test: `${JSON.stringify(process.execPath)} check.cjs` } }));
  await writeFile(join(value.task, "package-lock.json"), "{}\n");
  await writeFile(join(value.task, "yarn.lock"), "\n");
  value.input.workflow.options.checks = [];
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Ambiguous package managers");
  await assertUnpublished(value);
});

test("a merge conflict never contaminates the source checkout or discards task work", async () => {
  const value = await fixture();
  await writeFile(join(value.task, "shared.txt"), "Task content\n");
  value.initial = await commitFile(value.source, "shared.txt", "Main content\n");
  await git(value.source, "push", "origin", "main");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Git merge failed");
  await assertUnpublished(value);
  expect(await readFile(join(value.source, "shared.txt"), "utf8")).toBe("Main content\n");
  expect(await git(value.task, "show", "HEAD:shared.txt")).toBe("Task content");
  expect((await git(value.source, "worktree", "list", "--porcelain")).split("worktree ").length - 1).toBe(2);
});

test("a real Swift package builds and tests before publication when its toolchain is available", async () => {
  const value = await fixture();
  await mkdir(join(value.task, "Sources", "Example"), { recursive: true });
  await mkdir(join(value.task, "Tests", "ExampleTests"), { recursive: true });
  await writeFile(join(value.task, "Package.swift"), '// swift-tools-version: 5.7\nimport PackageDescription\nlet package = Package(name: "Example", products: [.library(name: "Example", targets: ["Example"])], targets: [.target(name: "Example"), .testTarget(name: "ExampleTests", dependencies: ["Example"])])\n');
  await writeFile(join(value.task, "Sources", "Example", "Math.swift"), "public func sum(_ left: Int, _ right: Int) -> Int { left + right }\n");
  await writeFile(join(value.task, "Tests", "ExampleTests", "MathTests.swift"), "import XCTest\n@testable import Example\nfinal class MathTests: XCTestCase { func testSum() { XCTAssertEqual(sum(2, 3), 5) } }\n");
  value.input.workflow.options.checks = [];
  const available = await run("swift", ["--version"]).then(() => true, () => false);
  if (!available) {
    await expect(finalizeGitWorkflow(value.input)).rejects.toBeInstanceOf(ConfigurationError);
    await assertUnpublished(value);
    return;
  }
  const result = await finalizeGitWorkflow(value.input);
  expect(result.stage).toBe("published");
  expect(result.checks.map((receipt) => receipt.command.slice(0, 2))).toEqual([["swift", "test"], ["swift", "build"], ["swift", "test"], ["swift", "build"]]);
  expect(await git(value.remote, "show", "main:Sources/Example/Math.swift")).toBe("public func sum(_ left: Int, _ right: Int) -> Int { left + right }");
}, 120_000);

test("an ambiguous Xcode scheme selection is an actionable failure rather than a fabricated check", async () => {
  const value = await fixture();
  const project = join(value.task, "iPadApp", "App.xcodeproj");
  const schemes = join(project, "xcshareddata", "xcschemes");
  await mkdir(schemes, { recursive: true });
  await writeFile(join(project, "project.pbxproj"), "{ SDKROOT = iphoneos; }\n");
  await writeFile(join(schemes, "Production.xcscheme"), "<Scheme><BuildAction/></Scheme>\n");
  await writeFile(join(schemes, "Development.xcscheme"), "<Scheme><BuildAction/></Scheme>\n");
  value.input.workflow.options.checks = [];
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("exactly one shared scheme");
  await assertUnpublished(value);
  expect(await git(value.task, "show", "HEAD:iPadApp/App.xcodeproj/xcshareddata/xcschemes/Production.xcscheme")).toBe("<Scheme><BuildAction/></Scheme>");
});

test("checks that modify the tested tree cannot receive a passing receipt", async () => {
  const value = await fixture();
  value.input.workflow.options.checks = [[process.execPath, "-e", "require('./check.cjs'); require('node:fs').writeFileSync('sum.cjs', 'changed by check\\n');"]];
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("dirty");
  await assertUnpublished(value);
  expect(await readFile(join(value.task, "sum.cjs"), "utf8")).toBe("changed by check\n");
  expect(value.saved.checks).toEqual([]);
});

test("clean but unpublished source-main commits are not silently published with task work", async () => {
  const value = await fixture();
  const local = await commitFile(value.source, "private.txt", "Unpublished local work\n");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("unpublished or divergent");
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(local);
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.initial);
  expect(await readFile(join(value.source, "private.txt"), "utf8")).toBe("Unpublished local work\n");
  expect(await git(value.task, "show", "HEAD:implementation.txt")).toBe("Task-owned implementation");
});

test("changing task branch ownership after a saved commit blocks restart", async () => {
  const value = await fixture();
  value.input.assertAuthorized = async () => { if (value.saved.taskCommit) throw new ConfigurationError("Pause committed task"); };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Pause committed task");
  await git(value.task, "switch", "-c", "different-owner");
  await expect(finalizeGitWorkflow({ ...value.input, workflow: value.saved, assertAuthorized: async () => {} })).rejects.toThrow("ownership");
  await assertUnpublished(value);
  expect(await git(value.task, "branch", "--show-current")).toBe("different-owner");
});

test("local fast-forward cannot overwrite an ignored user's file", async () => {
  const value = await fixture();
  await writeFile(join(value.source, "node_modules"), "User's ignored local file\n");
  await writeFile(join(value.task, "node_modules"), "Task's intentionally tracked file\n");
  await git(value.task, "add", "--force", "node_modules");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("Git merge failed");
  expect(await readFile(join(value.source, "node_modules"), "utf8")).toBe("User's ignored local file\n");
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(value.initial);
  expect(await git(value.remote, "show", "main:node_modules")).toBe("Task's intentionally tracked file");
  expect(value.saved.stage).toBe("publishing");
});

test("a trailing-space remote path cannot impersonate the captured destination", async () => {
  const value = await fixture();
  const capture = await captureWorkflowRepository({ repository: value.source, cwd: value.task, branchName: value.input.branchName, options: value.input.workflow.options, signal: value.stop.signal });
  const replacement = `${value.remote} `;
  await git(value.root, "clone", "--bare", value.remote, replacement);
  await git(value.source, "remote", "set-url", "origin", replacement);
  await expect(finalizeGitWorkflow({ ...value.input, workflow: { ...value.input.workflow, ...capture } })).rejects.toThrow("remote identity");
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.initial);
  expect(await git(replacement, "rev-parse", "main")).toBe(value.initial);
  expect(await git(value.task, "rev-parse", "HEAD")).toBe(value.initial);
});

test("an explicitly captured trailing-space remote remains distinct during publication", async () => {
  const value = await fixture();
  const destination = `${value.remote} `;
  await git(value.root, "clone", "--bare", value.remote, destination);
  await git(value.source, "remote", "set-url", "origin", destination);
  const capture = await captureWorkflowRepository({ repository: value.source, options: value.input.workflow.options, signal: value.stop.signal });
  const result = await finalizeGitWorkflow({ ...value.input, workflow: { ...value.input.workflow, ...capture } });
  expect(result.stage).toBe("published");
  expect(await git(destination, "rev-parse", "main")).toBe(result.integratedCommit!);
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.initial);
});

test("publication never follows an unrelated annotated release tag from ambient configuration", async () => {
  const value = await fixture();
  await git(value.source, "config", "tag.gpgSign", "false");
  await git(value.source, "tag", "--annotate", "private-release", "--message", "Unpublished release", value.initial);
  await git(value.source, "config", "push.followTags", "true");
  await git(value.source, "config", "push.recurseSubmodules", "on-demand");
  const result = await finalizeGitWorkflow(value.input);
  expect(result.stage).toBe("published");
  expect(await git(value.remote, "rev-parse", "main")).toBe(result.integratedCommit!);
  expect(await git(value.remote, "for-each-ref", "refs/tags/private-release")).toBe("");
  expect(await git(value.source, "rev-parse", "private-release^{commit}")).toBe(value.initial);
});

test("a destination replacement in final authorization cannot receive implementation objects", async () => {
  const value = await fixture();
  const replacement = join(value.root, "replacement.git");
  await git(value.root, "clone", "--bare", value.remote, replacement);
  let publishingAuthorizations = 0;
  value.input.assertAuthorized = async () => {
    if (value.saved.stage === "publishing" && ++publishingAuthorizations === 2) await git(value.source, "remote", "set-url", "origin", replacement);
  };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("remote identity");
  expect(await git(replacement, "rev-parse", "main")).toBe(value.initial);
  const leaked = await run("git", ["-C", replacement, "cat-file", "-e", value.saved.taskCommit!]).then(() => true, () => false);
  expect(leaked).toBe(false);
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.saved.integratedCommit!);
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(value.initial);
});

test("a URL rewrite installed in final authorization cannot redirect the pinned transport", async () => {
  const value = await fixture();
  const replacement = join(value.root, "replacement.git");
  await git(value.root, "clone", "--bare", value.remote, replacement);
  let publishingAuthorizations = 0;
  value.input.assertAuthorized = async () => {
    if (value.saved.stage === "publishing" && ++publishingAuthorizations === 2) await git(value.source, "config", `url.${replacement}.insteadOf`, value.remote);
  };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("transport configuration changed");
  expect(await git(replacement, "rev-parse", "main")).toBe(value.initial);
  const leaked = await run("git", ["-C", replacement, "cat-file", "-e", value.saved.taskCommit!]).then(() => true, () => false);
  expect(leaked).toBe(false);
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.saved.integratedCommit!);
});

test("already-resolved URLs are not rewritten a second time by the isolated transport", async () => {
  const value = await fixture();
  const replacement = join(value.root, "replacement.git");
  await git(value.root, "clone", "--bare", value.remote, replacement);
  await git(value.source, "config", `url.${value.remote}.insteadOf`, "workflow-target:");
  await git(value.source, "config", `url.${replacement}.insteadOf`, value.remote);
  await git(value.source, "remote", "set-url", "origin", "workflow-target:");
  const originalConfig = await readFile(join(value.source, ".git", "config"), "utf8");
  const capture = await captureWorkflowRepository({ repository: value.source, options: value.input.workflow.options, signal: value.stop.signal });
  const result = await finalizeGitWorkflow({ ...value.input, workflow: { ...value.input.workflow, ...capture } });
  expect(result.stage).toBe("published");
  expect(await git(value.remote, "rev-parse", "main")).toBe(result.integratedCommit!);
  expect(await git(replacement, "rev-parse", "main")).toBe(value.initial);
  expect(await readFile(join(value.source, ".git", "config"), "utf8")).toBe(originalConfig);
});

test("the immutable transport still executes the configured source pre-push hook", async () => {
  const value = await fixture();
  const hooks = join(value.source, ".git", "private-hooks");
  const invoked = join(value.root, "pre-push-invoked");
  await mkdir(hooks);
  await writeFile(join(hooks, "pre-push"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'policy rejected'); process.exit(1);\n`);
  await chmod(join(hooks, "pre-push"), 0o755);
  await git(value.source, "config", "core.hooksPath", ".git/private-hooks");
  const originalConfig = await readFile(join(value.source, ".git", "config"), "utf8");
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("publication was rejected");
  expect(await readFile(invoked, "utf8")).toBe("policy rejected");
  expect(await readFile(join(value.source, ".git", "config"), "utf8")).toBe(originalConfig);
  await assertUnpublished(value);
});

test("a published task recovers after another bot advances local and remote main", async () => {
  const value = await fixture();
  const accepted = join(value.root, "accepted-pushes");
  await hook(value, "post-receive", `require('node:fs').appendFileSync(${JSON.stringify(accepted)}, 'accepted\\n');`);
  const first = await finalizeGitWorkflow(value.input);
  const second = join(value.root, "second-task");
  await git(value.source, "worktree", "add", "-b", "task-two", second, "main");
  await writeFile(join(second, "second.txt"), "Second task implementation\n");
  await git(value.source, "config", "branch.task-two.remote", "origin");
  const secondResult = await finalizeGitWorkflow({ ...value.input, key: `${value.input.key}:second`, cwd: second, branchName: "task-two", workflow: structuredClone(value.input.workflow), checkpoint: async () => {} });
  const recovered = await finalizeGitWorkflow({ ...value.input, workflow: { ...first, stage: "uncertain" } });
  expect(recovered.stage).toBe("published");
  expect(recovered.integratedCommit).toBe(first.integratedCommit);
  expect(await git(value.source, "rev-parse", "HEAD")).toBe(secondResult.integratedCommit!);
  expect(await git(value.remote, "rev-parse", "main")).toBe(secondResult.integratedCommit!);
  expect(await readFile(join(value.source, "second.txt"), "utf8")).toBe("Second task implementation\n");
  expect(await readFile(accepted, "utf8")).toBe("accepted\naccepted\n");
}, 30_000);

test("changing an included Git transport configuration cannot redirect publication", async () => {
  const value = await fixture();
  const replacement = join(value.root, "replacement.git");
  const included = join(value.root, "transport.config");
  await git(value.root, "clone", "--bare", value.remote, replacement);
  await writeFile(included, "[http]\n\tsslVerify = true\n");
  await git(value.source, "config", "include.path", included);
  let publishingAuthorizations = 0;
  value.input.assertAuthorized = async () => {
    if (value.saved.stage === "publishing" && ++publishingAuthorizations === 2) await writeFile(included, `[url "${replacement}"]\n\tinsteadOf = "${value.remote}"\n`);
  };
  await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("transport configuration changed");
  expect(await git(replacement, "rev-parse", "main")).toBe(value.initial);
  expect(await git(value.remote, "rev-parse", "main")).toBe(value.saved.integratedCommit!);
  const leaked = await run("git", ["-C", replacement, "cat-file", "-e", value.saved.taskCommit!]).then(() => true, () => false);
  expect(leaked).toBe(false);
});

test("source transport isolation does not bypass globally configured local receive hooks", async () => {
  const value = await fixture();
  const hooks = join(value.root, "global-hooks");
  const global = join(value.root, "global.gitconfig");
  const invoked = join(value.root, "receive-policy-invoked");
  await mkdir(hooks);
  await writeFile(join(hooks, "pre-receive"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'remote policy rejected'); process.exit(1);\n`);
  await chmod(join(hooks, "pre-receive"), 0o755);
  await writeFile(global, `[core]\n\thooksPath = "${hooks}"\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  try {
    await expect(finalizeGitWorkflow(value.input)).rejects.toThrow("publication was rejected");
    expect(await readFile(invoked, "utf8")).toBe("remote policy rejected");
    await assertUnpublished(value);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});
