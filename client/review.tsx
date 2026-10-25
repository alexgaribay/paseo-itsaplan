import { useCallback, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { SessionRecord } from "../shared/models";
import type { ExecutionReview } from "../shared/experience";
import { markReviewedRpc, reviewRpc } from "../shared/rpc";
import { Feedback, useAction, useResource, Warning } from "./common";

const timestamp = (value: number | null | undefined) => value == null ? "Not reviewed" : new Date(value).toLocaleString();

export function HistoricalReview({ session, onClose, onChange, ...props }: PluginSurfaceProps & { session: Omit<SessionRecord, "task">; onClose(): void; onChange(): void }) {
  const review = useRpc(reviewRpc);
  const markReviewed = useRpc(markReviewedRpc);
  const load = useCallback(() => review({ key: session.key }), [review, session.key]);
  const resource = useResource(load);
  const action = useAction();
  const [acknowledgment, setAcknowledgment] = useState<ExecutionReview>();
  const current = acknowledgment?.fingerprint === resource.data?.fingerprint ? acknowledgment : resource.data;
  return <Modal title="Compare and review execution" open onOpenChange={(open) => { if (!open && !action.pending) onClose(); }}><Modal.Content>
    <SettingsSection title="Recorded historical evidence" info="The recorded execution is preserved. A review is only an acknowledgment that you inspected these observations. It does not confirm delivery, stop work, clear request fences, or complete the issue.">
      <SettingsCard>
        <SettingsRow label="Plugin execution" hint={`${session.phase} · attempt ${session.attempt} · recorded ${new Date(session.updatedAt).toLocaleString()}`} />
        <SettingsRow label="Recorded native result" hint={session.result?.status || "Not recorded"} error={session.result?.error || session.error} />
        <SettingsRow label="Recorded cancellation" hint={session.cancellation || "Not requested"} />
        <SettingsRow label="Recorded acceptance" hint={session.acceptance?.status || "Not assessed"} />
        <SettingsRow label="Previous review acknowledgment" hint={timestamp(session.review?.reviewedAt)} />
        {session.review && <SettingsRow label="Previously reviewed observations" hint={`Upstream ${session.review.observation.upstream} · native ${session.review.observation.native} · delivery ${session.review.observation.delivery} · acceptance ${session.review.observation.acceptance}`} />}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Current authoritative comparison" info="Unavailable and unknown observations stay unknown. Review is allowed only when upstream execution is terminal and native stop is positively observed.">
      {current && <>
        <SettingsCard>
          <SettingsRow label="Observed" hint={new Date(current.observedAt).toLocaleString()} />
          <SettingsRow label="Current upstream execution" hint={`${current.upstream} · attempt ${current.upstreamAttempt ?? "unknown"}`} />
          <SettingsRow label="Current native execution" hint={`${current.native} · ${current.pendingPermissionCount === null ? "permissions unknown" : `${current.pendingPermissionCount} pending permissions`}`} />
          <SettingsRow label="Result delivery evidence" hint={current.delivery} />
          <SettingsRow label="Acceptance evidence" hint={current.acceptance} />
          <SettingsRow label="Reviewed at" hint={timestamp(current.reviewedAt)} />
          <SettingsAction label="Acknowledge inspection without changing execution or delivery" hint={current.canMarkReviewed ? "The server rechecks this exact observation before recording the timestamp." : "Current observations do not establish that execution has stopped. Inspect the warnings before proceeding."} actionLabel={action.pending ? "Recording…" : "Mark reviewed"} disabled={resource.loading || action.pending || !current.canMarkReviewed} onPress={() => {
            const fingerprint = current.fingerprint;
            void action.run(async () => { const next = await markReviewed({ key: session.key, fingerprint }); setAcknowledgment(next); onChange(); return "Review acknowledgment recorded. Execution and delivery evidence are unchanged."; });
          }} />
        </SettingsCard>
        {current.warnings.map((message, index) => <Warning key={index} message={message} />)}
      </>}
      <SettingsCard><SettingsAction label={resource.loading ? "Reading upstream and native state…" : "Read the latest authoritative observations"} actionLabel="Refresh comparison" disabled={resource.loading || action.pending} onPress={() => { setAcknowledgment(undefined); resource.refresh(); }} /></SettingsCard>
      <Feedback theme={props.theme} error={resource.error || action.error} message={action.message} />
    </SettingsSection>
  </Modal.Content></Modal>;
}
