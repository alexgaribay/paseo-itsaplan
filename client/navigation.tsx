import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SettingsRow } from "@getpaseo/plugin/client/ui";

// Keep the installed primary screen link while replacing the issue browser.
export const activityScreenId = "issues";

export function NavigationRow({ theme, label, hint, disabled = false, onPress }: Pick<PluginSurfaceProps, "theme"> & {
  label: string;
  hint?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ opacity: disabled ? 0.45 : 1, backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}>
    <SettingsRow label={label} hint={hint}><Icon name="ChevronRight" size={18} color={theme.colors.foregroundMuted} /></SettingsRow>
  </Pressable>;
}

export function BackLink({ theme, label, onPress }: Pick<PluginSurfaceProps, "theme"> & { label: string; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, minHeight: 44, paddingHorizontal: 4, opacity: pressed ? 0.6 : 1 })}>
    <Icon name="ChevronLeft" size={18} color={theme.colors.foregroundMuted} />
    <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{label}</Text>
  </Pressable>;
}

export function ToolbarButton({ theme, label, icon, disabled = false, onPress }: Pick<PluginSurfaceProps, "theme"> & {
  label: string;
  icon?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, paddingHorizontal: 12, borderRadius: 8, backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1, opacity: disabled ? 0.45 : 1 })}>
    {icon && <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />}
    <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}

export function ScreenContent({ theme, layout, children }: Pick<PluginSurfaceProps, "theme" | "layout"> & { children: ReactNode }) {
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24 }} keyboardShouldPersistTaps="handled">
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", gap: 16 }}>{children}</View>
  </ScrollView>;
}
