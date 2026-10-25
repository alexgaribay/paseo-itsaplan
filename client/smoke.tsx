import { useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { Config } from "../shared/config";
import { Feedback, Warning } from "./common";
import { parseIssueReference } from "./issue-reference";
import { RerunReview } from "./rerun";

export function DelegationTestSetup({ config, draftDirty, onClose, onChange, ...props }: PluginSurfaceProps & { config: Config; draftDirty: boolean; onClose(): void; onChange(): void }) {
  const [reference, setReference] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const blocked = draftDirty || !config.serverUrl;
  const issueId = parseIssueReference(reference, config.webUrl || config.serverUrl);
  if (selected !== null) return <RerunReview {...props} source={{ kind: "issue", issueId: selected }} serverUrl={config.serverUrl} webUrl={config.webUrl || config.serverUrl} onClose={() => setSelected(null)} onChange={onChange} />;
  return <Modal title="Test delegation" open onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Content>
    <SettingsSection title="Use an existing test issue" info="Copy its URL from It's a Plan. Review the saved execution plan before preparing or submitting a no-tools smoke request.">
      {draftDirty && <Warning message="Save or discard settings changes before testing. Only saved settings are used." />}
      {!config.automatic && <Warning message="Enable and save automatic delegation before request delivery." />}
      <SettingsCard>
        <SettingsInput label="Issue URL or numeric ID" placeholder="https://plan.example.com/issue/123" initialValue={reference} disabled={blocked} onChangeText={setReference} />
        <SettingsAction label="Check the saved host and project routing" actionLabel="Review test" disabled={blocked || issueId === null} onPress={() => { if (issueId !== null) setSelected(issueId); }} />
      </SettingsCard>
      <Feedback theme={props.theme} error={reference.trim() && issueId === null ? "Use an issue URL from the configured web app, or a positive numeric issue ID." : undefined} />
    </SettingsSection>
  </Modal.Content></Modal>;
}
