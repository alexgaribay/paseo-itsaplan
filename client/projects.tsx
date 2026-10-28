import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePaseo, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { BotScope, useBotId, useBotRpc as useRpc } from "./bot-context";
import { Icon, Modal, SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { projectMappingSchema, type Config, type ProjectMapping, type Selection } from "../shared/config";
import type { Readiness } from "../shared/experience";
import type { Project, RepositoryMatch } from "../shared/models";
import { providersRpc } from "../shared/rpc";
import { Feedback, ProviderErrors, RefreshButton, SelectionFields, useResource } from "./common";
import { PolicyFields } from "./mappings";
import { ContextSettings } from "./context-settings";
import { WorkflowFields, workflowInfo } from "./workflow";

type ProjectRow = { id: string; title: string };

function savedReadinessHint(readiness?: Readiness["projects"][number]): string {
  if (!readiness) return "Last saved readiness not checked. Save changes and run readiness.";
  const state = !readiness.automatic ? "Last saved automatic execution explicitly disabled." : readiness.ready ? "Last saved project checks passed." : "Last saved project checks blocked.";
  return [state, ...readiness.problems].join(" ");
}

function ProjectEditor({ projectId, title, initial, match, config, onApply, onRemove, onClose, disabled, ...props }: PluginSurfaceProps & {
  projectId: number;
  title: string;
  initial?: ProjectMapping;
  match?: RepositoryMatch;
  config: Config;
  onApply(mapping: ProjectMapping): void;
  onRemove(): void;
  onClose(): void;
  disabled: boolean;
}) {
  const botId = useBotId();
  const [mapping, setMapping] = useState<ProjectMapping>(() => initial || projectMappingSchema.parse({}));
  const set = (patch: Partial<ProjectMapping>) => setMapping((current) => ({ ...current, ...patch }));
  const [fieldValidation, setFieldValidation] = useState<{ bindings: ProjectMapping["fieldBindings"]; error?: string }>();
  const [workflowEditorError, setWorkflowEditorError] = useState<string>();
  const onFieldValidation = useCallback((error?: string) => setFieldValidation({ bindings: mapping.fieldBindings, error }), [mapping.fieldBindings]);
  const fieldError = mapping.fieldBindings?.length ? fieldValidation?.bindings !== mapping.fieldBindings ? "Validating saved field bindings…" : fieldValidation?.error : undefined;
  const matchedPath = match?.status === "matched" ? match.candidate.repository : "";
  const paseo = usePaseo();
  const loadProjects = useCallback(() => paseo.projects.list(), [paseo]);
  const localProjects = useResource(loadProjects);
  const loadWorkspaces = useCallback(() => paseo.workspaces.list(), [paseo]);
  const workspaces = useResource(loadWorkspaces);
  const discover = useRpc(providersRpc);
  const [discoveryCwd, setDiscoveryCwd] = useState(mapping.repository || matchedPath);
  const loadProviders = useCallback(() => discover({ cwd: discoveryCwd || undefined }), [discover, discoveryCwd]);
  const catalog = useResource(loadProviders);
  const repositoryInput = useRef<SettingsInputHandle>(null);
  const [manualWorkspace, setManualWorkspace] = useState(false);
  const workspaceChoices = (workspaces.data?.entries || []).map((workspace) => ({ value: workspace.id, label: workspace.name || workspace.id, repository: workspace.projectRootPath }));
  const options = [{ value: "", label: "No workspace override" }, ...workspaceChoices.map(({ value, label }) => ({ value, label }))];
  if (mapping.workspaceId && !workspaceChoices.some((workspace) => workspace.value === mapping.workspaceId)) options.push({ value: mapping.workspaceId, label: `Saved workspace (${mapping.workspaceId})` });
  options.push({ value: "__manual__", label: "Enter workspace ID…" });
  const projectChoices = localProjects.data?.projects || [];
  const selectedProject = mapping.repository ? projectChoices.find((project) => project.projectRootPath === mapping.repository) : undefined;
  const projectOptions = [
    { value: "", label: "Automatic repository match" },
    ...projectChoices.map((project) => ({ value: project.projectRootPath, label: `${project.projectKind === "git" ? "" : "Not Git · "}${project.projectDisplayName} · ${project.projectRootPath}` })),
  ];
  if (mapping.repository && !selectedProject) projectOptions.push({ value: mapping.repository, label: `Custom override · ${mapping.repository}` });
  const validation = projectMappingSchema.safeParse(mapping);
  const absolute = !mapping.repository || mapping.repository.startsWith("/") || /^[A-Za-z]:[\\/]/.test(mapping.repository);
  const error = !absolute ? "Enter an absolute Git repository path." : selectedProject && selectedProject.projectKind !== "git" ? "This Paseo project is not a Git checkout. Choose a Git project for execution." : manualWorkspace && !mapping.workspaceId ? "Enter a workspace ID or choose No workspace override." : !validation.success ? validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n") : workflowEditorError || undefined;
  return <Modal title={title} icon={<Icon name="FolderGit2" size={18} color={props.theme.colors.foreground} />} open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Content>
      <SettingsSection title="Repository" info="Choose a project registered on this Paseo host, including projects without an active workspace. Automatic repository matching is the default. A project or workspace selection sets an explicit override; execution requires a valid Git checkout." trailing={<RefreshButton theme={props.theme} label="Refresh Paseo projects" disabled={disabled || localProjects.loading || workspaces.loading} onPress={() => { localProjects.refresh(); workspaces.refresh(); }} />}>
        <SettingsCard>
          <SettingsSelect label="Paseo project" value={mapping.repository} options={projectOptions} disabled={disabled || localProjects.loading} onValueChange={(repository) => {
            repositoryInput.current?.replaceText(repository);
            setManualWorkspace(false);
            const project = projectChoices.find((item) => item.projectRootPath === repository);
            setDiscoveryCwd(project && project.projectKind !== "git" ? "" : repository || matchedPath);
            set({ repository, workspaceId: "" });
          }} />
          <SettingsSelect label="Workspace override" value={manualWorkspace ? "__manual__" : mapping.workspaceId} options={options} disabled={disabled} onValueChange={(workspaceId) => {
            if (workspaceId === "__manual__") { setManualWorkspace(true); return; }
            setManualWorkspace(false);
            const workspace = workspaceChoices.find((item) => item.value === workspaceId);
            if (workspace) { repositoryInput.current?.replaceText(workspace.repository); setDiscoveryCwd(workspace.repository); }
            set({ workspaceId, ...(workspace ? { repository: workspace.repository } : {}) });
          }} />
          {manualWorkspace && <SettingsInput label="Workspace ID" initialValue={mapping.workspaceId} disabled={disabled} onChangeText={(workspaceId) => set({ workspaceId: workspaceId.trim() })} />}
          {match?.status === "ambiguous" && <SettingsSelect label="Matching checkout" value={mapping.repository} options={[{ value: "", label: "Choose a checkout" }, ...match.candidates.map((candidate) => ({ value: candidate.repository, label: `${candidate.name} · ${candidate.repository}` })), ...(mapping.repository && !match.candidates.some((candidate) => candidate.repository === mapping.repository) ? [{ value: mapping.repository, label: "Custom override" }] : [])]} disabled={disabled} onValueChange={(repository) => { repositoryInput.current?.replaceText(repository); setManualWorkspace(false); setDiscoveryCwd(repository); set({ repository, workspaceId: "" }); }} />}
          <SettingsInput ref={repositoryInput} label="Repository override" placeholder={matchedPath || "Match linked repository"} initialValue={mapping.repository} disabled={disabled} onChangeText={(repository) => { setManualWorkspace(false); set({ repository, workspaceId: "" }); }} />
          <SettingsSwitch label="Automatic execution" hint="On by default. Requires global automatic delegation. Turning this off is the explicit opt-out and does not exclude the project from global claims." value={mapping.automatic} disabled={disabled} onValueChange={(automatic) => set({ automatic })} />
          <SettingsSwitch label="Isolated worktree" value={mapping.worktree} disabled={disabled} onValueChange={(worktree) => set({ worktree })} />
          {mapping.worktree && <SettingsInput label="Base branch" placeholder="Repository default" initialValue={mapping.baseBranch} disabled={disabled} onChangeText={(baseBranch) => set({ baseBranch: baseBranch.trim() })} />}
        </SettingsCard>
        <Feedback theme={props.theme} error={localProjects.error} message={localProjects.loading ? "Loading Paseo projects…" : !localProjects.error && !projectChoices.length ? "No Paseo projects are registered on this host. Add a Git project in Paseo or use a repository override." : undefined} />
        <Feedback theme={props.theme} error={workspaces.error} />
        {!mapping.repository && match && match.status !== "matched" && <Feedback theme={props.theme} message={match.status === "ambiguous" ? "Multiple checkouts match. Choose a repository override." : match.reason} />}
      </SettingsSection>
      <SettingsSection title="Agent defaults" info="Blank selections inherit the global defaults. Provider and model availability are checked again before execution." trailing={<RefreshButton theme={props.theme} label="Refresh project providers" disabled={disabled || catalog.loading} onPress={() => { setDiscoveryCwd(mapping.repository || matchedPath); catalog.refresh(); }} />}>
        <SettingsCard><SelectionFields value={mapping} onChange={set} providers={catalog.data || []} inheritedProvider={config.defaultProvider} disabled={disabled} /></SettingsCard>
        <ProviderErrors providers={(catalog.data || []).filter((provider) => provider.id === (mapping.provider || config.defaultProvider))} />
        <Feedback theme={props.theme} error={catalog.error} />
      </SettingsSection>
      <SettingsSection title="Git workflow" info={workflowInfo(mapping.workflow?.mode || config.workflow.mode, "project")}>
        <SettingsCard>
          <SettingsSelect label="Workflow settings" value={mapping.workflow ? "override" : "inherit"} options={[{ value: "inherit", label: "Inherit global workflow" }, { value: "override", label: "Override global workflow" }]} disabled={disabled} onValueChange={(mode) => { setWorkflowEditorError(undefined); set(mode === "override" ? { workflow: { ...config.workflow } } : { workflow: undefined }); }} />
        </SettingsCard>
        {mapping.workflow && <SettingsCard>
          <WorkflowFields theme={props.theme} value={mapping.workflow} onChange={(workflow) => set({ workflow })} onValidationChange={setWorkflowEditorError} disabled={disabled} columns />
        </SettingsCard>}
      </SettingsSection>
      <SettingsSection title="Issue status transitions" info="Optional destination column IDs for this project's milestones. Blank fields inherit global policies. Manual milestones are evidence-driven and separate from the Git workflow lifecycle; a finished agent turn never completes an issue on its own.">
        <SettingsCard><PolicyFields value={mapping.statusPolicy || {}} onChange={(statusPolicy) => set({ statusPolicy })} disabled={disabled} inherit /></SettingsCard>
      </SettingsSection>
      <BotScope botId={botId}><ContextSettings {...props} projectId={projectId} mapping={mapping} onChange={set} providers={catalog.data || []} disabled={disabled} onValidationChange={onFieldValidation} /></BotScope>
      <SettingsCard>
        <SettingsAction label="Project settings" hint="Updates the settings draft." actionLabel="Apply" disabled={disabled || !!error || !!fieldError} onPress={() => { if (!error && !fieldError) onApply(mapping); }} />
        {initial && <SettingsAction label="Project configuration" hint="Repository files, sessions, and worktrees are kept. Saved overrides are deleted and settings return to defaults, which re-enable automatic execution." actionLabel="Remove" disabled={disabled} onPress={onRemove} />}
      </SettingsCard>
      <Feedback theme={props.theme} error={error || fieldError} />
    </Modal.Content>
  </Modal>;
}

function BulkDefaults({ rows, disabled, onApply, onClose, ...props }: PluginSurfaceProps & {
  rows: ProjectRow[];
  disabled: boolean;
  onApply(projectIds: string[], selection: Selection): void;
  onClose(): void;
}) {
  const [step, setStep] = useState<"projects" | "defaults">("projects");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>({ provider: "", model: "", modeId: "" });
  const discover = useRpc(providersRpc);
  const loadProviders = useCallback(() => discover({}), [discover]);
  const catalog = useResource(loadProviders);
  const provider = catalog.data?.find((item) => item.id === selection.provider);
  const validSelection = provider?.available && provider.models.some((model) => model.id === selection.model) && provider.modes.some((mode) => mode.id === selection.modeId);
  return <Modal title="Bulk project defaults" icon={<Icon name="Folders" size={18} color={props.theme.colors.foreground} />} open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Content>
      {step === "projects" ? <SettingsSection title="Choose projects" info="Select each project to update. No projects are selected automatically. Existing mappings keep their repository, automatic execution, worktree, workspace, base branch, and status policies. New mappings are created with defaults, including automatic execution on.">
        <SettingsCard>{rows.map(({ id, title }) => <SettingsSwitch key={id} label={title} hint={`Project ID ${id}`} value={projectIds.includes(id)} disabled={disabled} onValueChange={(selected) => setProjectIds((current) => selected ? [...current, id] : current.filter((projectId) => projectId !== id))} />)}</SettingsCard>
        <SettingsCard><SettingsAction label={`${projectIds.length} projects selected`} actionLabel="Choose defaults" disabled={disabled || !projectIds.length} onPress={() => setStep("defaults")} /></SettingsCard>
      </SettingsSection> : <>
        <SettingsSection title="Choose defaults" info="Choose an explicit provider, model, and mode. Changing the provider clears the model and mode. Availability can differ by repository; save and run readiness after applying." trailing={<RefreshButton theme={props.theme} label="Refresh bulk providers" disabled={disabled || catalog.loading} onPress={catalog.refresh} />}>
          <SettingsCard>
            <SettingsSelect label="Provider" value={selection.provider} options={[{ value: "", label: "Choose a provider" }, ...(catalog.data || []).filter((item) => item.available).map((item) => ({ value: item.id, label: item.id }))]} disabled={disabled || catalog.loading} onValueChange={(provider) => setSelection({ provider, model: "", modeId: "" })} />
            <SettingsSelect label="Model" value={selection.model} options={[{ value: "", label: "Choose a model" }, ...(provider?.models || []).map((model) => ({ value: model.id, label: model.name }))]} disabled={disabled || catalog.loading || !provider?.available} onValueChange={(model) => setSelection((current) => ({ ...current, model }))} />
            <SettingsSelect label="Mode" value={selection.modeId} options={[{ value: "", label: "Choose a mode" }, ...(provider?.modes || []).map((mode) => ({ value: mode.id, label: mode.name }))]} disabled={disabled || catalog.loading || !provider?.available} onValueChange={(modeId) => setSelection((current) => ({ ...current, modeId }))} />
          </SettingsCard>
          <ProviderErrors providers={(catalog.data || []).filter((item) => item.id === selection.provider)} />
          <Feedback theme={props.theme} error={catalog.error} message={catalog.loading ? "Loading providers…" : !catalog.error && !catalog.data?.some((item) => item.available) ? "No available providers were discovered." : provider?.available && (!provider.models.length || !provider.modes.length) ? "This provider has no discovered model or mode to select. Refresh or choose another provider." : undefined} />
        </SettingsSection>
        <SettingsSection title="Apply to selected projects" info={`${rows.filter(({ id }) => projectIds.includes(id)).map(({ title }) => title).join(", ")}. Only provider, model, and mode change. New mappings have a blank repository override and automatic execution on. Global automatic delegation is never changed. This updates the settings draft only.`}>
          <SettingsCard>
            <SettingsAction label={`${projectIds.length} selected projects`} actionLabel="Change selection" disabled={disabled} onPress={() => setStep("projects")} />
            <SettingsAction label="Project defaults" hint="Save changes and run readiness afterward." actionLabel="Apply to draft" disabled={disabled || catalog.loading || !!catalog.error || !projectIds.length || !validSelection} onPress={() => onApply(projectIds, selection)} />
          </SettingsCard>
        </SettingsSection>
      </>}
    </Modal.Content>
  </Modal>;
}

export function ProjectRepositories({ config, projects, loading, error, connected, refresh, onChange, disabled, readiness, initialProjectId, ...props }: PluginSurfaceProps & {
  config: Config;
  projects: Project[];
  loading: boolean;
  error?: string;
  connected: boolean;
  refresh(): void;
  onChange(projects: Config["projects"]): void;
  disabled: boolean;
  readiness?: Readiness["projects"];
  initialProjectId?: string;
}) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const focusedProject = useRef<string | undefined>(undefined);
  const savedReadiness = useMemo(() => new Map(readiness?.map((project) => [project.projectId, project])), [readiness]);
  const rows = useMemo(() => {
    const titles = new Map(projects.map((project) => [String(project.id), `${project.name} (${project.key})`]));
    for (const id of Object.keys(config.projects)) if (!titles.has(id)) titles.set(id, `Saved project ${id}`);
    for (const project of readiness || []) if (!titles.has(project.projectId)) titles.set(project.projectId, `${project.name} (${project.key})`);
    return Array.from(titles, ([id, title]) => ({ id, title }));
  }, [projects, config.projects, readiness]);
  useEffect(() => {
    if (!initialProjectId) { focusedProject.current = undefined; return; }
    if (focusedProject.current === initialProjectId) return;
    focusedProject.current = initialProjectId;
    setEditing({ id: initialProjectId, title: rows.find((row) => row.id === initialProjectId)?.title || `Project ${initialProjectId}` });
  }, [initialProjectId, rows]);
  return <>
    <SettingsSection title="Project repositories" info="Global automatic delegation claims tasks across all of the agent's projects without a project filter. Projects without saved overrides are enabled by default, and an explicit automatic-off does not exclude a project from claims. Readiness is based on the last saved configuration, not this draft. Save changes and run readiness again after applying edits." trailing={<RefreshButton theme={props.theme} label="Refresh projects" disabled={disabled || loading || !connected} onPress={refresh} />}>
      {rows.length > 0 && <SettingsCard>{rows.map(({ id, title }) => {
        const match = projects.find((project) => String(project.id) === id)?.repositoryMatch;
        const repository = config.projects[id]?.repository || (match?.status === "matched" ? `Matched · ${match.candidate.repository}` : match?.status === "ambiguous" ? "Multiple checkouts match. Choose explicitly." : match?.status === "unavailable" ? "Repository discovery unavailable" : "No matching checkout");
        const draft = !config.projects[id] ? "No saved overrides. Automatic execution enabled by default." : config.projects[id].automatic ? "Draft automatic execution on." : "Draft automatic execution off (explicit).";
        const hint = `${repository}\n${draft} ${savedReadinessHint(savedReadiness.get(id))}`;
        return <SettingsAction key={id} label={title} hint={hint} actionLabel="Configure" disabled={disabled} onPress={() => setEditing({ id, title })} />;
      })}</SettingsCard>}
      {rows.length > 0 && <SettingsCard><SettingsAction label="Project agent defaults" hint="Choose projects explicitly, then set their provider, model, and mode in the draft." actionLabel="Bulk configure" disabled={disabled || loading} onPress={() => setBulkOpen(true)} /></SettingsCard>}
      <Feedback theme={props.theme} error={error} message={!connected ? "Save the API connection and execution key to load projects." : loading ? "Loading projects…" : !rows.length && !error ? "No projects available. Check the external agent's project access." : undefined} />
    </SettingsSection>
    {editing && <ProjectEditor key={editing.id} {...props} projectId={Number(editing.id)} title={editing.title} initial={config.projects[editing.id]} match={projects.find((project) => String(project.id) === editing.id)?.repositoryMatch} config={config} disabled={disabled} onClose={() => setEditing(null)} onApply={(mapping) => { onChange({ ...config.projects, [editing.id]: mapping }); setEditing(null); }} onRemove={() => { const next = { ...config.projects }; delete next[editing.id]; onChange(next); setEditing(null); }} />}
    {bulkOpen && <BulkDefaults {...props} rows={rows} disabled={disabled} onClose={() => setBulkOpen(false)} onApply={(projectIds, selection) => {
      const next = { ...config.projects };
      for (const id of projectIds) next[id] = next[id] ? { ...next[id], ...selection } : projectMappingSchema.parse(selection);
      onChange(next);
      setBulkOpen(false);
    }} />}
  </>;
}
