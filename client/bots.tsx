import { useCallback } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { Config } from "../shared/config";
import { profilesRpc } from "../shared/rpc";
import { useBotRpc } from "./bot-context";
import { Feedback, RefreshButton, useResource } from "./common";

export function BotSelector({ bots, botId, disabled, onChange }: { bots: Config["bots"]; botId: string; disabled?: boolean; onChange(botId: string): void }) {
  return <SettingsSection title="Bot">
    <SettingsCard><SettingsSelect label="Selected bot" value={botId} options={Object.entries(bots).map(([id, bot]) => ({ value: id, label: `${bot.name}${bot.enabled ? "" : " (delegation disabled)"}` }))} disabled={disabled} onValueChange={onChange} /></SettingsCard>
  </SettingsSection>;
}

export function BotsEditor({ bots, onChange, disabled, ...props }: PluginSurfaceProps & { bots: Config["bots"]; onChange(bots: Config["bots"]): void; disabled: boolean }) {
  const discover = useBotRpc(profilesRpc);
  const load = useCallback(() => discover({}), [discover]);
  const profiles = useResource(load);
  const update = (id: string, patch: Partial<Config["bots"][string]>) => onChange({ ...bots, [id]: { ...bots[id]!, ...patch } });
  return <SettingsSection title="Bots and Paseo profiles" info="All bots share the API connection, projects, policies and optional credentials. Each bot has its own execution key and a local named Paseo profile. A selected profile supplies the whole launch bundle, overriding shared provider/model/mode settings. Save a new bot, select it, then add its execution key in Connection. Disabling delegation does not stop active work or erase history." trailing={<RefreshButton theme={props.theme} label="Refresh Paseo profiles" disabled={profiles.loading || disabled} onPress={profiles.refresh} />}>
    {!profiles.loading && !profiles.error && profiles.data?.length === 0 && <SettingsCard><SettingsRow label="No named Paseo profiles" hint="Create an agent profile in Paseo's host settings, then refresh this list." /></SettingsCard>}
    {Object.entries(bots).map(([id, bot]) => {
      const profile = profiles.data?.find((item) => item.id === bot.profileId);
      const options = [{ value: "", label: "Use shared execution settings" }, ...(profiles.data || []).map((item) => ({ value: item.id, label: item.name }))];
      if (bot.profileId && !profile) options.push({ value: bot.profileId, label: `${bot.profileId} (not discovered)` });
      return <SettingsCard key={id}>
        <SettingsInput label="Bot name" initialValue={bot.name} disabled={disabled} onChangeText={(name) => update(id, { name })} />
        <SettingsRow label="Local bot ID" hint={id} />
        <SettingsSelect label="Paseo agent profile" value={bot.profileId} options={options} disabled={disabled} onValueChange={(profileId) => update(id, { profileId })} />
        {profile && <SettingsRow label="Profile launch settings" hint={`${profile.provider} · ${profile.model || "provider default"} · ${profile.modeId || "default mode"}${profile.thinkingOptionId ? ` · thinking ${profile.thinkingOptionId}` : ""}`} />}
        {bot.profileId && !profile && !profiles.loading && <SettingsRow label="Profile unavailable" error={profiles.error ? "Profile discovery failed. Refresh before changing this binding." : "This saved profile is missing on this Paseo host. New work fails rather than falling back to shared defaults."} />}
        <SettingsSwitch label="Enable bot delegation" hint="Also requires shared automatic delegation. Projects are enabled by default unless automatic execution is explicitly turned off." value={bot.enabled} disabled={disabled} onValueChange={(enabled) => update(id, { enabled })} />
      </SettingsCard>;
    })}
    <SettingsCard><SettingsAction label="Register another bot" actionLabel="Add bot" disabled={disabled} onPress={() => {
      const id = `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      onChange({ ...bots, [id]: { name: "New bot", profileId: "", enabled: false } });
    }} /></SettingsCard>
    <Feedback theme={props.theme} error={profiles.error} />
  </SettingsSection>;
}
