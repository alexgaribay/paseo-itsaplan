import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PaseoApi, PaseoProject } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LinkedRepository } from "../shared/models";
import { matchRepositories, readRepositoryCatalog, type LocalRepository } from "./repository-matching";

const execute = promisify(execFile);
let directory: string;
let savedEnvironment: Record<string, string | undefined>;
const environmentKeys = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT"];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "itsaplan-repositories-")));
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const home = join(directory, "home");
  await mkdir(home);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_COUNT = "0";
});

afterEach(async () => {
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

async function checkout(name: string, remotes: string[] = []): Promise<string> {
  const root = join(directory, name);
  await execute("git", ["init", "--initial-branch=main", root]);
  for (const [index, remote] of remotes.entries()) await execute("git", ["-C", root, "config", "--local", "--add", `remote.fixture${index}.url`, remote]);
  return root;
}

function project(projectId: string, projectRootPath: string, projectKind: PaseoProject["projectKind"] = "git"): PaseoProject {
  return { projectId, projectDisplayName: projectId, projectRootPath, projectKind };
}

function paseo(projects: PaseoProject[]): PaseoApi {
  return { projects: { list: async () => ({ requestId: "fixture", projects }) } } as unknown as PaseoApi;
}

function linked(webUrl: string, id = 1): LinkedRepository {
  return { id, provider: "irrelevant", fullName: "not-used/not-used", webUrl };
}

function local(paseoProjectId: string, remotes: string[], common = `/git/${paseoProjectId}`): LocalRepository {
  return { paseoProjectId, name: paseoProjectId, repository: `/checkouts/${paseoProjectId}`, common, remotes };
}

function candidate(paseoProjectId: string) {
  return { paseoProjectId, name: paseoProjectId, repository: `/checkouts/${paseoProjectId}` };
}

describe("repository identity", () => {
  test.each([
    "git@Forge.Example:Group/Nested/Repo.git",
    "ssh://git@FORGE.example/Group/Nested/Repo.git/",
    "ssh://git@forge.example:22/Group/Nested/Repo",
    "https://forge.example:443/Group/Nested/Repo.git",
    "https://username:secret@forge.example/Group/Nested/Repo.git",
  ])("matches standard remote form %s", (remote) => {
    expect(matchRepositories([linked("https://FORGE.example/Group/Nested/Repo/")], [local("one", [remote])])).toEqual({ status: "matched", candidate: candidate("one") });
  });

  test("keeps host and repository path case significant where required", () => {
    const catalog = [local("other-host", ["git@other.example:Group/Repo.git"]), local("other-case", ["git@forge.example:group/repo.git"]), local("correct", ["git@forge.example:Group/Repo.git"])];
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: candidate("correct") });
    expect(matchRepositories([linked("https://missing.example/Group/Repo")], catalog).status).toBe("unmatched");
  });

  test("preserves nondefault ports and does not infer custom transport equivalence", () => {
    const catalog = [local("ssh", ["ssh://git@forge.example:8443/Group/Repo.git"]), local("https", ["https://forge.example:8443/Group/Repo.git"]), local("default", ["git@forge.example:Group/Repo.git"])];
    expect(matchRepositories([linked("https://forge.example:8443/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: candidate("https") });
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: candidate("default") });
    expect(matchRepositories([linked("https://forge.example:9443/Group/Repo")], catalog).status).toBe("unmatched");
  });

  test("matches HTTP forge links only to the same HTTP endpoint", () => {
    const catalog = [local("plain", ["http://forge.example:80/Group/Repo.git"]), local("tls", ["https://forge.example/Group/Repo.git"])];
    expect(matchRepositories([linked("http://forge.example/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: candidate("plain") });
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: candidate("tls") });
  });

  test.each([
    "--upload-pack=secret", "/Group/Repo", "Group/Repo", "file:///Group/Repo", "git://forge.example/Group/Repo",
    "https://forge.example/Group/../Repo", "https://forge.example/Group/%2e%2e/Repo", "https://forge.example/Group%2fRepo", "https://forge.example/Group%5cRepo",
    "https://forge.example/Group//Repo", "https://forge.example/Group/Repo?token=secret", "https://forge.example/Group/Repo#fragment", "https://forge.example:0/Group/Repo",
    "https://forge.example:65536/Group/Repo", "https://forge.example/Group\\Repo", "https://forge.example/Group/Repo\n", "ssh://git:secret@forge.example/Group/Repo", "forge.example:/Group/Repo",
    "https://@forge.example/Group/Repo", "https://:secret@forge.example/Group/Repo", "git@forge.example:~/Group/Repo",
  ])("rejects unsafe or unsupported input %s", (unsafe) => {
    const valid = "https://forge.example/Group/Repo";
    expect(matchRepositories([linked(valid)], [local("safe", [valid]), local("unsafe", [unsafe])])).toEqual({ status: "matched", candidate: candidate("safe") });
    expect(matchRepositories([linked(unsafe)], [local("one", [valid])]).status).toBe("unmatched");
  });

  test("reports independent clones and multiple linked repositories as ambiguous", () => {
    const url = "https://forge.example/Group/Repo";
    expect(matchRepositories([linked(url)], [local("b", [url]), local("a", [url])])).toEqual({ status: "ambiguous", candidates: [candidate("a"), candidate("b")] });
    expect(matchRepositories([linked(url), linked("https://forge.example/Other/Repo", 2)], [local("a", [url]), local("b", ["git@forge.example:Other/Repo.git"])])).toEqual({ status: "ambiguous", candidates: [candidate("a"), candidate("b")] });
  });

  test("deduplicates worktrees by common directory rather than remote identity", () => {
    const url = "https://forge.example/Group/Repo";
    expect(matchRepositories([linked(url), linked(url, 2)], [local("a", [url], "/shared/git"), local("b", [url], "/shared/git")])).toEqual({ status: "matched", candidate: candidate("a") });
    expect(matchRepositories([], [local("a", [url])]).status).toBe("unmatched");
  });
});

describe("registered native project catalog", () => {
  test("propagates cancellation before catalog reads without producing a partial catalog", async () => {
    const controller = new AbortController();
    const reason = new Error("Fixture cancellation");
    controller.abort(reason);
    await expect(readRepositoryCatalog(paseo([]), controller.signal)).rejects.toBe(reason);
  });

  test("propagates cancellation received during the native project read", async () => {
    const controller = new AbortController();
    const reason = new Error("Fixture cancellation");
    const root = await checkout("valid", ["git@forge.example:Group/Repo.git"]);
    const api = {
      projects: {
        list: async () => {
          controller.abort(reason);
          return { requestId: "fixture", projects: [project("valid", root)] };
        },
      },
    } as unknown as PaseoApi;
    await expect(readRepositoryCatalog(api, controller.signal)).rejects.toBe(reason);
    expect(await readRepositoryCatalog(paseo([project("valid", root)]))).toEqual([{ paseoProjectId: "valid", name: "valid", repository: root, common: join(root, ".git"), remotes: ["https://forge.example/Group/Repo"] }]);
  });

  test("includes Git projects without workspaces and ignores unregistered and non-Git projects", async () => {
    const root = await checkout("registered", ["git@forge.example:Group/Repo.git"]);
    const unregistered = await checkout("unregistered", ["git@forge.example:Group/Repo.git"]);
    const catalog = await readRepositoryCatalog(paseo([project("registered", root), project("directory", unregistered, "directory"), project("non-git", join(directory, "not-present"), "non_git")]));
    expect(catalog).toEqual([{ paseoProjectId: "registered", name: "registered", repository: root, common: join(root, ".git"), remotes: ["https://forge.example/Group/Repo"] }]);
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: { paseoProjectId: "registered", name: "registered", repository: root } });
  });

  test("reads all local remote URLs without returning embedded credentials", async () => {
    const root = await checkout("registered", ["https://username:secret@forge.example/Group/Repo.git", "git@other.example:Nested/Group/Repo.git", "file:///private/Repo"]);
    await execute("git", ["-C", root, "config", "--local", "--add", "remote.fixture0.url", "ssh://git@third.example/Group/Repo.git"]);
    expect((await readRepositoryCatalog(paseo([project("registered", root)])))[0]?.remotes).toEqual(["https://forge.example/Group/Repo", "https://other.example/Nested/Group/Repo", "https://third.example/Group/Repo"]);
  });

  test("retains a valid checkout with no remotes without matching it by name", async () => {
    const root = await checkout("Repo");
    const catalog = await readRepositoryCatalog(paseo([project("Group/Repo", root)]));
    expect(catalog).toEqual([{ paseoProjectId: "Group/Repo", name: "Group/Repo", repository: root, common: join(root, ".git"), remotes: [] }]);
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog).status).toBe("unmatched");
  });

  test("collapses registered symlinks and worktrees but keeps independent clones", async () => {
    const root = await checkout("original", ["git@forge.example:Group/Repo.git"]);
    await execute("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Initial"]);
    const worktree = join(directory, "worktree");
    await execute("git", ["-C", root, "worktree", "add", "-b", "fixture", worktree]);
    const alias = join(directory, "alias");
    await symlink(root, alias);
    const clone = await checkout("clone", ["https://forge.example/Group/Repo.git"]);
    const catalog = await readRepositoryCatalog(paseo([project("c-alias", alias), project("b-worktree", worktree), project("a-main", root), project("d-clone", clone)]));
    expect(catalog.map(({ paseoProjectId, repository, common }) => ({ paseoProjectId, repository, common }))).toEqual([{ paseoProjectId: "a-main", repository: root, common: join(root, ".git") }, { paseoProjectId: "d-clone", repository: clone, common: join(clone, ".git") }]);
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog)).toEqual({ status: "ambiguous", candidates: [{ paseoProjectId: "a-main", name: "a-main", repository: root }, { paseoProjectId: "d-clone", name: "d-clone", repository: clone }] });
  });

  test("skips stale roots and removed Git markers without hiding a valid match", async () => {
    const root = await checkout("valid", ["git@forge.example:Group/Repo.git"]);
    const stale = join(directory, "stale");
    await mkdir(stale);
    const catalog = await readRepositoryCatalog(paseo([project("a-valid", root), project("b-missing", join(directory, "missing")), project("c-no-marker", stale)]));
    expect(catalog).toEqual([{ paseoProjectId: "a-valid", name: "a-valid", repository: root, common: join(root, ".git"), remotes: ["https://forge.example/Group/Repo"] }]);
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], catalog)).toEqual({ status: "matched", candidate: { paseoProjectId: "a-valid", name: "a-valid", repository: root } });
  });

  test("refuses partial matching after a real inspection failure without exposing credentials", async () => {
    const root = await checkout("valid", ["git@forge.example:Group/Repo.git"]);
    const broken = await checkout("broken");
    await writeFile(join(broken, ".git", "config"), "[remote \"https://username:secret@forge.example\"\n");
    let failure: unknown;
    try { await readRepositoryCatalog(paseo([project("a-valid", root), project("b-broken", broken)])); } catch (error) { failure = error; }
    expect(failure instanceof Error).toBe(true);
    expect(String(failure).includes("secret")).toBe(false);
    expect(matchRepositories([linked("https://forge.example/Group/Repo")], await readRepositoryCatalog(paseo([project("valid", root)])))).toEqual({ status: "matched", candidate: { paseoProjectId: "valid", name: "valid", repository: root } });
  });
});
