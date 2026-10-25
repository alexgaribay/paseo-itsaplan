import type { Config, ProjectMapping, Selection } from "../shared/config";
import type { ExecutionPlan } from "../shared/experience";
import type { Issue } from "../shared/models";
import type { Protocol } from "./contracts";

type Source = ExecutionPlan["sources"]["provider"];
type PreferenceLayer = { source: Source; value: Partial<Selection> };
function preferences(layers: PreferenceLayer[]): { selection: Selection; sources: ExecutionPlan["sources"] } {
  const provider = layers.find(({ value }) => value.provider);
  let inheritedProvider = "";
  let model: (typeof layers)[number] | undefined;
  let mode: (typeof layers)[number] | undefined;
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    inheritedProvider = layer.value.provider || inheritedProvider;
    if (inheritedProvider && inheritedProvider !== provider?.value.provider) continue;
    if (layer.value.model) model = layer;
    if (layer.value.modeId) mode = layer;
  }
  return {
    selection: { provider: provider?.value.provider ?? "", model: model?.value.model ?? "", modeId: mode?.value.modeId ?? "" },
    sources: { provider: provider?.source ?? "provider", model: model?.source ?? "provider", mode: mode?.source ?? "provider" },
  };
}
export function resolvePreferences(config: Config, project: ProjectMapping, override: Partial<Selection> = {}, overrideSource: "manual" | "issue" = "issue"): { selection: Selection; sources: ExecutionPlan["sources"] } {
  return preferences([
    { source: overrideSource, value: override }, { source: "project", value: project },
    { source: "global", value: { provider: config.defaultProvider, model: config.defaultModel, modeId: config.defaultModeId } },
  ]);
}
export async function executionPreferences(protocol: Pick<Protocol, "issueSelection">, config: Config, project: ProjectMapping, issue?: Issue, explicit: Partial<Selection> = {}, signal?: AbortSignal): Promise<{ selection: Selection; sources: ExecutionPlan["sources"] }> {
  const field = issue && project.fieldBindings?.length ? await protocol.issueSelection(issue, project, signal) : {};
  return preferences([
    { source: "manual", value: explicit },
    { source: "issue", value: issue ? config.issueOverrides[String(issue.id)] ?? {} : {} },
    { source: "field", value: field },
    { source: "project", value: project },
    { source: "global", value: { provider: config.defaultProvider, model: config.defaultModel, modeId: config.defaultModeId } },
  ]);
}
export function makePlan(config: Config, project: ProjectMapping, selection: Selection, input: { projectId: string; issueId: number | null; issueIdentifier: string | null; host?: { id: string; label: string }; override?: Partial<Selection>; overrideSource?: "manual" | "issue"; sources?: ExecutionPlan["sources"] }): ExecutionPlan {
  const sources = input.sources ?? resolvePreferences(config, project, input.override, input.overrideSource).sources;
  return {
    issueId: input.issueId, issueIdentifier: input.issueIdentifier, projectId: input.projectId,
    hostId: input.host?.id ?? null, hostLabel: input.host?.label ?? null,
    repository: project.repository, workspaceId: project.workspaceId || null, selection, sources,
    worktree: project.worktree, baseBranch: project.baseBranch, defaultModelUnresolved: !selection.model,
    noToolsEnforcement: "instruction-only",
    warnings: [
      ...(!selection.model ? ["Paseo resolves the model when the session is created. A provider default is not a pinned model."] : []),
      ...(!project.worktree ? ["This execution uses the configured checkout without an isolated worktree."] : []),
    ],
  };
}
