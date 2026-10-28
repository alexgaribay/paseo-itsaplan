import { useCallback, useState } from "react";
import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useBotRpc as useRpc } from "./bot-context";
import { Modal, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { cancelRpc, controlRpc, milestoneRpc, rerunDiscardRpc, rerunReconcileRpc, statusRpc } from "../shared/rpc";
import { milestoneSchema, type Milestone } from "../shared/config";
import type { PublicSession } from "../shared/models";
import type { RerunRequest } from "../shared/experience";
import { Feedback, issueUrl, RefreshButton, useAction, useResource } from "./common";
import { ExecutionPlanDetails } from "./experience";
import { HandoffRecovery, RerunReview } from "./rerun";
import { DiagnosticsPreview } from "./diagnostics";
import { HistoricalReview } from "./review";
import { NavigationRow } from "./navigation";
import { SelectedContext } from "./selected-context";
import { TicketReportReview } from "./ticket-report";

type PublicRequest = Omit<RerunRequest, "body" | "planDigest" | "serverUrl" | "continuation" | "continuationScope">;
export type ExecutionPage = "overview" | "attention" | "history" | "requests" | "controls" | "session";
type SessionsProps = PluginSurfaceProps & {
  webUrl: string;
  serverUrl: string;
  continuationEnabled: boolean;
  page: ExecutionPage;
  sessionKey?: string;
  onNavigate(page: ExecutionPage, sessionKey?: string): void;
};
const terminalPhases: Partial<Record<PublicSession["phase"], true>> = { finished: true, canceled: true, "lease-lost": true };
const stageLabels: Record<PublicSession["phase"], string> = {
  preparing: "Preparing execution", created: "Agent created", sending: "Sending task", running: "Running",
  stopping: "Cancellation pending", reporting: "Delivering result", finished: "Execution finished", canceled: "Execution canceled",
  "lease-lost": "Lease lost, inspect execution", uncertain: "Outcome unknown, inspect execution",
};
const milestoneLabels: Record<Milestone, string> = {
  "turn-completed": "Turn completed", "implementation-completed": "Implementation completed", "tests-passed": "Tests passed",
  "pull-request-created": "Pull request created", "ready-for-review": "Ready for review", "issue-completed": "Issue completed",
};
export const milestoneOptions = milestoneSchema.options.map((value) => ({ value, label: milestoneLabels[value] }));
const timestamp = (value: number | null | undefined) => value == null ? "Unknown" : new Date(value).toLocaleString();
function cancellationLabel(session: PublicSession): string {
  switch (session.cancellation) {
    case "requested": return "Requested, native stop not yet confirmed";
    case "confirmed": return "Native stop confirmed";
    case "unconfirmed": return "Unconfirmed, inspect the native agent";
    default: return session.phase === "canceled" ? "No native stop confirmation recorded" : "Not requested";
  }
}
function deliveryLabel(session: PublicSession): string {
  if (session.kind === "manual") return session.result ? "Recorded locally, no automatic delivery" : "No result recorded";
  if (session.phase === "finished") return "Delivered";
  if (session.phase === "reporting") return "Pending delivery";
  if (session.phase === "uncertain" || session.phase === "lease-lost") return "Unknown";
  return session.result ? "Result recorded, delivery not confirmed" : "No result recorded";
}

function sessionTitle(session: PublicSession): string {
  const execution = `${session.kind === "run" ? "Run" : session.kind === "chat" ? "Chat" : "Manual session"} ${session.externalId}`;
  return `${session.issueIdentifier || (session.issueId === null ? execution : `Issue ${session.issueId}`)}${session.issueIdentifier || session.issueId !== null ? ` · ${execution}` : ""} · attempt ${session.attempt}`;
}

function sessionStage(session: PublicSession): string {
  const approvals = session.pendingPermissionCount;
  return approvals ? `${approvals} approval${approvals === 1 ? "" : "s"} needed, open agent` : stageLabels[session.phase];
}

function RequestStatus({ requests, refresh, webUrl, title = "Delegation requests", ...props }: PluginSurfaceProps & { requests: PublicRequest[]; refresh(): void; webUrl: string; serverUrl: string; title?: string }) {
  const reconcile = useRpc(rerunReconcileRpc);
  const discard = useRpc(rerunDiscardRpc);
  const action = useAction();
  const [selectedId, setSelectedId] = useState<string>();
  const [recovering, setRecovering] = useState<string>();
  const selected = requests.find((request) => request.id === selectedId);
  if (!requests.length) return null;
  return <>
    <SettingsSection title={title}>
      <SettingsCard>
        {requests.map((request) => <NavigationRow key={request.id} theme={props.theme} label={`Issue ${request.issueId} · ${request.operation} · ${request.state}`} hint={`${request.runId === null ? "Run not observed" : `Run ${request.runId}`} · ${timestamp(request.updatedAt)}${request.error ? " · Request error, inspect details" : ""}`} onPress={() => setSelectedId(request.id)} />)}
      </SettingsCard>
    </SettingsSection>
    {selectedId && !recovering && <Modal title="Delegation request" open onOpenChange={(open) => { if (!open && !action.pending) setSelectedId(undefined); }}><Modal.Content>
      <SettingsSection title={selected ? `Issue ${selected.issueId} · ${selected.operation}` : "Request unavailable"} info="A submitted comment is not proof of a queued or completed run. Reconcile outstanding requests before another request. Browser handoffs retain the original request ID and nonce.">
        {selected ? <SettingsCard>
          <SettingsRow label="Delivery state" hint={selected.state} error={selected.error} />
          <SettingsRow label="Request ID" hint={selected.id} />
          <SettingsRow label="Upstream run" hint={selected.runId === null ? "Not observed" : `Run ${selected.runId}`} />
          <SettingsRow label="Comment" hint={selected.commentId === null ? "Not observed" : String(selected.commentId)} />
          <SettingsRow label="Delivery method" hint={selected.delivery} />
          <SettingsRow label="Updated" hint={timestamp(selected.updatedAt)} />
          {selected.state !== "dismissed" && selected.state !== "failed" && <SettingsAction label={selected.state === "prepared" ? "Dismiss an untouched preview" : "Read authoritative delivery without reposting"} actionLabel={selected.state === "prepared" ? "Discard preview" : "Reconcile"} disabled={action.pending} onPress={() => { void action.run(async () => { const result = selected.state === "prepared" ? await discard({ requestId: selected.id }) : await reconcile({ requestId: selected.id }); refresh(); return result.message; }); }} />}
          {selected.delivery === "browser" && (selected.state === "unknown" || selected.state === "submitted") && <SettingsAction label="Recover the exact original browser handoff" hint="Reconciles first. Do not post twice, even if delivery is unknown." actionLabel="Recover handoff" disabled={action.pending} onPress={() => setRecovering(selected.id)} />}
        </SettingsCard> : <Feedback theme={props.theme} message="This request is no longer in the latest status response. Refresh the requests page to read current records." />}
        <Feedback theme={props.theme} error={action.error} message={action.message} />
      </SettingsSection>
    </Modal.Content></Modal>}
    {recovering && <HandoffRecovery {...props} requestId={recovering} webUrl={webUrl} onClose={() => setRecovering(undefined)} onChange={refresh} />}
  </>;
}

function Session({ session, requests, webUrl, serverUrl, continuationEnabled, refresh, refreshing, ...props }: PluginSurfaceProps & { session: PublicSession; requests: PublicRequest[]; webUrl: string; serverUrl: string; continuationEnabled: boolean; refresh(): void; refreshing: boolean }) {
  const cancel = useRpc(cancelRpc);
  const milestone = useRpc(milestoneRpc);
  const action = useAction();
  const [detail, setDetail] = useState<"technical" | "plan" | "milestone" | "context" | "report" | null>(null);
  const [operation, setOperation] = useState<"rerun" | "smoke" | "continue" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [selectedMilestone, setMilestone] = useState<Milestone>("implementation-completed");
  const [evidence, setEvidence] = useState("");
  const [evidenceVersion, setEvidenceVersion] = useState(0);
  const currentServer = session.serverUrl === serverUrl;
  const issueId = session.issueId;
  const sourceRequests = requests.filter((request) => request.sourceKey === session.key);
  const duplicate = sourceRequests.some((request) => request.state === "submitting" || request.state === "unknown" || (request.state === "submitted" && request.runId === null));
  const canRerun = session.kind === "run" && issueId !== null && currentServer;
  const approvals = session.pendingPermissionCount;
  const openAgent = () => { void action.run(async () => { props.navigation?.openAgent({ agentId: session.agentId, serverId: props.host.id }); }); };
  return <>
    <SettingsSection title={sessionTitle(session)} info="Turn outcome, result delivery and acceptance are separate observations. None alone proves that the issue is complete." trailing={<RefreshButton theme={props.theme} label="Refresh session status" onPress={refresh} disabled={refreshing} />}>
      <SettingsCard>
        <SettingsRow label={sessionStage(session)} hint={`Updated ${timestamp(session.updatedAt)}`} error={session.error} />
        <SettingsRow label="Turn outcome" hint={session.result?.status || "Not recorded"} error={session.result?.error} />
        <SettingsRow label="Result delivery" hint={deliveryLabel(session)} />
        <SettingsRow label="Acceptance" hint={session.acceptance?.status || "Not assessed"} />
        <SettingsRow label="Cancellation" hint={cancellationLabel(session)} />
        {props.navigation && <SettingsAction label={approvals === undefined ? "Approvals unknown" : `${approvals} pending approvals`} actionLabel="Open agent" disabled={action.pending} onPress={openAgent} />}
        {issueId !== null && webUrl && currentServer && <SettingsAction label="It's a Plan issue" actionLabel="Open issue" disabled={action.pending} onPress={() => { void action.run(async () => { await openExternalUrl(issueUrl(webUrl, issueId)); }); }} />}
        {!terminalPhases[session.phase] && <SettingsAction label="Request cancellation" hint="A request does not confirm the native agent has stopped. Inspect its cancellation status after refreshing." actionLabel="Cancel session" disabled={action.pending || session.cancellation === "requested"} onPress={() => { void action.run(async () => { const result = await cancel({ key: session.key }); refresh(); if (!result.ok) throw new Error(result.message); return result.message; }); }} />}
      </SettingsCard>
    </SettingsSection>
    {!currentServer && <Feedback theme={props.theme} message="This execution belongs to a different It's a Plan server. Restore that configuration before issue actions." />}
    {session.acceptance && <SettingsSection title="Acceptance evidence" info="Unknown checks and incomplete history are not proof that the acceptance contract passed.">
      <SettingsCard>
        {session.acceptance.checks.map((check) => <SettingsRow key={check.id} label={`${check.id} · ${check.status}`} hint={check.message} />)}
        {session.evidence && <SettingsRow label="Observed tool use" hint={`${session.evidence.toolCallCount ?? "Unknown"} calls · history ${session.evidence.historyComplete ? "complete" : "incomplete"}`} />}
      </SettingsCard>
    </SettingsSection>}
    <SettingsSection title="Evidence and actions">
      <SettingsCard>
        {session.plan && <NavigationRow theme={props.theme} label="Execution plan" hint="Saved routing, model and workspace choices" onPress={() => setDetail("plan")} />}
        {issueId !== null && currentServer && <NavigationRow theme={props.theme} label="Task context and development" hint="Captured context and current development links" onPress={() => setDetail("context")} />}
        {issueId !== null && currentServer && <NavigationRow theme={props.theme} label="Review ticket report" hint={session.ticketReportReceipt ? `Delivery ${session.ticketReportReceipt.state}` : "Review original task permission and exact comment before posting"} onPress={() => setDetail("report")} />}
        <SettingsAction label="Compare historical evidence with current upstream and native state" hint={session.review ? `Reviewed ${timestamp(session.review.reviewedAt)}. Acknowledgment does not confirm delivery or complete the issue.` : "Review acknowledgment never confirms delivery or completes the issue."} actionLabel="Compare and review" disabled={action.pending || !currentServer} onPress={() => setReviewing(true)} />
        {issueId !== null && currentServer && <NavigationRow theme={props.theme} label="Submit milestone evidence" hint="Apply the configured column policy only with explicit evidence" disabled={action.pending} onPress={() => setDetail("milestone")} />}
        <NavigationRow theme={props.theme} label="Technical execution details" hint="Provider, heartbeat, recorded identifiers and lease limits" onPress={() => setDetail("technical")} />
      </SettingsCard>
    </SettingsSection>
    {canRerun && <SettingsSection title="Request another run" info={duplicate ? "An outstanding request blocks duplicates. Reconcile its delivery below." : "Review the current execution plan before requesting another run. The server also checks that the source and any previously requested upstream run are terminal."}>
      <SettingsCard>
        <SettingsAction label="Rerun original task" actionLabel="Review rerun" disabled={duplicate || action.pending || (!terminalPhases[session.phase] && session.phase !== "uncertain")} onPress={() => setOperation("rerun")} />
        <SettingsAction label="No-tools smoke check" hint="Instruction-only no-tools request. Does not change issue status." actionLabel="Review smoke check" disabled={duplicate || action.pending || (!terminalPhases[session.phase] && session.phase !== "uncertain")} onPress={() => setOperation("smoke")} />
        {continuationEnabled && <SettingsAction label="Continue the verified original task" hint="Explicit scope review required. Restricted, stale or uncertain sessions cannot be reused." actionLabel="Review continuation" disabled={duplicate || action.pending || session.phase !== "finished" || session.result?.status !== "success"} onPress={() => setOperation("continue")} />}
      </SettingsCard>
    </SettingsSection>}
    <RequestStatus {...props} serverUrl={serverUrl} webUrl={webUrl} requests={sourceRequests} refresh={refresh} title="Requests from this execution" />
    <Feedback theme={props.theme} error={action.error} message={action.message} />
    {detail && detail !== "context" && detail !== "report" && <Modal title={detail === "plan" ? "Execution plan" : detail === "milestone" ? "Observed milestone evidence" : "Technical execution details"} open onOpenChange={(open) => { if (!open && !action.pending) setDetail(null); }}><Modal.Content>
      {detail === "plan" && session.plan && <ExecutionPlanDetails plan={session.plan} />}
      {detail === "technical" && <SettingsSection title="Recorded execution details" info="These are recorded observations, not proof of a current lease or a stopped native agent.">
        <SettingsCard>
          <SettingsRow label="Execution key" hint={session.key} />
          <SettingsRow label="Native agent" hint={session.agentId} />
          <SettingsRow label="Actual execution" hint={`${session.provider} · model ${session.model || "unknown"} · mode ${session.modeId || "unknown"}`} />
          <SettingsRow label="Heartbeat" hint={timestamp(session.lastHeartbeatAt)} />
          <SettingsRow label="Created" hint={timestamp(session.createdAt)} />
          <SettingsRow label="Reviewed at" hint={session.review ? timestamp(session.review.reviewedAt) : "Not reviewed"} />
          <SettingsRow label="Workspace" hint={session.workspaceId || "No workspace override"} />
          <SettingsRow label="Repository directory" hint={session.cwd} />
          {session.branchName && session.plan?.worktree && <SettingsRow label="Requested issue worktree branch" hint={session.branchName} />}
          {session.limits && <SettingsRow label="Recorded execution limits" hint={`Timeout ${session.limits.executionTimeoutMs} ms · lease safety ${session.limits.leaseSafetyMs} ms`} />}
          {session.evidence && <SettingsRow label="Observed tool use" hint={`${session.evidence.toolCallCount ?? "Unknown"} calls · history ${session.evidence.historyComplete ? "complete" : "incomplete"}`} />}
        </SettingsCard>
      </SettingsSection>}
      {detail === "milestone" && issueId !== null && currentServer && <SettingsSection title="Observed milestones" info="Submit explicit evidence under the configured column policy. Issue completion is never inferred from a successful turn.">
        <SettingsCard>
          <SettingsSelect label="Observed milestone" value={selectedMilestone} options={milestoneOptions} onValueChange={(value) => setMilestone(milestoneSchema.parse(value))} disabled={action.pending} />
          <SettingsInput key={evidenceVersion} label="Explicit evidence" hint="Describe what actually happened." initialValue={evidence} onChangeText={setEvidence} disabled={action.pending} />
          <SettingsAction label="Apply configured column policy" actionLabel="Submit evidence" disabled={action.pending || !evidence.trim() || evidence.length > 10000} onPress={() => { void action.run(async () => { const result = await milestone({ key: session.key, milestone: selectedMilestone, evidence: evidence.trim() }); if (!result.ok) throw new Error(result.message); setEvidence(""); setEvidenceVersion((value) => value + 1); refresh(); return result.message; }); }} />
        </SettingsCard>
      </SettingsSection>}
      <Feedback theme={props.theme} error={action.error} message={action.message} />
    </Modal.Content></Modal>}
    {detail === "context" && <SelectedContext {...props} sessionKey={session.key} onClose={() => setDetail(null)} />}
    {detail === "report" && <TicketReportReview {...props} sessionKey={session.key} onClose={() => setDetail(null)} onChange={refresh} />}
    {operation && issueId !== null && <RerunReview {...props} source={{ kind: "run", key: session.key, issueId, operation }} serverUrl={serverUrl} webUrl={webUrl} onClose={() => setOperation(null)} onChange={refresh} />}
    {reviewing && <HistoricalReview {...props} session={session} onClose={() => setReviewing(false)} onChange={refresh} />}
  </>;
}

export function Sessions({ page, sessionKey, onNavigate, ...props }: SessionsProps) {
  const status = useRpc(statusRpc);
  const control = useRpc(controlRpc);
  const action = useAction();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const load = useCallback(() => status({}), [status]);
  const resource = useResource(load, 5000);
  const sessions = [...(resource.data?.sessions || [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const needsAttention = (session: PublicSession) => session.phase === "uncertain" || session.phase === "lease-lost" || session.cancellation === "unconfirmed" || (!terminalPhases[session.phase] && !!session.pendingPermissionCount) || (!session.review && (session.result?.status === "failed" || session.acceptance?.status === "failed"));
  const active = sessions.filter((session) => !terminalPhases[session.phase] && !needsAttention(session));
  const attention = sessions.filter(needsAttention);
  const history = sessions.filter((session) => terminalPhases[session.phase] || session.phase === "uncertain" || session.cancellation === "unconfirmed");
  const runtime = resource.data?.runtime;
  const requests = resource.data?.requests || [];
  const selected = sessions.find((session) => session.key === sessionKey);
  const applyControl = (command: "pause" | "resume" | "stop") => { void action.run(async () => {
    const result = await control({ action: command });
    resource.refresh();
    if (!result.ok) throw new Error(result.message);
    if (command === "stop") setConfirmStop(false);
    return result.message;
  }); };
  const refreshButton = <RefreshButton theme={props.theme} label="Refresh execution status" onPress={resource.refresh} disabled={resource.loading} />;
  const sessionRows = (items: PublicSession[]) => <SettingsCard>{items.map((session) => <NavigationRow key={session.key} theme={props.theme} label={sessionTitle(session)} hint={`${sessionStage(session)}${session.error || session.result?.error ? " · Execution error, inspect details" : session.acceptance?.status === "failed" ? " · Acceptance failed" : ""}`} onPress={() => onNavigate("session", session.key)} />)}</SettingsCard>;
  return <>
    <Feedback theme={props.theme} error={resource.error} />
    {page === "overview" && <>
      <SettingsSection title="Execution status" trailing={refreshButton}>
        <SettingsCard>
          <SettingsRow label={resource.data?.state === "connected" ? "Connected" : resource.data?.state || (resource.loading ? "Loading status" : "Status unavailable")} hint={resource.data?.state === "connected" ? undefined : resource.data?.message} />
          {runtime && <SettingsRow label={runtime.paused ? "Delegation paused" : runtime.claiming ? "Delegation active" : "Delegation inactive"} hint={`${runtime.active} active${runtime.pendingConfiguration ? " · Configuration changes waiting for running work" : ""}`} />}
        </SettingsCard>
      </SettingsSection>
      {!!active.length && <SettingsSection title="Active sessions">{sessionRows(active)}</SettingsSection>}
      {resource.data && !sessions.length && <Feedback theme={props.theme} message="No executions recorded yet." />}
      <SettingsSection title="Activity">
        <SettingsCard>
          {!!attention.length && <NavigationRow theme={props.theme} label="Needs attention" hint={`${attention.length} execution${attention.length === 1 ? "" : "s"}`} onPress={() => onNavigate("attention")} />}
          <NavigationRow theme={props.theme} label="History" hint="Past executions" onPress={() => onNavigate("history")} />
          <NavigationRow theme={props.theme} label="Delegation requests" hint="Delivery and browser handoffs" onPress={() => onNavigate("requests")} />
          <NavigationRow theme={props.theme} label="Runtime controls" hint="Pause, stop and diagnostics" onPress={() => onNavigate("controls")} />
        </SettingsCard>
      </SettingsSection>
    </>}
    {page === "attention" && <SettingsSection title="Needs attention" info="Review unresolved outcomes, execution errors or pending approvals." trailing={refreshButton}>
      {!!attention.length && sessionRows(attention)}
      {!attention.length && <Feedback theme={props.theme} message={resource.data ? "No executions need attention." : resource.loading ? "Loading execution status…" : "Execution status is unavailable."} />}
    </SettingsSection>}
    {page === "history" && <SettingsSection title="Execution history" info="Recorded outcomes may be uncertain. Inspect a session to compare current upstream and native evidence without rewriting history." trailing={refreshButton}>
      {!!history.length && sessionRows(history)}
      {!history.length && <Feedback theme={props.theme} message={resource.data ? "No historical executions recorded." : resource.loading ? "Loading execution history…" : "Execution history is unavailable."} />}
    </SettingsSection>}
    {page === "requests" && <>
      <SettingsSection title="Request delivery" info="Submitting a comment does not prove that a run was queued or completed. Open a request to reconcile its delivery without reposting." trailing={refreshButton}>
        {!requests.length && <Feedback theme={props.theme} message={resource.data ? "No delegation requests recorded." : resource.loading ? "Loading delegation requests…" : "Delegation requests are unavailable."} />}
      </SettingsSection>
      <RequestStatus {...props} requests={requests} refresh={resource.refresh} />
    </>}
    {page === "session" && (selected ? <Session key={selected.key} {...props} session={selected} requests={requests} refresh={resource.refresh} refreshing={resource.loading} /> : <SettingsSection title={resource.data ? "Session not found" : "Session unavailable"} trailing={refreshButton}>
      <Feedback theme={props.theme} message={resource.data ? sessionKey ? "This session is not in the current execution records. Its absence does not prove that the native agent stopped or the issue completed." : "No session key was supplied. Choose a session from the overview or history." : resource.loading ? "Loading session records…" : "Session records could not be loaded. Refresh to try again."} />
      <SettingsCard><NavigationRow theme={props.theme} label="Execution history" hint="Find another recorded session" onPress={() => onNavigate("history")} /></SettingsCard>
    </SettingsSection>)}
    {page === "controls" && <SettingsSection title="Runtime controls" info="Pause persists independently of settings. Running leases and result reports continue while paused. Resume requires automatic execution to be enabled in settings." trailing={refreshButton}>
      <SettingsCard>
        <SettingsRow label={resource.data?.state || (resource.loading ? "Loading status" : "Status unavailable")} hint={resource.data?.message} />
        {runtime && <>
          <SettingsRow label={runtime.paused ? "Claiming paused" : runtime.claiming ? "Claiming enabled" : "Not claiming"} hint={`${runtime.active} active · ${runtime.reservations} reservations · pending configuration ${runtime.pendingConfiguration ? "yes, draining existing work" : "no"} · last poll ${timestamp(runtime.lastPollAt)}`} />
          <SettingsAction label={runtime.claiming ? "Pause claiming" : "Resume claiming"} hint="Does not change saved automatic settings or cancel running sessions." actionLabel={runtime.claiming ? "Pause" : "Resume"} disabled={action.pending} onPress={() => applyControl(runtime.claiming ? "pause" : "resume")} />
          <SettingsAction label="Pause and request stop" hint="Pauses new claims and requests cancellation of running work." actionLabel="Pause and stop…" disabled={action.pending} onPress={() => setConfirmStop(true)} />
        </>}
        <SettingsAction label="Redacted diagnostics" hint="Preview selectable structural diagnostics without credentials, prompts, output, URLs, or local paths. Copy is a separate action." actionLabel="Preview diagnostics" onPress={() => setDiagnosticsOpen(true)} />
      </SettingsCard>
      <Feedback theme={props.theme} error={action.error} message={action.message} />
    </SettingsSection>}
    {page === "controls" && diagnosticsOpen && <DiagnosticsPreview {...props} onClose={() => setDiagnosticsOpen(false)} />}
    {page === "controls" && <Modal title="Pause and request stop" open={confirmStop} onOpenChange={(open) => { if (!action.pending) setConfirmStop(open); }}>
      <Modal.Content>
        <SettingsSection title="Confirm cancellation" info="Pause alone keeps running leases and reports alive. This action also requests cancellation. Stop is confirmed only after native acknowledgement shows idle, no active turn, and no pending permissions. Unconfirmed executions remain visible and must not be treated as stopped.">
          <SettingsCard>
            <SettingsAction label="Keep running work" actionLabel="Back" disabled={action.pending} onPress={() => setConfirmStop(false)} />
            <SettingsAction label="Pause claims and request cancellation" actionLabel={action.pending ? "Requesting…" : "Pause and request stop"} disabled={action.pending} onPress={() => applyControl("stop")} />
          </SettingsCard>
          <Feedback theme={props.theme} error={action.error} message={action.message} />
        </SettingsSection>
      </Modal.Content>
    </Modal>}
  </>;
}
