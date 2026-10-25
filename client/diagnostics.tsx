import { useCallback } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection, useToast } from "@getpaseo/plugin/client/ui";
import { diagnosticsRpc } from "../shared/rpc";
import { Feedback, useAction, useResource } from "./common";

export function DiagnosticsPreview({ onClose, ...props }: PluginSurfaceProps & { onClose(): void }) {
  const diagnostics = useRpc(diagnosticsRpc);
  const load = useCallback(() => diagnostics({}), [diagnostics]);
  const resource = useResource(load);
  const action = useAction();
  const toast = useToast();
  return <Modal title="Redacted diagnostics" open onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Content>
    <SettingsSection title="Diagnostics preview" info="Contains structural diagnostics without credentials, prompts, output, URLs, or local paths. Review this text before copying. If copying is unavailable, select the text below and copy it manually.">
      <SettingsCard>
        {resource.data && <>
          <SettingsRow label="Generated" hint={new Date(resource.data.generatedAt).toLocaleString()} />
          <Text selectable style={{ color: props.theme.colors.foreground, padding: 16 }}>{resource.data.text}</Text>
          <SettingsAction label="Copy the already-loaded text" actionLabel="Copy diagnostics" disabled={action.pending} onPress={() => {
            const text = resource.data!.text;
            void action.run(async () => { await copyText(text); toast.show("Diagnostics copied", { variant: "success" }); });
          }} />
        </>}
        <SettingsAction label={resource.loading ? "Loading diagnostics…" : "Generate a fresh redacted preview"} actionLabel="Refresh preview" disabled={resource.loading} onPress={resource.refresh} />
      </SettingsCard>
      <Feedback theme={props.theme} error={resource.error || action.error} />
      {action.error && <Feedback theme={props.theme} message="The preview is still available. Select the diagnostics text and use your device's Copy command." />}
    </SettingsSection>
  </Modal.Content></Modal>;
}
