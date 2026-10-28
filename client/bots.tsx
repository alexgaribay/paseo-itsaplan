import { useCallback } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { Config } from "../shared/config";
import { profilesRpc } from "../shared/rpc";
import { BotScope, useBotRpc } from "./bot-context";
import { Feedback, RefreshButton, useResource } from "./common";
import { CredentialField } from "./credentials";

export function BotSelector({ bots, botId, disabled, onChange, onManage }: { bots: Config["bots"]; botId: string; disabled?: boolean; onChange(botId: string): void; onManage(): void }) {
  return <SettingsSection title="It's a Plan agent">
    <SettingsCard>
      <SettingsSelect label="Selected agent" value={botId} options={Object.entries(bots).map(([id, bot]) => ({ value: id, label: `${bot.name}${bot.enabled ? "" : " (delegation disabled)"}` }))} disabled={disabled} onValueChange={onChange} />
      <SettingsAction label="External-agent connections" actionLabel="Manage agents" disabled={disabled} onPress={onManage} />
    </SettingsCard>
  </SettingsSection>;
}

export function BotsEditor({ bots, savedBots, onChange, disabled, ...props }: PluginSurfaceProps & { bots: Config["bots"]; savedBots: Config["bots"]; onChange(bots: Config["bots"]): void; disabled: boolean }) {
  const discover = useBotRpc(profilesRpc);
  const load = useCallback(() => discover({}), [discover]);
  const profiles = useResource(load);
  const update = (id: string, patch: Partial<Config["bots"][string]>) => onChange({ ...bots, [id]: { ...bots[id]!, ...patch } });
  return <SettingsSection title="External agents" info="Connect multiple It's a Plan external agents to this host. Each agent has its own execution API key; a Paseo profile is optional." trailing={<RefreshButton theme={props.theme} label="Refresh Paseo profiles" disabled={profiles.loading || disabled} onPress={profiles.refresh} />}>
    <SettingsCard><SettingsAction label="Connect another It's a Plan agent" actionLabel="Add agent" disabled={disabled} onPress={() => {
      const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      onChange({ [id]: { name: "New agent", profileId: "", enabled: false }, ...bots });
    }} /></SettingsCard>
    {Object.entries(bots).map(([id, bot]) => {
      const profile = profiles.data?.find((item) => item.id === bot.profileId);
      const options = [{ value: "", label: "Use shared execution settings" }, ...(profiles.data || []).map((item) => ({ value: item.id, label: item.name }))];
      if (bot.profileId && !profile) options.push({ value: bot.profileId, label: `${bot.profileId} (not discovered)` });
      return <SettingsCard key={id}>
        <SettingsInput label="Agent name" initialValue={bot.name} disabled={disabled} onChangeText={(name) => update(id, { name })} />
        {Object.hasOwn(savedBots, id) ? <BotScope botId={id}><CredentialField {...props} kind="apiKey" ownerName={bot.name} disabled={disabled} /></BotScope> : <SettingsRow label="External-agent execution API key" hint="Save changes to register this agent, then add its key here." />}
        <SettingsSelect label="Paseo profile (optional)" value={bot.profileId} options={options} disabled={disabled} onValueChange={(profileId) => update(id, { profileId })} />
        {bot.profileId && !profile && !profiles.loading && <SettingsRow label="Profile unavailable" error={profiles.error ? "Profile discovery failed. Refresh before changing this binding." : "This saved profile is missing on this Paseo host. New work fails rather than falling back to shared defaults."} />}
        <SettingsSwitch label="Accept delegated work" hint="Also requires shared automatic delegation. Disabling this does not stop active work or erase history." value={bot.enabled} disabled={disabled} onValueChange={(enabled) => update(id, { enabled })} />
      </SettingsCard>;
    })}
    <Feedback theme={props.theme} error={profiles.error} />
  </SettingsSection>;
}
