import type { PaseoApi } from "@getpaseo/client";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LinkedRepository, RepositoryCandidate, RepositoryMatch } from "../shared/models";
import { git, repository } from "./git";

export interface LocalRepository extends RepositoryCandidate {
  common: string;
  remotes: string[];
}

function identity(value: string, webOnly = false): string | undefined {
  if (!value || /[^\x21-\x7e]|[%\\?#]/.test(value) || value.startsWith("-")) return;
  let protocol: string;
  let host: string;
  let port: string;
  let path: string;
  if (value.includes("://")) {
    const parts = /^(https|http|ssh):\/\/([^/]+)(\/.*)$/.exec(value);
    if (!parts || (webOnly && parts[1] === "ssh")) return;
    protocol = parts[1]!;
    const authority = parts[2]!;
    const address = authority.slice(authority.lastIndexOf("@") + 1);
    if (protocol === "ssh" && authority.includes("@") && !/^[A-Za-z0-9._~-]+@/.test(authority)) return;
    if (authority.includes("@") && authority.indexOf("@") !== authority.lastIndexOf("@")) return;
    if (authority.includes("@") && !/^[^:@]+(?::[^@]*)?@/.test(authority)) return;
    const endpoint = /^([A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(address);
    if (!endpoint) return;
    host = endpoint[1]!.toLowerCase();
    port = endpoint[2] ?? "";
    path = parts[3]!.slice(1);
  } else {
    if (webOnly) return;
    const parts = /^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(value);
    if (!parts) return;
    protocol = "ssh";
    host = parts[1]!.toLowerCase();
    port = "";
    path = parts[2]!;
  }
  if (!host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return;
  if (port) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return;
    port = String(number);
    if ((protocol === "https" && port === "443") || (protocol === "http" && port === "80") || (protocol === "ssh" && port === "22")) port = "";
  }
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  const segments = path.split("/");
  if (segments.length < 2 || !segments.every((part) => /^[A-Za-z0-9._~-]+$/.test(part) && part !== "." && part !== ".." && !part.startsWith("-") && !part.startsWith("~"))) return;
  // Custom ports and plaintext HTTP are not evidence of cross-transport equivalence.
  return `${port || protocol === "http" ? protocol : "https"}://${host}${port ? `:${port}` : ""}/${path}`;
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function readRepositoryCatalog(paseo: PaseoApi, signal?: AbortSignal): Promise<LocalRepository[]> {
  try {
    signal?.throwIfAborted();
    const { projects } = await paseo.projects.list();
    signal?.throwIfAborted();
    const catalog = new Map<string, LocalRepository>();
    for (const project of [...projects].sort((a, b) => order(a.projectId, b.projectId))) {
      signal?.throwIfAborted();
      if (project.projectKind !== "git") continue;
      if (!isAbsolute(project.projectRootPath) || project.projectRootPath.includes("\0")) throw new Error("Invalid registered checkout root");
      try {
        await lstat(project.projectRootPath);
        await lstat(join(project.projectRootPath, ".git"));
      } catch (error) {
        signal?.throwIfAborted();
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      signal?.throwIfAborted();
      const { root, common } = await repository(project.projectRootPath, signal);
      signal?.throwIfAborted();
      let output: string;
      try {
        output = await git(root, ["config", "--local", "--null", "--get-regexp", "^remote\\..*\\.url$"], signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (typeof error === "object" && error !== null && "code" in error && error.code === 1 && "stdout" in error && error.stdout === "") output = "";
        else throw error;
      }
      signal?.throwIfAborted();
      const remotes = new Set<string>();
      for (const entry of output.split("\0")) {
        if (!entry) continue;
        const separator = entry.indexOf("\n");
        if (separator < 0) throw new Error("Invalid Git configuration output");
        const remote = identity(entry.slice(separator + 1));
        if (remote) remotes.add(remote);
      }
      const existing = catalog.get(common);
      if (existing) existing.remotes = [...new Set([...existing.remotes, ...remotes])].sort(order);
      else catalog.set(common, { paseoProjectId: project.projectId, name: project.projectDisplayName, repository: root, common, remotes: [...remotes].sort(order) });
    }
    signal?.throwIfAborted();
    return [...catalog.values()];
  } catch {
    signal?.throwIfAborted();
    // Never return a partial scan as proof that a matching checkout is unique.
    throw new Error("Unable to inspect all registered Paseo Git projects");
  }
}

export function matchRepositories(repositories: LinkedRepository[], catalog: LocalRepository[]): RepositoryMatch {
  const identities = new Set(repositories.map((linked) => identity(linked.webUrl, true)).filter((value): value is string => value !== undefined));
  const matches = new Map<string, RepositoryCandidate>();
  for (const local of catalog) {
    if (!local.remotes.some((remote) => {
      const normalized = identity(remote);
      return normalized !== undefined && identities.has(normalized);
    })) continue;
    if (!matches.has(local.common)) matches.set(local.common, { paseoProjectId: local.paseoProjectId, name: local.name, repository: local.repository });
  }
  const candidates = [...matches.values()].sort((a, b) => order(a.paseoProjectId, b.paseoProjectId));
  if (candidates.length === 1) return { status: "matched", candidate: candidates[0]! };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "unmatched", reason: "No registered Paseo checkout matches a linked repository" };
}
