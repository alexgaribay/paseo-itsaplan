import { useCallback, useState } from "react";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useBotRpc as useRpc } from "./bot-context";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { Config, Selection } from "../shared/config";
import type { Project } from "../shared/models";
import { detailRpc, providersRpc } from "../shared/rpc";
import { Feedback, ProviderErrors, RefreshButton, SelectionFields, useResource } from "./common";
import { milestoneOptions } from "./sessions";

export function PolicyFields({ value, onChange, disabled, inherit = false }: { value: Config["statusPolicy"]; onChange(value: Config["statusPolicy"]): void; disabled: boolean; inherit?: boolean }) {
  return milestoneOptions.map((milestone) => <SettingsInput key={milestone.value} label={milestone.label} placeholder={inherit ? "Inherit global policy" : "No transition"} initialValue={value[milestone.value]?.toString() || ""} disabled={disabled} onChangeText={(text) => {
    const next = { ...value };
    if (text.trim()) next[milestone.value] = Number(text);
    else delete next[milestone.value];
    onChange(next);
  }} />);
}

export function ChatMappings({ config, projects, onChange, disabled }: {
  config: Config;
  projects: Project[];
  onChange(mappings: Config["chatProjects"]): void;
  disabled: boolean;
}) {
  const [threadId, setThreadId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [inputVersion, setInputVersion] = useState(0);
  const options = [{ value: "", label: "Select a project" }, ...projects.map((item) => ({ value: String(item.id), label: `${item.name} (${item.key})` })), ...Object.keys(config.projects).filter((id) => !projects.some((item) => String(item.id) === id)).map((id) => ({ value: id, label: `Project ID ${id} (saved overrides)` }))];
  return <SettingsSection title="Chat routing" info="Chat messages do not include a project. Route each exact thread ID to a visible project before starting that conversation. Routing does not create project configuration; projects without overrides use defaults.">
    <SettingsCard>
      <SettingsInput key={inputVersion} label="Chat thread ID" initialValue="" onChangeText={setThreadId} disabled={disabled} />
      <SettingsSelect label="Project" value={projectId} options={options} onValueChange={setProjectId} disabled={disabled} />
      <SettingsAction label="Thread mapping" actionLabel="Add mapping" disabled={disabled || !threadId.trim() || !projectId} onPress={() => { onChange({ ...config.chatProjects, [threadId.trim()]: projectId }); setThreadId(""); setInputVersion((value) => value + 1); }} />
    </SettingsCard>
    {Object.entries(config.chatProjects).map(([thread, mappedProject]) => <SettingsCard key={thread}>
      <SettingsSelect label={`Thread ${thread}`} value={mappedProject} options={options.some((option) => option.value === mappedProject) ? options : [...options, { value: mappedProject, label: `Project ID ${mappedProject}` }]} onValueChange={(next) => onChange({ ...config.chatProjects, [thread]: next })} disabled={disabled} />
      <SettingsAction label="Thread mapping" actionLabel="Remove" disabled={disabled} onPress={() => { const next = { ...config.chatProjects }; delete next[thread]; onChange(next); }} />
    </SettingsCard>)}
  </SettingsSection>;
}

function IssueOverride({ issueId, selection, config, update, remove, disabled, ...props }: PluginSurfaceProps & {
  issueId: string;
  selection: Selection;
  config: Config;
  update(value: Selection): void;
  remove(): void;
  disabled: boolean;
}) {
  const detail = useRpc(detailRpc);
  const discover = useRpc(providersRpc);
  const validId = Number.isSafeInteger(Number(issueId)) && Number(issueId) > 0;
  const loadIssue = useCallback(() => config.serverUrl && validId ? detail({ issueId: Number(issueId) }) : Promise.resolve(null), [config.serverUrl, detail, issueId, validId]);
  const issue = useResource(loadIssue);
  const mapping = issue.data ? config.projects[String(issue.data.projectId)] : undefined;
  const loadProviders = useCallback(() => discover({ cwd: mapping?.repository || undefined }), [discover, mapping?.repository]);
  const providers = useResource(loadProviders);
  return <SettingsSection title={issue.data ? issue.data.identifier : `Issue ${issueId}`} trailing={<RefreshButton theme={props.theme} label="Refresh issue providers" onPress={providers.refresh} disabled={providers.loading || disabled} />}>
    <SettingsCard>
      {issue.data && <SettingsRow label={issue.data.title} hint={`Project ID ${issue.data.projectId}`} />}
      <SelectionFields value={selection} onChange={update} providers={providers.data || []} inheritedProvider={mapping?.provider || config.defaultProvider} disabled={disabled} />
      <SettingsAction label="Issue override" actionLabel="Remove" onPress={remove} disabled={disabled} />
    </SettingsCard>
    <ProviderErrors providers={(providers.data || []).filter((provider) => provider.id === (selection.provider || mapping?.provider || config.defaultProvider))} />
    <Feedback theme={props.theme} error={issue.error || providers.error} />
  </SettingsSection>;
}

export function IssueOverrides({ config, onChange, disabled, ...props }: PluginSurfaceProps & {
  config: Config;
  onChange(overrides: Config["issueOverrides"]): void;
  disabled: boolean;
}) {
  const [issueId, setIssueId] = useState("");
  const [inputVersion, setInputVersion] = useState(0);
  const parsedId = Number(issueId);
  const validId = /^\d+$/.test(issueId.trim()) && Number.isSafeInteger(parsedId) && parsedId > 0;
  return <>
    <SettingsSection title="Issue overrides" info="Set provider, model, and mode for a numeric issue ID. These override project and global defaults; explicit manual session selections take precedence. Blank fields inherit.">
      <SettingsCard>
        <SettingsInput key={inputVersion} label="Issue ID" initialValue="" hint="Numeric server ID, not the issue identifier." onChangeText={setIssueId} disabled={disabled} />
        <SettingsAction label="Issue override" actionLabel="Add override" disabled={disabled || !validId || !!config.issueOverrides[String(parsedId)]} onPress={() => { onChange({ ...config.issueOverrides, [String(parsedId)]: { provider: "", model: "", modeId: "" } }); setIssueId(""); setInputVersion((value) => value + 1); }} />
      </SettingsCard>
    </SettingsSection>
    {Object.entries(config.issueOverrides).map(([id, selection]) => <IssueOverride key={id} {...props} issueId={id} selection={selection} config={config} disabled={disabled} update={(value) => onChange({ ...config.issueOverrides, [id]: value })} remove={() => { const next = { ...config.issueOverrides }; delete next[id]; onChange(next); }} />)}
  </>;
}
