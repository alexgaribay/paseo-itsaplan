import { useCallback, useState } from "react";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useBotRpc as useRpc } from "./bot-context";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsSection, useToast } from "@getpaseo/plugin/client/ui";
import { credentialsRpc, statusRpc } from "../shared/rpc";
import { Feedback, useAction, useResource } from "./common";

type CredentialKind = "apiKey" | "mcpToken" | "paseoPassword" | "requestApiKey";
const fields = {
  apiKey: {
    label: "External-agent execution API key",
    presence: "credentialPresent",
    info: "Connect this It's a Plan external agent using its own execution API key. Give that agent access to the projects Paseo should handle. Personal account keys and MCP tokens cannot execute tasks.",
    hint: "This external agent's execution key; not a personal API key or MCP token.",
  },
  mcpToken: {
    label: "MCP token",
    presence: "mcpCredentialPresent",
    info: "Shared by all registered bots. Use a separate, scoped It's a Plan credential. Its upstream role controls which MCP capabilities agents can access. Never use an execution API key.",
    hint: "Shared credential, separate from every bot's execution key.",
  },
  paseoPassword: {
    label: "Paseo password",
    presence: "passwordPresent",
    info: "Shared by all registered bots. Required only when this daemon's WebSocket endpoint requires a password. This is not an It's a Plan credential.",
    hint: "Shared credential, only if the local daemon requires authentication.",
  },
  requestApiKey: {
    label: "Human rerun request API key",
    presence: "requestCredentialPresent",
    info: "Shared by all registered bots. Optional human account API key for explicitly confirmed rerun and smoke comments. The server verifies that the account is human. This key is never used for runner authentication, agents, or MCP. Without it, copy the request and post it in the browser.",
    hint: "Shared human account credential. Separate from runner and MCP credentials.",
  },
} as const;

export function CredentialField({ kind, ownerName, disabled = false, ...props }: PluginSurfaceProps & { kind: CredentialKind; ownerName?: string; disabled?: boolean }) {
  const saveCredentials = useRpc(credentialsRpc);
  const status = useRpc(statusRpc);
  const load = useCallback(() => status({}), [status]);
  const resource = useResource(load);
  const action = useAction();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [version, setVersion] = useState(0);
  const field = fields[kind];
  const present = resource.data?.[field.presence];
  const close = () => { setOpen(false); setSecret(""); setVersion((value) => value + 1); };
  const save = (value: string) => {
    void action.run(async () => {
      try {
        const result = await saveCredentials({ [kind]: value });
        if (!result.ok) throw new Error(result.message);
        resource.refresh();
        toast.show(value ? "Credential saved" : "Credential removed", { variant: "success" });
        close();
      } finally {
        setSecret("");
        setVersion((current) => current + 1);
      }
    });
  };
  return <>
    <SettingsAction label={field.label} hint={present === undefined ? "Checking credential…" : present ? "Stored" : "Not configured"} actionLabel={present ? "Replace" : "Add"} disabled={disabled || action.pending} onPress={() => { resource.refresh(); setOpen(true); }} />
    <Modal title={kind === "apiKey" && ownerName ? `${ownerName} execution key` : field.label} open={open} onOpenChange={(next) => { if (!next && !action.pending) close(); }}>
      <Modal.Content>
        <SettingsSection title="Credential" info={`${field.info} Stored plaintext is never returned. Credentials save separately from the settings draft. Runner connection changes drain active work before replacement.`}>
          <SettingsCard>
            <SettingsInput key={version} label="New credential" hint={field.hint} secureTextEntry initialValue="" disabled={disabled || action.pending} onChangeText={setSecret} />
            <SettingsAction label={present ? "Replace stored credential" : "Store credential"} actionLabel={action.pending ? "Saving…" : "Save credential"} disabled={disabled || action.pending || !secret.length} onPress={() => save(secret)} />
            {present && <SettingsAction label="Stored credential" actionLabel="Remove" disabled={disabled || action.pending} onPress={() => save("")} />}
          </SettingsCard>
          <Feedback theme={props.theme} error={action.error || resource.error} />
        </SettingsSection>
      </Modal.Content>
    </Modal>
  </>;
}
