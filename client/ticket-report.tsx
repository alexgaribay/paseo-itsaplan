import { useCallback, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ticketReportPreviewRpc, ticketReportSubmitRpc, ticketReportReconcileRpc } from "../shared/rpc";
import type { TicketReportPreview, TicketReportResult } from "../shared/ticket-report";
import { Feedback, useAction, useResource, Warning } from "./common";

export function TicketReportReview({ sessionKey, onClose, onChange, ...props }: PluginSurfaceProps & { sessionKey: string; onClose(): void; onChange(): void }) {
  const preview = useRpc(ticketReportPreviewRpc);
  const submit = useRpc(ticketReportSubmitRpc);
  const reconcile = useRpc(ticketReportReconcileRpc);
  const action = useAction();
  const load = useCallback(() => preview({ key: sessionKey }), [preview, sessionKey]);
  const resource = useResource(load);
  const [edited, setEdited] = useState<TicketReportPreview>();
  const [notes, setNotes] = useState<string>();
  const [attestedDigest, setAttestedDigest] = useState<string>();
  const [delivery, setDelivery] = useState<TicketReportResult>();
  const current = edited ?? resource.data;
  const dirty = notes !== undefined && notes !== current?.notes;
  const attempted = delivery !== undefined || current?.state === "unknown" || current?.state === "submitting" || current?.state === "submitted";
  return <Modal title="Review ticket report" open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}><Modal.Content>
    <SettingsSection title="Original task review" info="Report permission comes from your review of the original task, not from a successful model response. Missing or restricted original tasks cannot be reported.">
      {current && <SettingsCard>
        <SettingsRow label="Original task" hint={current.review.task} />
        <SettingsRow label="Original system instructions" hint={current.review.systemPrompt} />
        <SettingsRow label="Original requirements" hint={current.review.requirements} />
      </SettingsCard>}
    </SettingsSection>
    <SettingsSection title="Exact comment preview" info="The plugin never posts automatically. This action cannot change requirements, checklist items or issue status. Model claims are not verified implementation or test evidence.">
      {current && <>
        <SettingsCard>
          <SettingsRow label={current.operation === "update" ? `Update bot comment ${current.commentId}` : "Create this run's bot comment"} hint={current.body} />
          <SettingsInput key={current.digest} label="User-reviewed notes" hint="Optional plain text, at most 2000 characters. Do not include credentials, links, mentions or private context. Notes are not verified evidence." initialValue={current.notes} onChangeText={(value) => { setNotes(value); setAttestedDigest(undefined); }} disabled={action.pending || attempted} />
          <SettingsAction label="Apply edited notes to a new exact preview" actionLabel="Review edits" disabled={action.pending || attempted || !dirty || (notes?.length ?? 0) > 2000} onPress={() => { void action.run(async () => { const next = await preview({ key: sessionKey, body: notes }); setEdited(next); setNotes(undefined); setAttestedDigest(undefined); return "Edited notes are ready for review. Nothing has been posted."; }); }} />
          <SettingsSwitch label="Attest original task permits this report" hint={current.review.statement} value={attestedDigest === current.digest} onValueChange={(value) => setAttestedDigest(value ? current.digest : undefined)} disabled={action.pending || attempted || dirty} />
          <SettingsAction label="Approve exactly the displayed report" hint="This is an external write. Unknown delivery cannot be retried or replaced." actionLabel={current.operation === "update" ? "Approve and update comment" : "Approve and post comment"} disabled={resource.loading || action.pending || attempted || dirty || attestedDigest !== current.digest} onPress={() => { void action.run(async () => { const next = await submit({ key: sessionKey, digest: current.digest, attestation: { fingerprint: current.review.fingerprint, unrestrictedTask: true } }); setDelivery(next); setAttestedDigest(undefined); onChange(); return next.message; }); }} />
        </SettingsCard>
        {current.warnings.map((message, index) => <Warning key={index} message={message} />)}
      </>}
      <SettingsCard>
        {delivery && <SettingsRow label={`Report ${delivery.state}`} hint={delivery.commentId === null ? "Comment receipt not confirmed" : `Comment ${delivery.commentId}`} />}
        <SettingsAction label="Read authoritative delivery without posting or retrying" actionLabel="Reconcile report" disabled={action.pending || resource.loading} onPress={() => { void action.run(async () => { const next = await reconcile({ key: sessionKey }); setDelivery(next); onChange(); return next.message; }); }} />
      </SettingsCard>
      <Feedback theme={props.theme} error={resource.error || action.error} message={action.message} />
    </SettingsSection>
  </Modal.Content></Modal>;
}
