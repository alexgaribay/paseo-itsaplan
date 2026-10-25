import { projectMappingSchema, type Config, type ProjectMapping } from "../shared/config";
import type { LinkedRepository, Project, RepositoryMatch } from "../shared/models";
import type { Gateway, Protocol } from "./contracts";
import { ConfigurationError } from "./errors";
import { RequestError } from "./protocol";
import { matchRepositories, type LocalRepository } from "./repository-matching";

async function linkedRepositories(protocol: Protocol, projectId: number, signal?: AbortSignal): Promise<LinkedRepository[] | RepositoryMatch> {
  try {
    const linked = await protocol.repositories(projectId, signal);
    return linked.length ? linked : { status: "unmatched", reason: "No Git repository is linked to this It's a Plan project." };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unavailable", reason: error instanceof RequestError && error.status === 403
      ? "Repository metadata access denied. Use a repository override or review the external agent's repository permissions."
      : "Could not read this project's linked repository metadata." };
  }
}

export async function discoverProjects(protocol: Protocol, gateway: Gateway, signal?: AbortSignal): Promise<Project[]> {
  const projects = await protocol.projects(signal);
  const linked: (LinkedRepository[] | RepositoryMatch)[] = [];
  for (let offset = 0; offset < projects.length; offset += 4) {
    linked.push(...await Promise.all(projects.slice(offset, offset + 4).map((project) => linkedRepositories(protocol, project.id, signal))));
  }
  let catalog: LocalRepository[] = [];
  let catalogError: RepositoryMatch | undefined;
  if (linked.some(Array.isArray)) {
    try { catalog = await gateway.repositories(signal); }
    catch { catalogError = { status: "unavailable", reason: "Could not inspect this Paseo host's registered Git repositories." }; }
  }
  signal?.throwIfAborted();
  return projects.map((project, index) => {
    const metadata = linked[index]!;
    return { ...project, repositoryMatch: Array.isArray(metadata) ? catalogError ?? matchRepositories(metadata, catalog) : metadata };
  });
}

export async function resolveProject(config: Config, protocol: Protocol, gateway: Gateway, projectId: string, signal?: AbortSignal): Promise<ProjectMapping> {
  const configured = config.projects[projectId] ?? projectMappingSchema.parse({});
  if (configured.repository) return configured;
  const linked = await linkedRepositories(protocol, Number(projectId), signal);
  let match: RepositoryMatch;
  if (!Array.isArray(linked)) match = linked;
  else {
    try { match = matchRepositories(linked, await gateway.repositories(signal)); }
    catch { signal?.throwIfAborted(); throw new ConfigurationError("Could not inspect this Paseo host's registered Git repositories. Configure an explicit repository override."); }
  }
  signal?.throwIfAborted();
  if (match.status === "matched") return { ...configured, repository: match.candidate.repository };
  if (match.status === "ambiguous") throw new ConfigurationError("Multiple local checkouts match this project's linked repositories. Choose a repository override.");
  throw new ConfigurationError(match.reason);
}
