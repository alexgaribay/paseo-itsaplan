import { View } from "react-native";
import { openExternalUrl, useSettings, type PluginOpenScreenInput, type PluginScreenParams, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading, SettingsSection } from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/config";
import { Feedback, useAction } from "./common";
import { activityScreenId, BackLink, ScreenContent, ToolbarButton } from "./navigation";
import { Sessions, type ExecutionPage } from "./sessions";

function executionPage(value: string | undefined): ExecutionPage {
  switch (value) {
    case "attention": case "history": case "requests": case "controls": case "session": return value;
    default: return "overview";
  }
}

export function executionScreenTitle(params: PluginScreenParams): string {
  return { overview: "It's a Plan", attention: "Executions needing attention", history: "Execution history", requests: "Delegation requests", controls: "Runtime controls", session: "Execution details" }[executionPage(params.view)];
}

export function ExecutionsScreen({ openScreen, openSettings, ...props }: PluginScreenProps & { openScreen(input: PluginOpenScreenInput): void; openSettings(): void }) {
  const settings = useSettings(preferences);
  const action = useAction();
  const page = executionPage(props.params.view);
  const webUrl = settings.status === "ready" ? settings.values.webUrl || settings.values.serverUrl : "";
  const parent = page === "session" && (props.params.from === "history" || props.params.from === "attention") ? props.params.from : "overview";
  const navigate = (next: ExecutionPage, sessionKey?: string) => openScreen({ screenId: activityScreenId, params: {
    ...(next !== "overview" ? { view: next } : {}),
    ...(next === "session" && sessionKey ? { sessionKey, from: page === "history" || page === "attention" ? page : parent } : {}),
  } });
  return <ScreenContent {...props}>
    {page === "overview" ? <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
      <ToolbarButton theme={props.theme} label="Open It's a Plan" icon="ExternalLink" disabled={!webUrl || action.pending} onPress={() => { void action.run(() => openExternalUrl(webUrl)); }} />
      <ToolbarButton theme={props.theme} label="Settings" icon="Settings" onPress={openSettings} />
    </View> : <BackLink theme={props.theme} label={parent === "history" ? "Execution history" : parent === "attention" ? "Needs attention" : "Overview"} onPress={() => navigate(parent)} />}
    <Feedback theme={props.theme} error={action.error} />
    {settings.status === "loading" ? <Loading /> : settings.status !== "ready" ? <SettingsSection title="Configuration unavailable"><Feedback theme={props.theme} error={settings.error} /></SettingsSection> : <Sessions {...props} serverUrl={settings.values.serverUrl} webUrl={webUrl} page={page} sessionKey={props.params.sessionKey} onNavigate={navigate} />}
  </ScreenContent>;
}
