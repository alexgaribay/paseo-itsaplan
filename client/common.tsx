import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, SettingsCard, SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { Provider } from "../shared/models";
import { configSchema, type Config, type Selection } from "../shared/config";
import { resourceState, type ResourceState } from "./resource-state";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

export function useResource<T>(load: () => Promise<T>, intervalMs?: number) {
  const [state, setState] = useState<ResourceState<T>>({ loading: true });
  const previousLoad = useRef(load);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let timer: NodeJS.Timeout | undefined;
    const preserve = previousLoad.current === load;
    previousLoad.current = load;
    setState((current) => resourceState(current, { type: "start", preserve }));
    async function update() {
      try {
        const data = await load();
        if (active) setState((current) => resourceState(current, { type: "loaded", data }));
      } catch (error) {
        if (active) setState((current) => resourceState(current, { type: "failed", error: errorMessage(error) }));
      }
      if (active && intervalMs) timer = setTimeout(() => { void update(); }, intervalMs);
    }
    void update();
    return () => { active = false; clearTimeout(timer); };
  }, [load, intervalMs, revision]);
  return { ...state, refresh };
}

export function useAction() {
  const [state, setState] = useState<{ pending: boolean; error?: string; message?: string }>({ pending: false });
  const run = async (action: () => Promise<string | void>) => {
    setState({ pending: true });
    try {
      const message = await action();
      setState({ pending: false, message: message || undefined });
    } catch (error) {
      setState({ pending: false, error: errorMessage(error) });
    }
  };
  return { ...state, run };
}

export function Feedback({ theme, error, message }: Pick<PluginSurfaceProps, "theme"> & { error?: string | null; message?: string }) {
  if (!error && !message) return null;
  return <Text accessibilityRole={error ? "alert" : undefined} style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted, paddingVertical: 8 }}>{error || message}</Text>;
}

export function Warning({ message }: { message?: string | null }) {
  if (!message) return null;
  return <SettingsCard><SettingsRow label="Warning" hint={message} /></SettingsCard>;
}

export function RefreshButton({ theme, label, disabled, onPress }: Pick<PluginSurfaceProps, "theme"> & { label: string; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 6, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1, backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}>
    <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
  </Pressable>;
}

export function configurationError(values: Config): string | undefined {
  const validation = configSchema.safeParse(values);
  if (!validation.success) return validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
  const missingPath = Object.entries(values.projects).find(([, mapping]) => mapping.repository && !mapping.repository.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(mapping.repository));
  if (missingPath) return `Project ${missingPath[0]} needs an absolute repository path.`;
  const orphanThread = Object.entries(values.chatProjects).find(([, project]) => !values.projects[project]);
  if (orphanThread) return `Chat thread ${orphanThread[0]} needs a mapped project before saving.`;
}

function options(items: { id: string; name?: string }[], current: string, inherit: string) {
  const result = [{ value: "", label: inherit }, ...items.map((item) => ({ value: item.id, label: item.name || item.id }))];
  if (current && !items.some((item) => item.id === current)) result.push({ value: current, label: `${current} (saved, not discovered)` });
  return result;
}

export function SelectionFields({ value, onChange, providers, inheritedProvider = "", disabled = false, includeMode = true, global = false }: {
  value: Selection;
  onChange(value: Selection): void;
  providers: Provider[];
  inheritedProvider?: string;
  disabled?: boolean;
  includeMode?: boolean;
  global?: boolean;
}) {
  const provider = providers.find((item) => item.id === (value.provider || inheritedProvider));
  return <>
    <SettingsSelect label="Provider" value={value.provider} options={options(providers.filter((item) => item.available), value.provider, global ? "Select a provider" : inheritedProvider ? `Default (${inheritedProvider})` : "Use default provider")} disabled={disabled} onValueChange={(next) => onChange({ provider: next, model: "", modeId: "" })} />
    <SettingsSelect label="Model" value={value.model} options={options(provider?.models || [], value.model, global ? "Provider default" : "Use default model")} disabled={disabled} onValueChange={(model) => onChange({ ...value, model })} />
    {includeMode && <SettingsSelect label="Mode" value={value.modeId} options={options(provider?.modes || [], value.modeId, global ? "Provider default" : "Use default mode")} disabled={disabled} onValueChange={(modeId) => onChange({ ...value, modeId })} />}
  </>;
}

export function ProviderErrors({ providers }: { providers: Provider[] }) {
  const unavailable = providers.filter((provider) => !provider.available || provider.error);
  if (!unavailable.length) return null;
  return <SettingsCard>{unavailable.map((provider) => <SettingsRow key={provider.id} label={provider.id} error={provider.error || "Provider is unavailable on this host."} />)}</SettingsCard>;
}

export function issueUrl(base: string, issueId: number): string {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/issue/${issueId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
