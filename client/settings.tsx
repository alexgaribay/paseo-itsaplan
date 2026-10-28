import { useCallback, useEffect, useState } from "react";
import { openExternalUrl, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { useBotRpc as useRpc, BotScope } from "./bot-context";
import { Loading, SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { configSchema, preferences, type Config } from "../shared/config";
import type { Readiness } from "../shared/experience";
import { projectsRpc, providersRpc } from "../shared/rpc";
import { configurationError, Feedback, ProviderErrors, RefreshButton, SelectionFields, useAction, useResource } from "./common";
import { advancedPanels, AdvancedEditor, type AdvancedPanel } from "./advanced";
import { CredentialField } from "./credentials";
import { ReadinessPanel, type ReadinessAction } from "./experience";
import { ProjectRepositories } from "./projects";
import { BackLink, NavigationRow } from "./navigation";
import { DelegationTestSetup } from "./smoke";
import { BotsEditor, BotSelector } from "./bots";

export function SettingsScreen(props: PluginSurfaceProps & { openExecutions(botId: string): void }) {
  const settings = useSettings(preferences);
  const action = useAction();
  const [selectedBotId, setSelectedBotId] = useState("default");
  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") return <SettingsSection title="Configuration" info="Existing settings are preserved when loading fails. Reset replaces an invalid document; credentials are kept.">
    <SettingsCard>
      <SettingsAction label="Saved settings" actionLabel="Reload" disabled={action.pending} onPress={() => { void action.run(async () => { await settings.reload(); }); }} />
      {settings.status === "invalid" && <SettingsAction label="Invalid configuration" actionLabel="Reset" disabled={settings.saving || action.pending} onPress={() => { void action.run(async () => { await settings.reset(); }); }} />}
    </SettingsCard>
    <Feedback theme={props.theme} error={settings.error || settings.saveError || action.error} />
  </SettingsSection>;
  const botId = settings.values.bots[selectedBotId] ? selectedBotId : "default";
  return <BotScope botId={botId}><SettingsEditor key={botId} {...props} settings={settings} botId={botId} onSelectBot={setSelectedBotId} /></BotScope>;
}

type ReadySettings = Extract<SettingsState<typeof configSchema>, { status: "ready" }>;
type Detail = "connection" | "execution" | "projects" | "requests" | "advanced" | "checks" | "bots";
const panels = ["runtime", "polling", "chat", "overrides", "policies", "mcp"] as const;

function SettingsEditor({ settings, openExecutions, botId, onSelectBot, ...props }: PluginSurfaceProps & { settings: ReadySettings; openExecutions(botId: string): void; botId: string; onSelectBot(botId: string): void }) {
  const [draft, setDraft] = useState<{ values: Config; revision: string }>({ values: settings.values, revision: settings.revision });
  const [formVersion, setFormVersion] = useState(0);
  const [savedRevision, setSavedRevision] = useState<string | null>(null);
  const [panel, setPanel] = useState<AdvancedPanel | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [projectId, setProjectId] = useState<string>();
  const [readiness, setReadiness] = useState<{ revision: string; value: Readiness }>();
  const [testOpen, setTestOpen] = useState(false);
  const action = useAction();
  const toast = useToast();
  const providers = useRpc(providersRpc);
  const projects = useRpc(projectsRpc);
  const needsProviders = detail === "execution" || panel !== null;
  const needsProjects = detail === "projects" || panel !== null;
  const loadProviders = useCallback(() => needsProviders ? providers({}) : Promise.resolve([]), [providers, needsProviders]);
  const loadProjects = useCallback(() => needsProjects && settings.values.serverUrl ? projects({}) : Promise.resolve([]), [projects, needsProjects, settings.values.serverUrl]);
  const catalog = useResource(loadProviders);
  const availableProjects = useResource(loadProjects);
  const values = draft.values;
  const disabled = settings.saving || savedRevision !== null;
  const dirty = JSON.stringify(values) !== JSON.stringify(settings.values);
  const conflict = settings.revision !== draft.revision && savedRevision === null;
  const set = (patch: Partial<Config>) => setDraft((current) => ({ ...current, values: { ...current.values, ...patch } }));
  const replaceDraft = (next: Config, revision: string) => { setDraft({ values: next, revision }); setFormVersion((value) => value + 1); };
  useEffect(() => {
    if (savedRevision !== null && settings.revision !== savedRevision) {
      setDraft({ values: settings.values, revision: settings.revision });
      setFormVersion((value) => value + 1);
      setSavedRevision(null);
      setReadiness(undefined);
    }
  }, [savedRevision, settings.revision, settings.values]);
  const navigate = (target: ReadinessAction) => {
    if (target.kind === "agent" && (settings.values.webUrl || settings.values.serverUrl)) {
      const base = (settings.values.webUrl || settings.values.serverUrl).replace(/\/+$/, "");
      void action.run(() => openExternalUrl(base + (target.externalPath || "")));
    } else if (target.kind === "host") { setDetail("connection"); setPanel("host"); }
    else if (target.kind === "execution") setDetail("execution");
    else if (target.kind === "project" || target.kind === "projects") { setProjectId(target.projectId); setDetail("projects"); }
    else setDetail("connection");
  };
  const validationError = configurationError(values);
  const summaries: Record<(typeof panels)[number], string> = {
    runtime: values.continuation?.enabled ? "Reviewed continuation allowed" : values.activityPrivacy && values.activityPrivacy !== "off" ? "Tool activity sharing enabled" : "Fresh sessions · Tool activity off",
    polling: `Every ${values.pollIntervalMs / 1000} seconds`,
    chat: `${Object.keys(values.chatProjects).length} threads`,
    overrides: `${Object.keys(values.issueOverrides).length} issues`,
    policies: `${Object.keys(values.statusPolicy).length} destinations`,
    mcp: values.mcp.enabled ? "Enabled" : "Disabled",
  };
  if (panel) return <AdvancedEditor key={`${panel}-${formVersion}`} {...props} panel={panel} config={values} projects={availableProjects.data || []} providers={catalog.data || []} disabled={disabled} onClose={() => setPanel(null)} onApply={(next) => { setDraft((current) => ({ ...current, values: next })); setPanel(null); }} />;
  if (testOpen) return <DelegationTestSetup {...props} config={settings.values} draftDirty={dirty || conflict || disabled} onClose={() => setTestOpen(false)} onChange={() => setReadiness(undefined)} />;
  return <>
    <BotSelector bots={settings.values.bots} botId={botId} disabled={dirty || conflict || disabled} onChange={onSelectBot} />
    {!detail && <SettingsSection title="Settings">
      <SettingsCard>
        <NavigationRow theme={props.theme} label="Connection" hint={values.serverUrl || "Not configured"} onPress={() => setDetail("connection")} />
        <NavigationRow theme={props.theme} label="Bots and profiles" hint={`${Object.keys(values.bots).length} registered · ${values.bots[botId]?.name || botId}`} onPress={() => setDetail("bots")} />
        <NavigationRow theme={props.theme} label="Projects" hint={`${Object.keys(values.projects).length} with saved overrides · others default to enabled`} onPress={() => { setProjectId(undefined); setDetail("projects"); }} />
        <NavigationRow theme={props.theme} label="Execution" hint={values.automatic ? "Automatic delegation enabled" : "Automatic delegation disabled"} onPress={() => setDetail("execution")} />
        <NavigationRow theme={props.theme} label="Advanced" onPress={() => setDetail("advanced")} />
      </SettingsCard>
    </SettingsSection>}
    {!detail && <SettingsSection title="Review">
      <SettingsCard>
        <NavigationRow theme={props.theme} label="Setup checks" hint="Readiness, queue preview and test delegation" onPress={() => setDetail("checks")} />
        <NavigationRow theme={props.theme} label="Executions" hint={dirty || conflict ? "Save or discard changes before leaving settings" : "Selected bot's active work, history and runtime controls"} disabled={dirty || conflict || disabled} onPress={() => openExecutions(botId)} />
      </SettingsCard>
    </SettingsSection>}
    {detail && <BackLink theme={props.theme} label={detail === "requests" ? "Advanced" : "Settings"} onPress={() => setDetail(detail === "requests" ? "advanced" : null)} />}
    {detail === "bots" && <BotsEditor key={formVersion} {...props} bots={values.bots} disabled={disabled} onChange={(bots) => set({ bots })} />}
    {detail === "checks" && <ReadinessPanel key={settings.revision} {...props} onNavigate={navigate} onResult={(value) => setReadiness({ revision: settings.revision, value })} draftDirty={dirty || conflict || disabled} onTestDelegation={() => setTestOpen(true)} />}
    {detail === "advanced" && <SettingsSection title="Advanced">
      <SettingsCard>
        {panels.map((id) => <NavigationRow key={id} theme={props.theme} label={advancedPanels[id]} hint={summaries[id]} disabled={disabled} onPress={() => setPanel(id)} />)}
        <NavigationRow theme={props.theme} label="Human rerun requests" hint="Optional separate human credential" onPress={() => setDetail("requests")} />
      </SettingsCard>
    </SettingsSection>}
    {detail === "connection" && <SettingsSection title="Connection" info={`API and web URLs are shared by every bot. The execution key belongs only to ${settings.values.bots[botId]?.name || botId}. Credentials are stored immediately, separately from this draft.`}>
      <SettingsCard key={`connection-${formVersion}`}>
        <SettingsInput label="API server URL" placeholder="https://api.plan.example.com" initialValue={values.serverUrl} disabled={disabled} onChangeText={(serverUrl) => set({ serverUrl })} />
        <SettingsInput label="Web app URL" placeholder="Same as API server" initialValue={values.webUrl} disabled={disabled} onChangeText={(webUrl) => set({ webUrl })} />
        <CredentialField {...props} kind="apiKey" disabled={disabled} />
        <NavigationRow theme={props.theme} label="Paseo host connection" hint={values.paseoConnectionMode === "auto" ? "Automatic · This host" : values.paseoUrl} disabled={disabled} onPress={() => setPanel("host")} />
      </SettingsCard>
    </SettingsSection>}
    {detail === "execution" && <>
      <SettingsSection title="Delegation" info="Shared settings affect future work for all enabled bots. Existing work keeps its captured settings. Connection and runner credential changes drain active work before replacement.">
        <SettingsCard>
          <SettingsSwitch label="Automatic delegation" hint="Global claims are unfiltered. Projects without overrides are enabled by default, and an explicit automatic-off does not exclude a project from claims. Runtime pause is separate from this saved switch." value={values.automatic} disabled={disabled} onValueChange={(automatic) => set({ automatic })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Shared execution defaults" info="Used by bots without a named Paseo profile; issue and project overrides take precedence. A bot's named profile supplies the full launch bundle instead. Blank model or mode uses the provider default and remains unresolved until session creation. No-tools is instruction-only, not enforced isolation." trailing={<RefreshButton theme={props.theme} label="Refresh providers" disabled={disabled || catalog.loading} onPress={catalog.refresh} />}>
        <SettingsCard key={`execution-${formVersion}`}>
          <SelectionFields value={{ provider: values.defaultProvider, model: values.defaultModel, modeId: values.defaultModeId }} onChange={(selection) => set({ defaultProvider: selection.provider, defaultModel: selection.model, defaultModeId: selection.modeId })} providers={catalog.data || []} disabled={disabled} global />
          <SettingsInput label="Concurrent executions per bot" initialValue={String(values.maxConcurrent)} disabled={disabled} onChangeText={(text) => set({ maxConcurrent: text.trim() ? Number(text) : Number.NaN })} />
          <SettingsInput label="Execution timeout (minutes)" initialValue={String(values.executionTimeoutMs / 60000)} disabled={disabled} onChangeText={(text) => set({ executionTimeoutMs: text.trim() ? Number(text) * 60000 : Number.NaN })} />
        </SettingsCard>
        <ProviderErrors providers={(catalog.data || []).filter((provider) => provider.id === values.defaultProvider)} />
        <Feedback theme={props.theme} error={catalog.error} />
      </SettingsSection>
    </>}
    {detail === "projects" && <ProjectRepositories key={`projects-${formVersion}`} {...props} config={values} projects={availableProjects.data || []} readiness={readiness?.revision === settings.revision ? readiness.value.projects : undefined} initialProjectId={projectId} loading={availableProjects.loading} error={availableProjects.error} connected={!!settings.values.serverUrl} refresh={availableProjects.refresh} disabled={disabled} onChange={(projects) => set({ projects })} />}
    {detail === "requests" && <SettingsSection title="Optional human credential" info="This key is used only for explicitly confirmed rerun and smoke comments after verifying a human identity. It is never injected into agents or MCP. The runner requires a different, external-agent key. Browser-copy mode needs no human key."><SettingsCard><CredentialField {...props} kind="requestApiKey" disabled={disabled} /></SettingsCard></SettingsSection>}
    {(dirty || conflict || disabled || settings.saveError || action.error || validationError) && <SettingsSection title="Changes" info="Changes stay in this draft until saved. Saving checks the original revision and does not resume a runtime pause.">
      <SettingsCard>
        <SettingsAction label={conflict ? "Draft conflicts with saved settings" : "Unsaved changes"} actionLabel={disabled ? "Saving…" : "Save changes"} disabled={disabled || !dirty || !!validationError} onPress={() => { void action.run(async () => { if (await settings.save(values, draft.revision)) { setSavedRevision(draft.revision); toast.show("Settings saved", { variant: "success" }); } }); }} />
        {(dirty || conflict) && <SettingsAction label="Settings draft" actionLabel="Discard" disabled={disabled} onPress={() => replaceDraft(settings.values, settings.revision)} />}
      </SettingsCard>
      <Feedback theme={props.theme} error={settings.saveError || action.error || validationError || (conflict ? "Saved settings changed elsewhere. Discard to load the latest version; this draft keeps its original revision." : undefined)} />
    </SettingsSection>}
  </>;
}
