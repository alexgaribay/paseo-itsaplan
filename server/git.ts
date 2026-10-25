import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "./errors";

const execute = promisify(execFile);
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execute("git", ["-C", cwd, ...args], {
    timeout: 5_000, maxBuffer: 1024 * 1024, signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined },
  });
  return stdout.trim();
}

export async function repository(path: string, signal?: AbortSignal): Promise<{ root: string; common: string }> {
  signal?.throwIfAborted();
  if (!isAbsolute(path) || path.includes("\0")) throw new ConfigurationError("Repository must be an absolute Git checkout root");
  try {
    const root = await realpath(path);
    const marker = await lstat(join(root, ".git"));
    if (!marker.isFile() && !marker.isDirectory()) throw new Error("Unsafe Git marker");
    const top = await realpath(await git(root, ["rev-parse", "--show-toplevel"], signal));
    if (top !== root) throw new Error("Not a checkout root");
    const common = await realpath(resolve(root, await git(root, ["rev-parse", "--git-common-dir"], signal)));
    return { root, common };
  } catch {
    signal?.throwIfAborted();
    throw new ConfigurationError("Repository must resolve to a canonical Git checkout root with a .git file or directory");
  }
}
