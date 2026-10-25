import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SettingsScreen } from "./client/settings";
import { ExecutionsScreen, executionScreenTitle } from "./client/executions";
import { activityScreenId } from "./client/navigation";

function ActivityItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Activity" label="It's a Plan" active={currentScreen?.screenId === activityScreenId} onPress={() => openScreen({ screenId: activityScreenId })} />;
}

export default function contribute(client: PluginClientContext) {
  const Executions = (props: PluginScreenProps) => <ExecutionsScreen {...props} openScreen={(input) => client.openScreen(input)} openSettings={() => client.openSettings("connection")} />;
  const Settings = (props: PluginSurfaceProps) => <SettingsScreen {...props} openExecutions={() => client.openScreen({ screenId: activityScreenId })} />;
  const cleanup = [
    client.addSettingsScreen({ id: "connection", title: "It's a Plan", icon: "ListTodo", Component: Settings }),
    client.addScreen({ id: activityScreenId, title: executionScreenTitle, Component: Executions }),
    client.addSidebarHeaderItem({ id: "main", title: "It's a Plan", Component: ActivityItem }),
    client.addCommandCenterItem({ id: "view-executions", title: "View It's a Plan executions", icon: "Activity", keywords: ["sessions", "history", "delegation"], context: "global", onSelect: ({ openScreen }) => openScreen({ screenId: activityScreenId }) }),
    client.addCommandCenterItem({ id: "configure", title: "Configure It's a Plan", icon: "Settings", keywords: ["connection", "credentials", "projects"], context: "global", onSelect: ({ openSettings }) => openSettings("connection") }),
  ];
  return () => { for (const remove of cleanup.reverse()) remove(); };
}
