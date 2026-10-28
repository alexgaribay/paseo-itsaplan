import { useCallback } from "react";
import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useBotRpc as useRpc } from "./bot-context";
import { Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { taskContextRpc } from "../shared/rpc";
import { Feedback, RefreshButton, useAction, useResource, Warning } from "./common";

export function SelectedContext({ sessionKey, onClose, ...props }: PluginSurfaceProps & { sessionKey: string; onClose(): void }) {
  const inspect = useRpc(taskContextRpc);
  const load = useCallback(() => inspect({ key: sessionKey }), [inspect, sessionKey]);
  const resource = useResource(load);
  const action = useAction();
  const captured = resource.data?.captured;
  const latest = resource.data?.latest;
  return <Modal title="Task context and development" open onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Content>
    <SettingsSection title="Captured context" info="A historical snapshot, not current project state. Private task text and attachment bytes are not exposed here." trailing={<RefreshButton theme={props.theme} label="Refresh execution context" onPress={resource.refresh} disabled={resource.loading} />}>
      {captured ? <>
        <SettingsCard>
          <SettingsRow label="Captured" hint={new Date(captured.capturedAt).toLocaleString()} />
          <SettingsRow label="Included context" hint={`${captured.textChars.toLocaleString()} characters · ${captured.assetCount} images`} />
        </SettingsCard>
        {captured.warnings.map((warning, index) => <Warning key={index} message={warning} />)}
      </> : <Feedback theme={props.theme} message={resource.loading ? "Loading context…" : "No optional context snapshot was recorded for this execution."} />}
    </SettingsSection>
    <SettingsSection title="Current development links" info="Read from the linked issue, without changing its status. A branch or pull request is not proof of passing tests or issue completion. Gitea managed hooks and outbound PR actions have upstream limitations; see the plugin documentation.">
      {resource.data?.warning && <Warning message={resource.data.warning} />}
      {latest && <>
        <SettingsCard>
          <SettingsRow label="Checked" hint={new Date(resource.data!.checkedAt).toLocaleString()} />
          {latest.development.map((item) => <SettingsAction key={`${item.provider}:${item.id}`} label={item.title} hint={`${item.provider} · ${item.kind} · ${item.state}${item.sourceBranch ? ` · ${item.sourceBranch}` : ""}`} actionLabel="Open" disabled={!item.url || action.pending} onPress={() => { if (item.url) void action.run(() => openExternalUrl(item.url!)); }} />)}
          {!latest.development.length && <SettingsRow label="No development links returned" hint="This observation does not prove that work was not performed." />}
        </SettingsCard>
        {latest.warnings.map((warning, index) => <Warning key={index} message={warning} />)}
      </>}
      <Feedback theme={props.theme} error={resource.error || action.error} />
    </SettingsSection>
  </Modal.Content></Modal>;
}
