import { useCallback, useRef, useState } from "react";
import { Text } from "react-native";
import { openExternalUrl, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, SettingsAction, SettingsCard, SettingsRow, SettingsSection, useToast } from "@getpaseo/plugin/client/ui";
import type { RerunResult } from "../shared/experience";
import { queueRpc, recoverHandoffRpc, rerunDiscardRpc, rerunPreviewRpc, rerunReconcileRpc, rerunSubmitRpc, smokePreviewRpc, statusRpc } from "../shared/rpc";
import { Feedback, issueUrl, useAction, useResource, Warning } from "./common";
import { ExecutionPlanDetails } from "./experience";
import { canDiscardPreview, mergeRequestResult } from "./request-state";

export type RequestSource = { kind: "run"; key: string; issueId: number; operation: "rerun" | "smoke" } | { kind: "issue"; issueId: number };

function RequestProgress({ result, serverUrl, ...props }: PluginSurfaceProps & { result: RerunResult; serverUrl: string }) {
  const status = useRpc(statusRpc);
  const queue = useRpc(queueRpc);
  const reconcile = useRpc(rerunReconcileRpc);
  const loadRequest = useCallback(() => reconcile({ requestId: result.requestId }), [reconcile, result.requestId]);
  const request = useResource(loadRequest, 5000);
  const current = request.data || result;
  const loadStatus = useCallback(() => status({}), [status]);
  const loadQueue = useCallback(() => queue({}), [queue]);
  const execution = useResource(loadStatus, 5000);
  const upstream = useResource(loadQueue, 5000);
  const run = upstream.data?.items.find((item) => item.id === current.runId);
  const session = execution.data?.sessions.find((item) => item.serverUrl === serverUrl && item.kind === "run" && item.externalId === current.runId);
  return <SettingsSection title="Live execution tracking" info="Refreshes every five seconds. Request delivery, upstream execution, native result and acceptance are separate observations. None marks the issue complete.">
    <RequestResultDetails result={current} />
    <SettingsCard>
      <SettingsRow label="Upstream run" hint={run ? `${run.id} · ${run.state} · attempt ${run.attempts}` : current.runId === null ? "No run observed. Delivery is not proof of queued work." : `Run ${current.runId} is not in the current queue snapshot. This does not prove it stopped.`} />
      <SettingsRow label="Queue snapshot" hint={upstream.data ? `${upstream.data.availability} · ${upstream.data.complete ? "complete" : "partial"} · ${new Date(upstream.data.checkedAt).toLocaleString()}` : "Not yet observed"} />
      <SettingsRow label="Native session" hint={session ? `${session.agentId} · ${session.phase} · ${session.pendingPermissionCount === undefined ? "permissions unknown" : `${session.pendingPermissionCount} pending permissions`}` : "No matching native session observed"} />
      <SettingsRow label="Native result" hint={session?.result?.status || "Not recorded"} error={session?.result?.error} />
      <SettingsRow label="Result delivery" hint={session ? session.phase === "finished" ? "Delivered" : session.phase === "reporting" ? "Pending" : session.phase === "uncertain" || session.phase === "lease-lost" ? "Unknown" : "Not confirmed" : "Not recorded"} />
      <SettingsRow label="Acceptance" hint={session?.acceptance?.status || "Not assessed"} />
      {session?.acceptance?.checks.map((check) => <SettingsRow key={check.id} label={`${check.id} · ${check.status}`} hint={check.message} />)}
      {session && props.navigation && <SettingsAction label="Inspect the observed native session" actionLabel="Open agent" onPress={() => { props.navigation?.openAgent({ agentId: session.agentId, serverId: props.host.id }); }} />}
      <SettingsAction label="Read current request, queue and native status" actionLabel="Refresh tracking" disabled={request.loading || execution.loading || upstream.loading} onPress={() => { request.refresh(); execution.refresh(); upstream.refresh(); }} />
    </SettingsCard>
    <Warning message={upstream.data?.warning} />
    <Feedback theme={props.theme} error={request.error || execution.error || upstream.error} />
  </SettingsSection>;
}

function RequestResultDetails({ result }: { result: RerunResult }) {
  return <SettingsCard>
    <SettingsRow label={`Request ${result.state}`} hint={result.message} />
    <SettingsRow label="Observed upstream comment" hint={result.commentId === null ? "Not observed" : String(result.commentId)} />
    <SettingsRow label="Observed upstream run" hint={result.runId === null ? "Not observed. Queued work is not confirmed." : String(result.runId)} />
  </SettingsCard>;
}

function BrowserHandoff({ result, issueId, webUrl, ...props }: PluginSurfaceProps & { result: RerunResult; issueId: number; webUrl: string }) {
  const action = useAction();
  const toast = useToast();
  return <SettingsSection title="Exact browser handoff" info="Do not post this comment twice. It contains the original request ID and nonce. Reconcile delivery first if it might already have been posted. Copying or opening the issue does not submit anything.">
    <Warning message={result.runId === null ? "Do not post this request twice. Unconfirmed delivery is not proof that it was never posted; check the issue history first." : `Upstream run ${result.runId} has already been observed. Do not post this comment again.`} />
    <SettingsCard>
      <SettingsRow label="Request ID" hint={result.requestId} />
      <Text selectable style={{ color: props.theme.colors.foreground, padding: 16 }}>{result.comment}</Text>
      <SettingsAction label="Copy only if this request has not already been posted" actionLabel="Copy comment" disabled={action.pending || !result.comment} onPress={() => { const text = result.comment!; void action.run(async () => { await copyText(text); toast.show("Comment copied, not posted. Post it only once as a human.", { variant: "info" }); }); }} />
      {webUrl && <SettingsAction label="Inspect the issue before posting" actionLabel="Open issue" disabled={action.pending} onPress={() => { void action.run(() => openExternalUrl(issueUrl(webUrl, issueId))); }} />}
    </SettingsCard>
    <Feedback theme={props.theme} error={action.error} />
    {action.error && <Feedback theme={props.theme} message="The original comment remains selectable above. Use your device's Copy command if clipboard access is unavailable." />}
  </SettingsSection>;
}

export function HandoffRecovery({ requestId, webUrl, onClose, onChange, ...props }: PluginSurfaceProps & { requestId: string; webUrl: string; serverUrl: string; onClose(): void; onChange(): void }) {
  const recover = useRpc(recoverHandoffRpc);
  const load = useCallback(async () => { const result = await recover({ requestId }); onChange(); return result; }, [recover, requestId, onChange]);
  const resource = useResource(load);
  return <Modal title="Recover browser handoff" open onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Content>
    <SettingsSection title="Reconcile before recovery" info="Recovery reads the existing request and reconciles upstream delivery. It never creates a new request, changes the nonce, or reposts a comment. Do not post again if delivery is uncertain.">
      <SettingsCard><SettingsAction label={resource.loading ? "Reconciling the original request…" : "Reconcile the existing request without reposting"} actionLabel="Refresh delivery" disabled={resource.loading} onPress={resource.refresh} /></SettingsCard>
      <Feedback theme={props.theme} error={resource.error} />
    </SettingsSection>
    {resource.data && <>
      <BrowserHandoff {...props} result={resource.data} issueId={resource.data.issueId} webUrl={webUrl} />
      <RequestProgress {...props} result={resource.data} />
    </>}
  </Modal.Content></Modal>;
}

export function RerunReview({ source, webUrl, onClose, onChange, ...props }: PluginSurfaceProps & { source: RequestSource; webUrl: string; serverUrl: string; onClose(): void; onChange(): void }) {
  const prepare = useRpc(rerunPreviewRpc);
  const prepareSmoke = useRpc(smokePreviewRpc);
  const submit = useRpc(rerunSubmitRpc);
  const reconcile = useRpc(rerunReconcileRpc);
  const discard = useRpc(rerunDiscardRpc);
  const operation = source.kind === "issue" ? "smoke" : source.operation;
  const sourceKey = source.kind === "run" ? source.key : null;
  const issueId = source.issueId;
  const load = useCallback(() => sourceKey === null ? prepareSmoke({ issueId }) : prepare({ key: sourceKey, operation }), [prepare, prepareSmoke, sourceKey, issueId, operation]);
  const preview = useResource(load);
  const action = useAction();
  const submitting = useRef(false);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<RerunResult>();
  const blocked = attempted || (result !== undefined && result.state !== "prepared");
  const refresh = () => {
    if (!preview.data) return;
    void action.run(async () => {
      const next = await reconcile({ requestId: preview.data!.requestId });
      setResult((previous) => mergeRequestResult(previous, next));
      onChange();
      return next.message;
    });
  };
  const close = () => {
    if (action.pending || preview.loading) return;
    if (!preview.data || !canDiscardPreview(attempted, result)) { onClose(); return; }
    void action.run(async () => {
      const discarded = await discard({ requestId: preview.data!.requestId });
      onChange();
      if (discarded.state !== "dismissed") throw new Error(discarded.message);
      onClose();
    });
  };
  const deliver = () => {
    if (submitting.current || blocked || !preview.data) return;
    submitting.current = true;
    setAttempted(true);
    const reviewed = preview.data;
    void action.run(async () => {
      try {
        const next = await submit({ requestId: reviewed.requestId, planDigest: reviewed.planDigest });
        setResult((previous) => mergeRequestResult(previous, next));
        return next.message;
      } finally { onChange(); }
    });
  };
  return <Modal title={operation === "smoke" ? "Review delegation test" : "Review rerun request"} icon={<Icon name="RotateCcw" size={18} color={props.theme.colors.foreground} />} open onOpenChange={(open) => { if (!open) close(); }}><Modal.Content>
    <SettingsSection title={operation === "smoke" ? "Instruction-only smoke check" : "New upstream request"} info={operation === "smoke" ? "Requests the fixed smoke response without tools through the normal upstream delegation path. No-tools is instruction-only, not enforced isolation. Acceptance is separate from result delivery. This does not change the issue status or directly create a native session." : "Creates a uniquely identified human request for the original task. It does not resend a framed runner prompt, change issue status, or directly start a native session."}>
      {preview.loading && <Feedback theme={props.theme} message="Preparing the execution plan and checking upstream state…" />}
      <Feedback theme={props.theme} error={preview.error} />
      {preview.error && !attempted && <SettingsCard><SettingsAction label="Read authoritative source and routing again" actionLabel="Refresh review" disabled={action.pending} onPress={preview.refresh} /></SettingsCard>}
    </SettingsSection>
    {preview.data && <>
      <ExecutionPlanDetails plan={preview.data.plan} />
      {preview.data.warnings.map((warning, index) => <Warning key={index} message={warning} />)}
      <SettingsSection title="Request delivery" info={preview.data.delivery === "api" ? "Uses the separate human request credential after rechecking saved settings and this plan. A delivered comment does not prove a run was queued." : "No human API credential is configured. Prepare a durable browser handoff, then review and copy its exact comment in a separate action. Post once as a human, then refresh delivery."}>
        <SettingsCard>
          <SettingsRow label="Request ID" hint={preview.data.requestId} />
          <SettingsAction label="Confirm the reviewed saved execution plan" actionLabel={action.pending ? "Preparing…" : preview.data.delivery === "api" ? "Submit request" : "Prepare browser handoff"} disabled={action.pending || blocked} onPress={deliver} />
          <SettingsAction label="Reconcile against authoritative upstream runs" hint="Unknown or pending delivery blocks duplicate submission. Refresh never reposts the comment." actionLabel="Refresh delivery" disabled={action.pending} onPress={refresh} />
        </SettingsCard>
        {attempted && !result && <Warning message="Submission was attempted. Delivery has not been confirmed. Do not submit again. Refresh delivery first." />}
        <Feedback theme={props.theme} error={action.error} message={action.message} />
      </SettingsSection>
      {result?.comment && <BrowserHandoff {...props} result={result} issueId={issueId} webUrl={webUrl} />}
      {result && <RequestProgress {...props} result={result} />}
    </>}
  </Modal.Content></Modal>;
}
