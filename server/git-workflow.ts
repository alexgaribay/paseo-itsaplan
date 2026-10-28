import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitWorkflowInput, WorkflowState } from "../shared/workflow";
import { ConfigurationError } from "./errors";
import { repository } from "./git";

interface Check { command: string[]; directory: string }
interface CommandResult { code: number; stdout: string }
interface GitSetting { section: string; subsection?: string; name: string; value: string | null }
interface TransportConfiguration { identity: string; url: string; configuration: string; environment: NodeJS.ProcessEnv }
const integrations = new Map<string, Promise<void>>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const gitEnvironment = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined };

async function execute(cwd: string, command: string[], signal: AbortSignal, environment: NodeJS.ProcessEnv = { ...process.env, ...gitEnvironment }): Promise<CommandResult> {
  signal.throwIfAborted();
  const executable = command[0];
  if (!executable || command.some((arg) => arg.includes("\0"))) throw new ConfigurationError("Configure nonempty validation argv without NUL characters.");
  let resolveResult!: (result: CommandResult) => void;
  let reject!: (error: unknown) => void;
  // The installed daemon supports Node 20, before Promise.withResolvers.
  const promise = new Promise<CommandResult>((resolve, fail) => { resolveResult = resolve; reject = fail; });
  const grouped = process.platform !== "win32";
  const child = spawn(executable, command.slice(1), { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
  let stdout = "";
  let overflow = false;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let invalidEncoding = false;
  let outputBytes = 0;
  let escalation: NodeJS.Timeout | undefined;
  const kill = (signalName: NodeJS.Signals) => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, signalName); else child.kill(signalName); } catch {}
  };
  const abort = () => {
    kill("SIGTERM");
    escalation = setTimeout(() => kill("SIGKILL"), 1_000);
    escalation.unref();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 16 * 1024 * 1024) { overflow = true; kill("SIGKILL"); return; }
    try { stdout += decoder.decode(chunk, { stream: true }); }
    catch { invalidEncoding = true; kill("SIGKILL"); }
  });
  child.stderr.resume();
  const dispose = () => {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) kill("SIGKILL");
    clearTimeout(escalation);
  };
  child.on("error", (error: NodeJS.ErrnoException) => {
    dispose();
    reject(signal.aborted ? signal.reason : new ConfigurationError(error.code === "ENOENT" ? `Required tool '${executable}' is unavailable. Install/configure it outside automatic execution.` : `Cannot execute '${executable}'. Check its permissions and configured working directory.`));
  });
  child.on("close", (code) => {
    dispose();
    try { stdout += decoder.decode(); } catch { invalidEncoding = true; }
    if (signal.aborted) reject(signal.reason);
    else if (overflow) reject(new ConfigurationError(`'${executable}' exceeded the command output limit.`));
    else if (invalidEncoding) reject(new ConfigurationError(`'${executable}' emitted non-UTF-8 output that cannot be interpreted without changing its bytes.`));
    else resolveResult({ code: code ?? -1, stdout });
  });
  return promise;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function gitSettings(output: string): GitSetting[] {
  const records = output.split("\0");
  if (records.pop() !== "") throw new ConfigurationError("Git returned an invalid configuration listing.");
  const settings: GitSetting[] = [];
  for (const record of records) {
    const separator = record.indexOf("\n");
    const key = separator < 0 ? record : record.slice(0, separator);
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    if (first < 1) throw new ConfigurationError("Git returned an invalid configuration key.");
    const section = key.slice(0, first).toLowerCase();
    if (section !== "include" && section !== "includeif") settings.push({ section, ...(first === last ? {} : { subsection: key.slice(first + 1, last) }), name: key.slice(last + 1).toLowerCase(), value: separator < 0 ? null : record.slice(separator + 1) });
  }
  return settings;
}

function gitConfiguration(settings: GitSetting[]): string {
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\b", "\\b")}"`;
  return settings.map((setting) => `[${setting.section}${setting.subsection === undefined ? "" : ` ${quote(setting.subsection)}`}]\n\t${setting.name}${setting.value === null ? "" : ` = ${quote(setting.value)}`}\n`).join("");
}

async function transportConfiguration(cwd: string, options: WorkflowState["options"], signal: AbortSignal): Promise<TransportConfiguration> {
  const environment = { ...process.env, ...gitEnvironment };
  const result = await execute(cwd, ["git", "config", "--null", "--list", "--includes"], signal, environment);
  if (result.code !== 0) throw new ConfigurationError("Cannot capture Git configuration for automatic publication.");
  const settings = gitSettings(result.stdout);
  const urls = (name: string) => settings.filter((setting) => setting.section === "remote" && setting.subsection === options.remote && setting.name === name).map((setting) => setting.value);
  const fetch = urls("url");
  const push = urls("pushurl");
  if (options.remote.startsWith("-") || fetch.length !== 1 || !fetch[0] || push.length > 1 || push.length === 1 && !push[0]) throw new ConfigurationError(`Configure one unambiguous fetch/push URL for remote '${options.remote}' before automatic publication.`);
  const rewrite = (url: string, name: string) => {
    let longest: GitSetting | undefined;
    for (const setting of settings) {
      if (setting.section === "url" && setting.subsection !== undefined && setting.name === name && setting.value !== null && url.startsWith(setting.value) && (!longest || setting.value.length > longest.value!.length)) longest = setting;
    }
    return longest ? `${longest.subsection}${url.slice(longest.value!.length)}` : undefined;
  };
  const fetchURL = rewrite(fetch[0], "insteadof") ?? fetch[0];
  const pushURL = push[0] ? rewrite(push[0], "insteadof") ?? push[0] : rewrite(fetch[0], "pushinsteadof") ?? fetchURL;
  if (fetchURL !== pushURL) throw new ConfigurationError("Automatic publication requires matching resolved fetch/push URLs.");
  const identity = hash(JSON.stringify({ remote: options.remote, branch: options.targetBranch, url: pushURL, settings: settings.filter((setting) => setting.section !== "branch") }));
  const frozen = settings.filter((setting) =>
    !(setting.section === "url" && ["insteadof", "pushinsteadof"].includes(setting.name)) &&
    !(setting.section === "remote" && setting.subsection === options.remote && ["url", "pushurl"].includes(setting.name)) &&
    !(setting.section === "core" && ["worktree", "bare"].includes(setting.name)) &&
    !(setting.section === "extensions" && ["worktreeconfig", "refstorage"].includes(setting.name)));
  frozen.push(
    { section: "remote", subsection: options.remote, name: "url", value: pushURL },
    { section: "remote", subsection: options.remote, name: "pushurl", value: pushURL },
    { section: "core", name: "bare", value: "false" },
    { section: "core", name: "worktree", value: cwd },
  );
  return { identity, url: pushURL, configuration: gitConfiguration(frozen), environment };
}

async function waitFor(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let resolveWait!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, fail) => { resolveWait = resolve; reject = fail; });
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  turn.then(() => { signal.removeEventListener("abort", abort); resolveWait(); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  if (signal.aborted) abort();
  await promise;
}

async function serialized<T>(common: string, signal: AbortSignal, authorize: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  const before = integrations.get(common) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => own);
  integrations.set(common, tail);
  try { await authorize(); await waitFor(before, signal); return await operation(); }
  finally { release(); void tail.then(() => { if (integrations.get(common) === tail) integrations.delete(common); }); }
}

async function discoverChecks(cwd: string, files: string[], signal: AbortSignal): Promise<Check[]> {
  const checks: Check[] = [];
  const manifests = files.filter((file) => basename(file) === "package.json" && !file.split("/").some((part) => ["node_modules", "vendor", "Pods", ".build"].includes(part)));
  for (const manifest of manifests) {
    let pkg: { scripts?: Record<string, unknown>; packageManager?: string };
    try {
      pkg = JSON.parse(await readFile(join(cwd, manifest), "utf8"));
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts)) || pkg.packageManager !== undefined && typeof pkg.packageManager !== "string") throw new Error();
    } catch { throw new ConfigurationError(`Cannot read ${manifest}. Configure explicit workflow checks for this repository.`); }
    const scripts = ["test", "build"].filter((name) => typeof pkg.scripts?.[name] === "string" && (pkg.scripts[name] as string).trim());
    if (!scripts.length) continue;
    const directory = dirname(manifest) === "." ? "" : dirname(manifest);
    let at = join(cwd, directory);
    let manager: string | undefined;
    while (!manager) {
      const locks = await Promise.all(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].map(async (file) => await exists(join(at, file)) ? file : null));
      const managers = new Set(locks.filter((file): file is string => file !== null).map((file) => file.startsWith("bun.") ? "bun" : file.startsWith("pnpm-") ? "pnpm" : file === "yarn.lock" ? "yarn" : "npm"));
      if (managers.size > 1) throw new ConfigurationError(`Ambiguous package managers near ${manifest}. Configure explicit workflow checks.`);
      manager = [...managers][0];
      if (manager || at === cwd) break;
      at = dirname(at);
    }
    const declared = pkg.packageManager?.split("@")[0];
    if (declared && (!["npm", "pnpm", "yarn", "bun"].includes(declared) || manager && manager !== declared)) throw new ConfigurationError(`Unsupported or conflicting package manager in ${manifest}. Configure explicit workflow checks.`);
    manager = declared ?? manager ?? "npm";
    for (const script of scripts) checks.push({ directory, command: [manager, "run", script] });
  }
  for (const manifest of files.filter((file) => basename(file) === "Package.swift" && !file.split("/").includes(".build"))) {
    const directory = dirname(manifest) === "." ? "" : dirname(manifest);
    const description = await execute(join(cwd, directory), ["swift", "package", "dump-package"], signal);
    if (description.code !== 0) throw new ConfigurationError(`Cannot inspect ${manifest}. Install the required Swift toolchain or configure explicit workflow checks.`);
    let dependencies: unknown[];
    let targets: { type: string }[];
    try {
      const parsed = JSON.parse(description.stdout);
      if (!Array.isArray(parsed.dependencies) || !Array.isArray(parsed.targets) || parsed.targets.some((target: unknown) => !target || typeof target !== "object" || !("type" in target) || typeof target.type !== "string")) throw new Error();
      dependencies = parsed.dependencies;
      targets = parsed.targets;
    } catch { throw new ConfigurationError(`Swift returned an unreadable package description for ${manifest}.`); }
    if (dependencies.length) {
      try {
        const installed = JSON.parse(await readFile(join(cwd, directory, ".build", "workspace-state.json"), "utf8")).object.dependencies;
        if (!Array.isArray(installed) || !installed.length) throw new Error();
        for (const dependency of installed) {
          if (dependency.state?.name === "sourceControlCheckout" && (typeof dependency.subpath !== "string" || !await exists(join(cwd, directory, ".build", "checkouts", dependency.subpath)))) throw new Error();
        }
      } catch { throw new ConfigurationError(`Swift dependencies for ${manifest} are not prepared. Resolve them outside automatic execution or configure explicit checks against a prepared build directory.`); }
    }
    if (targets.some((target) => target.type === "test")) checks.push({ directory, command: ["swift", "test", "--disable-automatic-resolution", "--skip-update"] });
    checks.push({ directory, command: ["swift", "build", "--disable-automatic-resolution", "--skip-update"] });
  }
  const projects = files.filter((file) => file.endsWith(".xcodeproj/project.pbxproj"));
  const workspaces = files.filter((file) => file.endsWith(".xcworkspace/contents.xcworkspacedata") && !file.includes(".xcodeproj/"));
  if (workspaces.length && !projects.length) throw new ConfigurationError("The Xcode workspace has no tracked project to validate. Configure explicit workflow checks for its prepared project layout.");
  if (projects.length) {
    if (workspaces.length > 1 || projects.length > 1) throw new ConfigurationError("Multiple Xcode projects/workspaces need explicit workflow checks with the intended scheme and destination.");
    const project = projects[0]!;
    const container = workspaces[0] ? dirname(workspaces[0]) : dirname(project);
    const containerFlag = workspaces.length ? "-workspace" : "-project";
    const schemes = files.filter((file) => file.startsWith(`${container}/xcshareddata/xcschemes/`) && file.endsWith(".xcscheme"));
    const candidates = schemes.length ? schemes : files.filter((file) => file.startsWith(`${dirname(project)}/xcshareddata/xcschemes/`) && file.endsWith(".xcscheme"));
    if (candidates.length !== 1) throw new ConfigurationError("Xcode validation requires exactly one shared scheme or explicit workflow checks naming a scheme and destination.");
    const projectText = await readFile(join(cwd, project), "utf8");
    if (projectText.includes("XCRemoteSwiftPackageReference")) throw new ConfigurationError("Xcode package dependencies require explicit workflow checks using a prepared package cache. Automatic execution does not download dependencies.");
    const isIOS = /SDKROOT\s*=\s*iphoneos\s*;/.test(projectText) || /SUPPORTED_PLATFORMS\s*=\s*[^;]*iphonesimulator/.test(projectText);
    const isMac = /SDKROOT\s*=\s*macosx\s*;/.test(projectText);
    if (isIOS === isMac) throw new ConfigurationError("Xcode platform selection is ambiguous. Configure explicit workflow checks with a destination.");
    const command = ["xcodebuild", containerFlag, container, "-scheme", basename(candidates[0]!, ".xcscheme"), "-disableAutomaticPackageResolution", "-skipPackageUpdates", "-onlyUsePackageVersionsFromResolvedFile"];
    checks.push({ directory: "", command: [...command, "-destination", isIOS ? "generic/platform=iOS Simulator" : "platform=macOS", "build"] });
    if ((await readFile(join(cwd, candidates[0]!), "utf8")).includes("<TestableReference")) {
      let destination = "platform=macOS";
      if (isIOS) {
        const listed = await execute(cwd, ["xcrun", "simctl", "list", "devices", "available", "--json"], signal);
        let devices: { name: string; udid: string; isAvailable?: boolean }[];
        try {
          if (listed.code !== 0) throw new Error();
          devices = Object.entries(JSON.parse(listed.stdout).devices as Record<string, typeof devices>)
            .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
            .flatMap(([, available]) => available
              .filter((device) => device.isAvailable !== false && device.name.startsWith("iPad"))
              .sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid)));
        }
        catch { throw new ConfigurationError("Cannot discover an available iPad simulator. Configure explicit workflow checks with an installed destination."); }
        if (!devices.length) throw new ConfigurationError("Xcode tests need an available iPad simulator. Install a destination or configure explicit workflow checks.");
        destination = `platform=iOS Simulator,id=${devices[0]!.udid}`;
      }
      checks.push({ directory: "", command: [...command, "-destination", destination, "test"] });
    }
  }
  if (!checks.length) throw new ConfigurationError("No real conventional test/build checks were found. Configure workflow.checks as executable argv arrays for this repository.");
  return checks;
}

export async function captureWorkflowRepository(input: Pick<GitWorkflowInput, "repository" | "signal"> & {
  options: WorkflowState["options"]; cwd?: string; branchName?: string;
}): Promise<Pick<WorkflowState, "remoteIdentity" | "ownership">> {
  const { options, signal } = input;
  const source = await repository(input.repository, signal);
  const git = async (args: string[]) => {
    const result = await execute(source.root, ["git", ...args], signal);
    if (result.code !== 0) throw new ConfigurationError("Automatic integration requires an existing committed target branch and a configured remote. Initialize the repository or choose the review lifecycle.");
    return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  };
  const targetRef = `refs/heads/${options.targetBranch}`;
  await git(["check-ref-format", targetRef]);
  await git(["rev-parse", "--verify", `${targetRef}^{commit}`]);
  const transport = await transportConfiguration(source.root, options, signal);
  let ownership: WorkflowState["ownership"];
  if (input.cwd) {
    const task = await repository(input.cwd, signal);
    if (!input.branchName || source.root === task.root || source.common !== task.common) throw new ConfigurationError("The task did not start in an isolated worktree of the captured repository.");
    const branch = await execute(task.root, ["git", "symbolic-ref", "--quiet", "HEAD"], signal);
    if (branch.code || branch.stdout !== `refs/heads/${input.branchName}\n`) throw new ConfigurationError("The task worktree branch does not match its captured issue branch.");
    ownership = { repository: source.root, cwd: task.root, commonDirectory: source.common, branchName: input.branchName };
  }
  return { remoteIdentity: transport.identity, ...(ownership ? { ownership } : {}) };
}

export async function finalizeGitWorkflow(input: GitWorkflowInput): Promise<WorkflowState> {
  const { signal } = input;
  signal.throwIfAborted();
  await input.assertAuthorized();
  if (input.workflow.options.mode !== "automatic") throw new ConfigurationError("Git publication requires explicit automatic workflow policy authorization.");
  const source = await repository(input.repository, signal);
  const task = await repository(input.cwd, signal);
  if (source.root === task.root || source.common !== task.common) throw new ConfigurationError("Automatic publication requires an isolated task worktree in the configured repository.");
  return serialized(source.common, signal, () => input.assertAuthorized(), async () => {
    let state: WorkflowState = structuredClone(input.workflow);
    const options = state.options;
    const targetRef = `refs/heads/${options.targetBranch}`;
    const taskRef = `refs/heads/${input.branchName}`;
    const identity = { repository: source.root, cwd: task.root, commonDirectory: source.common, branchName: input.branchName };
    const token = hash(input.key);
    const resource = join(source.common, "itsaplan-integrations", token);
    const integration = join(resource, "checkout");
    const transportDirectory = join(resource, "transport");
    let transportEnvironment: NodeJS.ProcessEnv | undefined;
    const marker = join(resource, "owner.json");
    const markerText = JSON.stringify({ version: 1, key: input.key, ...identity });
    let ownedResource = false;
    const authorize = async () => { signal.throwIfAborted(); await input.assertAuthorized(); signal.throwIfAborted(); };
    const save = async (patch: Partial<WorkflowState>) => {
      await authorize();
      const next = { ...state, ...patch };
      await input.checkpoint(structuredClone(next));
      state = next;
      signal.throwIfAborted();
    };
    const gitResult = (cwd: string, args: string[]) => execute(cwd, ["git", ...args], signal);
    const git = async (cwd: string, args: string[]) => {
      const result = await gitResult(cwd, args);
      if (result.code !== 0) throw new ConfigurationError(`Git ${args[0]} failed. Inspect the repository, credentials, hooks, signing configuration, or remote branch before retrying.`);
      return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
    };
    const transportGit = async (args: string[]) => {
      if (!transportEnvironment) throw new ConfigurationError("The isolated Git transport configuration is unavailable.");
      return execute(source.root, ["git", ...args], signal, transportEnvironment);
    };
    const ancestor = async (older: string, newer: string) => {
      const result = await gitResult(task.root, ["merge-base", "--is-ancestor", older, newer]);
      if (result.code > 1 || result.code < 0) throw new ConfigurationError("Git ancestry could not be verified. Preserve the branches and inspect repository history.");
      return result.code === 0;
    };
    const head = async (cwd: string) => {
      const result = await gitResult(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (result.code !== 0) throw new ConfigurationError("An existing committed target/task branch is required. Configure the target branch; empty repositories are never bootstrapped automatically.");
      return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
    };
    const clean = async (cwd: string) => {
      const entries = (await git(cwd, ["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
      if (entries.some((entry) => entry[0] !== entry[0]!.toUpperCase() || entry.startsWith("S "))) throw new ConfigurationError("Automatic publication requires full checkouts without assume-unchanged or skip-worktree files. Restore normal index tracking outside this workflow.");
      if (await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new ConfigurationError("The source target checkout or validated worktree is dirty. Preserve its changes and clean it before retrying publication.");
    };
    const ownership = async () => {
      await authorize();
      const [currentSource, currentTask] = await Promise.all([repository(input.repository, signal), repository(input.cwd, signal)]);
      if (currentSource.root !== source.root || currentSource.common !== source.common || currentTask.root !== task.root || currentTask.common !== source.common || await git(task.root, ["symbolic-ref", "--quiet", "HEAD"]) !== taskRef || await git(source.root, ["symbolic-ref", "--quiet", "HEAD"]) !== targetRef) throw new ConfigurationError("Repository, task branch, worktree ownership, or source target branch changed. No automatic publication is permitted.");
      const listed = await git(source.root, ["worktree", "list", "--porcelain", "-z"]);
      const entries = listed.split("\0\0").map((entry) => entry.split("\0"));
      if (!entries.some((entry) => entry.includes(`worktree ${task.root}`) && entry.includes(`branch ${taskRef}`))) throw new ConfigurationError("The task worktree is no longer registered to its owned branch.");
      for (const cwd of [source.root, task.root]) {
        const gitDirectory = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
        const pending = await Promise.all(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START"].map((file) => exists(join(gitDirectory, file))));
        if (pending.some(Boolean)) throw new ConfigurationError("An unfinished Git operation exists in the source/task worktree. Resolve it outside automatic publication.");
      }
      await clean(source.root);
    };
    const assertRemote = async () => {
      if ((await transportConfiguration(source.root, options, signal)).identity !== state.remoteIdentity) throw new ConfigurationError("Configured remote identity changed or its Git transport configuration changed. Review the publication target before retrying.");
    };
    const remoteHead = async (): Promise<string | undefined> => {
      await assertRemote();
      const observed = await transportGit(["ls-remote", "--refs", options.remote, targetRef]);
      if (observed.code !== 0) throw new ConfigurationError("Cannot verify the pinned remote branch. Check its availability and credentials before retrying.");
      const lines = observed.stdout.split("\n").filter(Boolean);
      if (!lines.length) return undefined;
      if (lines.length !== 1 || !new RegExp(`^[0-9a-f]{40,64}\\t`).test(lines[0]!) || lines[0]!.split("\t")[1] !== targetRef) throw new ConfigurationError("The remote target branch could not be identified unambiguously.");
      return lines[0]!.split("\t")[0];
    };
    const fetchRemote = async (expected: string) => {
      await save({});
      await assertRemote();
      await authorize();
      if ((await transportGit(["fetch", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", options.remote, targetRef])).code !== 0) throw new ConfigurationError("Cannot fetch the pinned remote branch. Check its availability and credentials before retrying.");
      if (await remoteHead() !== expected) throw new ConfigurationError("The remote target branch advanced during integration. Retry against its current history.");
    };
    const validate = async (cwd: string, commit: string, checks: Check[]) => {
      for (const check of checks) {
        if (state.checks.some((done) => done.commit === commit && (done.directory ?? "") === check.directory && JSON.stringify(done.command) === JSON.stringify(check.command))) continue;
        await save({ stage: "validating" });
        await ownership();
        if (await head(cwd) !== commit) throw new ConfigurationError("The validation commit changed before its checks ran.");
        await clean(cwd);
        await authorize();
        const result = await execute(join(cwd, check.directory), check.command, signal);
        if (result.code !== 0) throw new ConfigurationError(`Validation '${check.command[0]}' failed with exit code ${result.code}. Fix the task or prepare its tools/dependencies before retrying.`);
        if (await head(cwd) !== commit) throw new ConfigurationError("A validation command changed the commit being validated.");
        await clean(cwd);
        await save({ checks: [...state.checks, { command: check.command, ...(check.directory ? { directory: check.directory } : {}), commit, exitCode: 0 }] });
      }
    };
    const cleanup = async () => {
      if (!ownedResource || !await exists(marker) || await readFile(marker, "utf8") !== markerText) return;
      if (await exists(integration)) {
        const actual = await repository(integration).catch(() => undefined);
        if (!actual || actual.root !== integration || actual.common !== source.common) return;
        const uncanceled = AbortSignal.timeout(10_000);
        const branch = await execute(integration, ["git", "symbolic-ref", "--quiet", "HEAD"], uncanceled);
        if (branch.code !== 1) return;
        const removed = await execute(source.root, ["git", "worktree", "remove", "--force", integration], uncanceled);
        if (removed.code !== 0) return;
      }
      await rm(transportDirectory, { recursive: true, force: true });
      await rm(marker);
      try { await rmdir(resource); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    };
    try {
      await authorize();
      if (!options.targetBranch || options.targetBranch === input.branchName || options.targetBranch.startsWith("-") || input.branchName.startsWith("-") || (await gitResult(source.root, ["check-ref-format", targetRef])).code !== 0 || (await gitResult(source.root, ["check-ref-format", taskRef])).code !== 0) throw new ConfigurationError("Configure distinct valid task and target branches.");
      if (state.ownership && (state.ownership.repository !== identity.repository || state.ownership.cwd !== identity.cwd || state.ownership.commonDirectory !== identity.commonDirectory || state.ownership.branchName !== identity.branchName)) throw new ConfigurationError("The saved task worktree ownership changed. Preserve both checkouts and inspect the execution.");
      await ownership();
      const initialTarget = await head(source.root);
      const transport = await transportConfiguration(source.root, options, signal);
      if (state.remoteIdentity && state.remoteIdentity !== transport.identity) throw new ConfigurationError("Configured remote identity changed or its Git transport configuration changed. Review the publication target before retrying.");
      await save({ ownership: identity, remoteIdentity: state.remoteIdentity ?? transport.identity });
      if (await exists(resource)) {
        if ((await lstat(resource)).isSymbolicLink() || !await exists(marker) || await readFile(marker, "utf8") !== markerText) throw new ConfigurationError("An unowned integration directory exists. Inspect it without deleting unrelated work.");
        ownedResource = true;
        await cleanup();
      }
      await authorize();
      await mkdir(resource, { recursive: true, mode: 0o700 });
      await writeFile(marker, markerText, { flag: "wx", mode: 0o600 });
      ownedResource = true;
      await mkdir(join(transportDirectory, "refs"), { recursive: true, mode: 0o700 });
      await writeFile(join(transportDirectory, "config"), transport.configuration, { mode: 0o600 });
      await writeFile(join(transportDirectory, "HEAD"), `ref: ${targetRef}\n`, { mode: 0o600 });
      await writeFile(join(transportDirectory, "packed-refs"), `${await git(source.root, ["for-each-ref", "--format=%(objectname) %(refname)"])}\n`, { mode: 0o600 });
      await symlink(resolve(source.root, await git(source.root, ["rev-parse", "--git-path", "objects"])), join(transportDirectory, "objects"), "dir");
      await symlink(join(source.common, "hooks"), join(transportDirectory, "hooks"), "dir");
      await symlink(join(source.common, "info"), join(transportDirectory, "info"), "dir");
      if (await exists(join(source.common, "shallow"))) await copyFile(join(source.common, "shallow"), join(transportDirectory, "shallow"));
      transportEnvironment = {
        ...transport.environment, GIT_DIR: transportDirectory, GIT_COMMON_DIR: transportDirectory, GIT_WORK_TREE: source.root,
        GIT_INDEX_FILE: resolve(source.root, await git(source.root, ["rev-parse", "--git-path", "index"])),
        GIT_OBJECT_DIRECTORY: undefined, GIT_CONFIG: undefined, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: undefined,
      };
      let localRemote: string | undefined;
      if (transport.url.startsWith("file://")) {
        try { localRemote = fileURLToPath(transport.url); }
        catch { throw new ConfigurationError("The configured file remote URL cannot be resolved to a local repository."); }
      } else if (isAbsolute(transport.url) || transport.url.startsWith("./") || transport.url.startsWith("../") || !transport.url.includes(":")) localRemote = resolve(source.root, transport.url);
      if (localRemote) {
        const directory = await execute(source.root, ["git", "-C", localRemote, "rev-parse", "--absolute-git-dir"], signal, transport.environment);
        const system = await execute(source.root, ["git", "var", "GIT_CONFIG_SYSTEM"], signal, transport.environment);
        const global = await execute(source.root, ["git", "var", "GIT_CONFIG_GLOBAL"], signal, transport.environment);
        if (directory.code !== 0 || system.code !== 0 || global.code !== 0) throw new ConfigurationError("Cannot preserve the local remote's receive policy. Use a Git version that reports GIT_CONFIG_SYSTEM and GIT_CONFIG_GLOBAL paths.");
        const gitDirectory = directory.stdout.endsWith("\n") ? directory.stdout.slice(0, -1) : directory.stdout;
        const globals = join(transportDirectory, "global-conditions");
        const condition = gitDirectory.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("?", "\\?").replaceAll("[", "\\[");
        const systemPaths = system.stdout.split("\n").filter(Boolean);
        const paths = [
          ...(systemPaths.length && transport.environment.GIT_CONFIG_SYSTEM !== undefined ? [transport.environment.GIT_CONFIG_SYSTEM] : systemPaths),
          ...(transport.environment.GIT_CONFIG_GLOBAL !== undefined ? [transport.environment.GIT_CONFIG_GLOBAL] : global.stdout.split("\n").filter(Boolean)),
        ].filter(Boolean);
        await writeFile(globals, gitConfiguration(paths.map((path) => ({ section: "includeIf", subsection: `gitdir:${condition}`, name: "path", value: path }))), { mode: 0o600 });
        transportEnvironment.GIT_CONFIG_GLOBAL = globals;
      }
      let remote = await remoteHead();
      const publishing = state.remoteBefore !== undefined || state.stage === "publishing" || state.stage === "published" || state.stage === "completed" || state.publishedAt !== undefined;
      if (publishing && !state.integratedCommit) throw new ConfigurationError("The saved publication checkpoint lacks its integrated commit. Inspect the remote before retrying.");
      let alreadyPublished = false;
      if (state.integratedCommit && remote) {
        if (remote !== state.integratedCommit) await fetchRemote(remote);
        alreadyPublished = await ancestor(state.integratedCommit, remote);
      }
      if (publishing && !alreadyPublished && (remote ?? null) !== state.remoteBefore) throw new ConfigurationError("Publication acknowledgement is uncertain and the remote changed. Inspect the remote history; no push was replayed.");
      let taskHead = await head(task.root);
      if (state.taskCommit) {
        if (taskHead !== state.taskCommit) throw new ConfigurationError("The task branch changed after its commit receipt. Preserve the new work and review ownership.");
        await clean(task.root);
      } else {
        if (state.taskBefore && taskHead !== state.taskBefore) {
          const parents = (await git(task.root, ["show", "-s", "--format=%P", taskHead])).split(" ");
          const tree = await git(task.root, ["rev-parse", `${taskHead}^{tree}`]);
          const message = await git(task.root, ["show", "-s", "--format=%B", taskHead]);
          if (parents.length !== 1 || parents[0] !== state.taskBefore || !state.taskTree || tree !== state.taskTree || !message.split("\n").includes(`Itsaplan-Workflow: ${token}`)) throw new ConfigurationError("The task branch advanced without a matching durable commit intent. Inspect its history before retrying.");
          await clean(task.root);
        } else {
          const dirty = await git(task.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
          if (dirty) {
            await save({ stage: "committing", taskBefore: state.taskBefore ?? taskHead });
            await ownership();
            await authorize();
            await git(task.root, ["add", "--all"]);
            const tree = await git(task.root, ["write-tree"]);
            if (state.taskTree && state.taskTree !== tree) throw new ConfigurationError("Task contents changed after the saved commit intent. Preserve the changes and review the task before retrying.");
            await save({ taskTree: tree });
            await ownership();
            if (await head(task.root) !== taskHead) throw new ConfigurationError("The task branch changed before commit creation.");
            await authorize();
            await git(task.root, ["commit", "-m", `${input.issueIdentifier}: complete delegated task`, "-m", `Itsaplan-Workflow: ${token}`]);
            taskHead = await head(task.root);
            if (await git(task.root, ["rev-parse", `${taskHead}^{tree}`]) !== tree || await git(task.root, ["show", "-s", "--format=%P", taskHead]) !== state.taskBefore) throw new ConfigurationError("A commit hook changed the intended task tree/history. Inspect the preserved task commit before retrying.");
            await clean(task.root);
          }
        }
        if (await ancestor(taskHead, initialTarget)) throw new ConfigurationError("The task branch has no unpublished implementation commit. No empty or invented commit was created.");
        await save({ taskCommit: taskHead, stage: "validating" });
      }
      const taskFiles = (await git(task.root, ["ls-files", "-z"])).split("\0").filter(Boolean);
      await save({});
      await authorize();
      const checks = options.checks.length ? options.checks.map((command) => ({ command, directory: "" })) : await discoverChecks(task.root, taskFiles, signal);
      await validate(task.root, state.taskCommit!, checks);
      if (state.integratedCommit) {
        if (!state.targetBefore || !await ancestor(state.taskCommit!, state.integratedCommit) || !await ancestor(state.targetBefore, state.integratedCommit)) throw new ConfigurationError("The integration receipt has ambiguous history. Inspect the saved commits before retrying.");
      }
      let integrated = state.integratedCommit;
      let base = initialTarget;
      if (!alreadyPublished) {
        if (remote) {
          await fetchRemote(remote);
          if (!await ancestor(initialTarget, remote)) throw new ConfigurationError("Local target has unpublished or divergent commits. Reconcile it with the remote outside automatic publication.");
          base = remote;
        }
        if (integrated && state.targetBefore !== base) throw new ConfigurationError("The target advanced after the integration receipt. Review the preserved commits before retrying.");
      }
      if (!integrated) {
        const bases = (await git(task.root, ["merge-base", "--all", base, state.taskCommit!])).split("\n").filter(Boolean);
        if (bases.length !== 1) throw new ConfigurationError("Task and target histories are unrelated or ambiguous. Reconcile them outside automatic publication.");
        await save({ stage: "integrating", targetBefore: base });
        await ownership();
        await authorize();
        await git(source.root, ["worktree", "add", "--detach", integration, base]);
        await save({});
        await authorize();
        await git(integration, ["merge", "--no-ff", "--no-edit", "-m", `${input.issueIdentifier}: integrate delegated task`, state.taskCommit!]);
        integrated = await head(integration);
        await clean(integration);
        await save({ integratedCommit: integrated });
      } else {
        await save({ stage: "integrating" });
        await authorize();
        await git(source.root, ["worktree", "add", "--detach", integration, integrated]);
      }
      const combinedFiles = (await git(integration, ["ls-files", "-z"])).split("\0").filter(Boolean);
      for (const manifest of combinedFiles.filter((file) => basename(file) === "package.json")) {
        const location = join(dirname(manifest), "node_modules");
        if (!await exists(join(integration, location)) && await exists(join(task.root, location))) {
          await save({});
          await authorize();
          await symlink(await realpath(join(task.root, location)), join(integration, location), "dir");
        }
      }
      for (const manifest of combinedFiles.filter((file) => basename(file) === "Package.swift")) {
        const build = join(dirname(manifest), ".build");
        if (await exists(join(task.root, build, "workspace-state.json"))) {
          await save({});
          await authorize();
          await mkdir(join(integration, build), { recursive: true });
          await copyFile(join(task.root, build, "workspace-state.json"), join(integration, build, "workspace-state.json"));
          for (const folder of ["checkouts", "repositories", "artifacts"]) if (await exists(join(task.root, build, folder))) await symlink(await realpath(join(task.root, build, folder)), join(integration, build, folder), "dir");
        }
      }
      await authorize();
      const combinedChecks = options.checks.length ? checks : await discoverChecks(integration, combinedFiles, signal);
      await validate(integration, integrated, combinedChecks);
      if (!alreadyPublished) {
        await ownership();
        await clean(task.root);
        if (await head(task.root) !== state.taskCommit || await head(source.root) !== initialTarget || await head(integration) !== integrated) throw new ConfigurationError("Task, integration, or local target changed during validation. No push was attempted.");
        if (await remoteHead() !== remote) throw new ConfigurationError("The remote target advanced after validation. No push was attempted.");
        await save({ stage: "publishing", remoteBefore: remote ?? null });
        await ownership();
        await assertRemote();
        await authorize();
        const pushed = await transportGit(["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", options.remote, `${integrated}:${targetRef}`]);
        const observed = await remoteHead();
        if (observed && observed !== integrated) await fetchRemote(observed);
        if (!observed || !await ancestor(integrated, observed)) throw new ConfigurationError(pushed.code ? "Remote publication was rejected or unacknowledged. The durable publishing checkpoint is retained; inspect the remote before retrying." : "Git push returned success but remote publication could not be verified. The durable publishing checkpoint is retained.");
        remote = observed;
      }
      if (!integrated || !remote || !await ancestor(integrated, remote)) throw new ConfigurationError("Remote publication has not been positively verified.");
      await ownership();
      const local = await head(source.root);
      const localContainsIntegration = await ancestor(integrated, local);
      if (!localContainsIntegration && !await ancestor(local, integrated)) throw new ConfigurationError("Publication is verified, but the local target changed and cannot fast-forward safely. Reconcile the local target before retrying.");
      if (!localContainsIntegration) {
        await save({ stage: "publishing" });
        await ownership();
        await authorize();
        await git(source.root, ["merge", "--ff-only", "--no-overwrite-ignore", "--no-edit", integrated]);
      }
      await ownership();
      if (!await ancestor(integrated, await head(source.root))) throw new ConfigurationError("The local target does not contain the verified integration commit.");
      const finalRemote = await remoteHead();
      if (finalRemote && finalRemote !== integrated) await fetchRemote(finalRemote);
      if (!finalRemote || !await ancestor(integrated, finalRemote)) throw new ConfigurationError("The remote no longer contains the integration commit. Publication is not complete.");
      await save({ stage: "published", publishedAt: state.publishedAt ?? Date.now(), error: undefined });
      return state;
    } finally { await cleanup(); }
  });
}
