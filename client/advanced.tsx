import { useCallback, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { Config } from "../shared/config";
import type { Project, Provider } from "../shared/models";
import { configurationError, Feedback, RefreshButton, useResource } from "./common";
import { CredentialField } from "./credentials";
import { ChatMappings, IssueOverrides, PolicyFields } from "./mappings";
import { hostRpc } from "../shared/rpc";

function HostFields({ config, onChange, disabled, ...props }: PluginSurfaceProps & { config: Config; onChange(patch: Partial<Config>): void; disabled: boolean }) {
  const describe = useRpc(hostRpc);
  const load = useCallback(() => describe({}), [describe]);
  const host = useResource(load);
  return <SettingsSection title="Daemon connection" info="Automatic mode uses this running daemon's endpoint, identity, and private local credential. Use a manual override only for another transport to the same daemon. Save this draft, then run the unified readiness check." trailing={<RefreshButton theme={props.theme} label="Refresh host discovery" disabled={disabled || host.loading} onPress={host.refresh} />}>
    <SettingsCard>
      <SettingsSelect label="Connection" value={config.paseoConnectionMode} options={[{ value: "auto", label: "Automatic (this host)" }, { value: "manual", label: "Manual override" }]} disabled={disabled} onValueChange={(mode) => onChange({ paseoConnectionMode: mode as Config["paseoConnectionMode"] })} />
      {config.paseoConnectionMode === "auto" ? <SettingsRow label={host.data?.status === "detected" ? host.data.endpoint : host.loading ? "Discovering host…" : "Host unavailable"} hint={host.data?.status === "detected" ? host.data.serverId : undefined} error={host.data?.status === "unavailable" ? host.data.message : host.error} /> : <>
        <SettingsInput label="WebSocket URL" initialValue={config.paseoUrl} disabled={disabled} onChangeText={(paseoUrl) => onChange({ paseoUrl })} />
        <CredentialField {...props} kind="paseoPassword" disabled={disabled} />
      </>}
    </SettingsCard>
    <Feedback theme={props.theme} error={host.error} />
  </SettingsSection>;
}

export const advancedPanels = {
  host: "Paseo host connection",
  polling: "Polling and leases",
  chat: "Chat routing",
  overrides: "Issue overrides",
  policies: "Issue status transitions",
  mcp: "Agent MCP",
  runtime: "Execution behavior",
} as const;
export type AdvancedPanel = keyof typeof advancedPanels;

export function AdvancedEditor({ panel, config, projects, providers, onApply, onClose, disabled, ...props }: PluginSurfaceProps & {
  panel: AdvancedPanel;
  config: Config;
  projects: Project[];
  providers: Provider[];
  onApply(config: Config): void;
  onClose(): void;
  disabled: boolean;
}) {
  const [values, setValues] = useState(config);
  const set = (patch: Partial<Config>) => setValues((current) => ({ ...current, ...patch }));
  const [toolName, setToolName] = useState("");
  const [toolVersion, setToolVersion] = useState(0);
  const error = configurationError(values);
  const mcpProviders = [...providers.map((provider) => provider.id), ...values.mcp.providers.filter((id) => !providers.some((provider) => provider.id === id))];
  return <Modal title={advancedPanels[panel]} open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Content>
      {panel === "host" && <HostFields {...props} config={values} onChange={set} disabled={disabled} />}
      {panel === "polling" && <SettingsSection title="Timing" info="These limits apply to all projects. Heartbeats run every 60 seconds. The local lease deadline stops execution when renewal cannot be confirmed; it does not change the server's lease and must remain shorter than it.">
        <SettingsCard>
          <SettingsInput label="Poll interval (seconds)" initialValue={String(values.pollIntervalMs / 1000)} disabled={disabled} onChangeText={(text) => set({ pollIntervalMs: text.trim() ? Number(text) * 1000 : Number.NaN })} />
          <SettingsInput label="Lease safety deadline (seconds)" initialValue={String(values.leaseSafetyMs / 1000)} disabled={disabled} onChangeText={(text) => set({ leaseSafetyMs: text.trim() ? Number(text) * 1000 : Number.NaN })} />
        </SettingsCard>
      </SettingsSection>}
      {panel === "chat" && <ChatMappings config={values} projects={projects} disabled={disabled} onChange={(chatProjects) => set({ chatProjects })} />}
      {panel === "overrides" && <IssueOverrides {...props} config={values} disabled={disabled} onChange={(issueOverrides) => set({ issueOverrides })} />}
      {panel === "policies" && <SettingsSection title="Destination columns" info="Enter a column ID for each milestone, or leave blank to disable its transition. Submit evidence from a linked session to change status. An agent turn finishing never marks an issue complete.">
        <SettingsCard><PolicyFields value={values.statusPolicy} onChange={(statusPolicy) => set({ statusPolicy })} disabled={disabled} /></SettingsCard>
      </SettingsSection>}
      {panel === "runtime" && <>
        <SettingsSection title="Activity sharing" info="Optional tool activity in It's a Plan's existing execution trace and chat. Off shares no tool events. Detailed traces may contain source code or sensitive tool data; known plugin credentials are always redacted.">
          <SettingsCard><SettingsSelect label="Tool activity" value={values.activityPrivacy || "off"} options={[{ value: "off", label: "Off" }, { value: "metadata", label: "Tool names only" }, { value: "full", label: "Arguments and results" }]} disabled={disabled} onValueChange={(privacy) => set({ activityPrivacy: privacy as Config["activityPrivacy"] })} /></SettingsCard>
        </SettingsSection>
        <SettingsSection title="Session continuation" info="Fresh sessions remain the default. Enabling this only allows a separate, explicitly reviewed continuation request. Matching an issue never resumes a session. Smoke, exact-output, no-tools, stale, failed and uncertain sources are blocked. Repository, provider, model, permission mode and task scope are rechecked before reuse.">
          <SettingsCard><SettingsSwitch label="Allow reviewed continuation" value={values.continuation?.enabled || false} disabled={disabled} onValueChange={(enabled) => set({ continuation: { enabled } })} /></SettingsCard>
        </SettingsSection>
      </>}
      {panel === "mcp" && <>
        <SettingsSection title="Connection" info="Optional agent-side access to It's a Plan. Task claiming, heartbeats, routing, and result reporting work without MCP. Unknown or unsupported providers continue without it.">
          <SettingsCard>
            <SettingsSwitch label="Enable agent MCP" value={values.mcp.enabled} disabled={disabled} onValueChange={(enabled) => set({ mcp: { ...values.mcp, enabled } })} />
            {values.mcp.enabled && <SettingsInput label="MCP HTTP URL" initialValue={values.mcp.url} placeholder="https://plan.example.com/mcp" disabled={disabled} onChangeText={(url) => set({ mcp: { ...values.mcp, url } })} />}
            <CredentialField {...props} kind="mcpToken" disabled={disabled} />
          </SettingsCard>
        </SettingsSection>
        {values.mcp.enabled && <>
          <SettingsSection title="Providers" info="Opt in each provider. Injection requires an existing Paseo session reporting MCP support. Restrict capabilities through the separate MCP account's upstream role.">
            {mcpProviders.length > 0 ? <SettingsCard>{mcpProviders.map((provider) => <SettingsSwitch key={provider} label={provider} value={values.mcp.providers.includes(provider)} disabled={disabled} onValueChange={(enabled) => set({ mcp: { ...values.mcp, providers: enabled ? [...values.mcp.providers, provider] : values.mcp.providers.filter((id) => id !== provider) } })} />)}</SettingsCard> : <Feedback theme={props.theme} message="No providers discovered." />}
          </SettingsSection>
          <SettingsSection title="Tool preapprovals" info="Exact tool names only. Preapprovals skip supported approval prompts; they do not filter the tools exposed by the MCP server. Scope capabilities through the MCP credential's role.">
            <SettingsCard>
              {values.mcp.preapprovedTools.map((tool) => <SettingsAction key={tool} label={tool} actionLabel="Remove" disabled={disabled} onPress={() => set({ mcp: { ...values.mcp, preapprovedTools: values.mcp.preapprovedTools.filter((name) => name !== tool) } })} />)}
              <SettingsInput key={toolVersion} label="Tool name" placeholder="Exact name, no wildcards" initialValue="" onChangeText={setToolName} disabled={disabled} />
              <SettingsAction label="Tool preapproval" actionLabel="Add" disabled={disabled || !toolName.trim() || /[*?]/.test(toolName) || values.mcp.preapprovedTools.includes(toolName.trim())} onPress={() => { set({ mcp: { ...values.mcp, preapprovedTools: [...values.mcp.preapprovedTools, toolName.trim()] } }); setToolName(""); setToolVersion((value) => value + 1); }} />
            </SettingsCard>
          </SettingsSection>
        </>}
      </>}
      <SettingsCard><SettingsAction label="Settings draft" actionLabel="Apply" disabled={disabled || !!error} onPress={() => onApply(values)} /></SettingsCard>
      <Feedback theme={props.theme} error={error} />
    </Modal.Content>
  </Modal>;
}
