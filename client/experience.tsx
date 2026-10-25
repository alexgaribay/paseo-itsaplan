import { useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { ExecutionPlan, QueuePreview, Readiness } from "../shared/experience";
import { queueRpc, readinessRpc } from "../shared/rpc";
import { Feedback, useAction, Warning } from "./common";
import { BackLink, NavigationRow } from "./navigation";

export type ReadinessAction = NonNullable<Readiness["checks"][number]["action"]>;

export function ExecutionPlanDetails({ plan }: { plan: ExecutionPlan }) {
  return <SettingsSection title="Execution plan" info={`This is the resolved saved configuration, not proof that a session has started. Unpinned provider defaults are resolved at native session creation. No-tools is instruction-only, not a tool sandbox.${plan.defaultModelUnresolved ? " The default model is unpinned and unresolved." : ""}${plan.warnings.length ? ` ${plan.warnings.join(" ")}` : ""}`}>
    <SettingsCard>
      <SettingsRow label="Provider" hint={`${plan.selection.provider || "Unresolved"} · ${plan.sources.provider}`} />
      <SettingsRow label="Model" hint={`${plan.selection.model || "Provider default, unresolved"} · ${plan.sources.model}`} />
      <SettingsRow label="Mode" hint={`${plan.selection.modeId || "Provider default, unresolved"} · ${plan.sources.mode}`} />
      <SettingsRow label="Host" hint={plan.hostLabel ? `${plan.hostLabel}${plan.hostId ? ` (${plan.hostId})` : ""}` : plan.hostId || "Unknown"} />
      <SettingsRow label="Repository" hint={plan.repository || "Unresolved"} />
      <SettingsRow label="Workspace" hint={plan.workspaceId || "No workspace override"} />
      <SettingsRow label="Worktree" hint={plan.worktree ? `Isolated · Base ${plan.baseBranch || "repository default"}` : "Existing checkout"} />
    </SettingsCard>
  </SettingsSection>;
}

function QueueDetails({ queue, theme }: { queue: QueuePreview } & Pick<PluginSurfaceProps, "theme">) {
  return <SettingsSection title="Upstream queue" info="Claims are global and unfiltered. Disabling or leaving a project unmapped does not prevent its work from being claimed and failing. This read-only preview does not claim work.">
    <SettingsCard>
      <SettingsRow label={queue.availability === "unavailable" ? "Queue unavailable" : queue.complete ? "Complete queue snapshot" : "Partial queue snapshot"} hint={`Checked ${new Date(queue.checkedAt).toLocaleString()} · ${queue.agentUsername ? `@${queue.agentUsername}` : "Agent identity unknown"}`} />
      {queue.availability === "available" && <SettingsRow label={`${queue.queued} queued · ${queue.running} running`} hint={queue.complete ? "Counts reflect this snapshot, not a reservation." : "Only the returned page is counted. More work may exist."} />}
      {queue.items.map((item) => <SettingsRow key={item.id} label={`${item.issueIdentifier || `Run ${item.id}`} · ${item.projectName}`} hint={`${item.state} · attempt ${item.attempts} · due ${item.dueAt}${!item.configured ? " · UNMAPPED" : !item.automatic ? " · AUTOMATIC DISABLED" : ""}`} />)}
    </SettingsCard>
    <Warning message={queue.warning} />
    <Feedback theme={theme} message={queue.availability === "unavailable" ? "An unavailable queue is not an empty queue or proof of readiness." : !queue.complete ? "Partial results cannot establish that no blocked projects are waiting." : !queue.items.length ? "No work returned in this snapshot." : undefined} />
  </SettingsSection>;
}

export function ReadinessPanel({ onNavigate, onResult, onTestDelegation, draftDirty = false, ...props }: PluginSurfaceProps & { onNavigate(action: ReadinessAction): void; onResult?(value: Readiness): void; onTestDelegation?(): void; draftDirty?: boolean }) {
  const check = useRpc(readinessRpc);
  const getQueue = useRpc(queueRpc);
  const action = useAction();
  const [result, setResult] = useState<Readiness>();
  const [queue, setQueue] = useState<QueuePreview>();
  const [detail, setDetail] = useState<"readiness" | "queue" | null>(null);
  const warnings = result?.checks.some((check) => check.state === "warning");
  const run = () => { void action.run(async () => { const next = await check({}); setResult(next); setQueue(next.queue); onResult?.(next); setDetail("readiness"); }); };
  return <>
    {!detail && <SettingsSection title="Setup checks" info={`Checks saved settings without claiming work or creating agents.${draftDirty ? " Unsaved drafts are not checked." : ""}`}>
      <SettingsCard>
        <SettingsAction label={result ? result.ready ? warnings ? "Ready with warnings" : "Last check passed" : "Setup needs attention" : "Readiness"} hint={result ? `Checked ${new Date(result.checkedAt).toLocaleString()}. A snapshot is not a scheduling guarantee.` : "Check the connection and every visible project."} actionLabel={action.pending ? "Checking…" : "Check readiness"} disabled={action.pending} onPress={run} />
        {result && <NavigationRow theme={props.theme} label="Checklist" onPress={() => setDetail("readiness")} />}
        <SettingsAction label="Queue preview" hint="Global claims are unfiltered. Disabled and unmapped projects can still be claimed and fail. This preview does not claim work." actionLabel="Preview queue" disabled={action.pending} onPress={() => { void action.run(async () => { setQueue(await getQueue({})); setDetail("queue"); }); }} />
        {onTestDelegation && <SettingsAction label="Test delegation" hint={draftDirty ? "Save or discard settings changes before testing. Only saved settings are used." : "Review the saved plan before an explicit upstream smoke request. No prior session is needed."} actionLabel="Set up test" disabled={action.pending || draftDirty} onPress={onTestDelegation} />}
      </SettingsCard>
      <Feedback theme={props.theme} error={action.error} />
    </SettingsSection>}
    {detail && <>
      <BackLink theme={props.theme} label="Setup checks" onPress={() => setDetail(null)} />
      {detail === "readiness" && result && <>
        <SettingsSection title={result.ready ? warnings ? "Ready with warnings" : "Checks passed" : "Action required"} info="Saved settings only. Readiness does not enable delegation, start sessions or filter global claims.">
          <SettingsCard>{result.checks.map((item) => item.action ? <NavigationRow key={item.id} theme={props.theme} label={`${item.state.toUpperCase()} · ${item.label}`} hint={item.message} onPress={() => { setDetail(null); onNavigate(item.action!); }} /> : <SettingsRow key={item.id} label={`${item.state.toUpperCase()} · ${item.label}`} hint={item.message} />)}</SettingsCard>
        </SettingsSection>
        <SettingsSection title="Projects" info="Saved configuration. Automatic disabled does not protect a project from global claims.">
          <SettingsCard>{result.projects.map((project) => <NavigationRow key={project.projectId} theme={props.theme} label={`${project.name} (${project.key})`} hint={`${project.ready ? "Ready" : "Needs attention"} · ${project.automatic ? "Automatic enabled" : "Automatic disabled"}${project.problems.length ? ` · ${project.problems.join("; ")}` : ""}`} onPress={() => { setDetail(null); onNavigate({ kind: "project", projectId: project.projectId }); }} />)}</SettingsCard>
        </SettingsSection>
      </>}
      {queue && <QueueDetails queue={queue} theme={props.theme} />}
      <SettingsCard><SettingsAction label="Saved setup" actionLabel="Check again" disabled={action.pending} onPress={run} /></SettingsCard>
      <Feedback theme={props.theme} error={action.error} />
    </>}
  </>;
}
