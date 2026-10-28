import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config, ProjectMapping } from "../shared/config";
import type { TaskIntent } from "../shared/experience";
import type { Issue, SessionRecord, Task } from "../shared/models";
import { workflowOptionsSchema, type WorkflowColumn, type WorkflowState } from "../shared/workflow";
import type { Gateway, Protocol } from "./contracts";
import { ConfigurationError } from "./errors";
import { RequestError } from "./protocol";
import { captureWorkflowRepository, finalizeGitWorkflow } from "./git-workflow";
import { knownTaskRestrictions } from "./task";
import { matchesProfileSelection } from "./plan";

const outcomeSchema = z.object({ version: z.literal(1), outcome: z.enum(["completed", "blocked", "partial", "failed"]) }).strict();

export const automaticWorkflowInstructions = `## Automatic delegated-task lifecycle
The plugin moves the issue to In Progress when your task session starts. Implement the entire original task in this assigned worktree and run its required verification through your normal tools and permissions. Do not merge, push, change issue status, or post a duplicate completion report: the plugin owns those operations. Preserve unrelated work and repository settings. The plugin will commit remaining task changes, independently execute configured or discovered checks, validate the integrated tree, and publish the target branch before marking Done. Your final answer alone is not proof of completion.
Keep the structured implementation report. End it with exactly one machine-readable outcome:
\`\`\`paseo-workflow
{"version":1,"outcome":"completed"}
\`\`\`
Use completed only if every original requirement is satisfied and required validation actually passed. Otherwise use outcome blocked, partial, or failed, and explain the missing requirement or approval in the report. Do not claim completed because a coding turn ended. Explicit original task restrictions still take precedence.`;

function destination(columns: WorkflowColumn[], stateType: "started" | "completed", override?: number): number {
  const candidates = columns.filter((column) => column.stateType === stateType).sort((a, b) => a.position - b.position || a.id - b.id);
  if (override !== undefined) {
    if (!candidates.some((column) => column.id === override)) throw new ConfigurationError(`The configured ${stateType === "started" ? "In Progress" : "Done"} column is missing or has the wrong state type.`);
    return override;
  }
  const conventional = candidates.filter((column) => column.name.replace(/[\s_-]/g, "").toLowerCase() === (stateType === "started" ? "inprogress" : "done"));
  if (conventional.length === 1) return conventional[0]!.id;
  if (candidates.length === 1) return candidates[0]!.id;
  throw new ConfigurationError(`Choose an explicit ${stateType === "started" ? "In Progress" : "Done"} column for this project's automatic lifecycle; its workflow states are ${candidates.length ? "ambiguous" : "missing"}.`);
}

export async function prepareAutomaticWorkflow(input: {
  task: Task; intent?: TaskIntent; issue?: Issue; project: ProjectMapping; config: Config; protocol: Protocol; signal: AbortSignal;
}): Promise<WorkflowState | undefined> {
  const { task, intent, issue, project, config, protocol, signal } = input;
  const options = workflowOptionsSchema.parse(project.workflow ?? config.workflow);
  if (options.mode !== "automatic" || task.kind !== "run" || task.run.trigger !== "delegation" || !intent || intent.source !== "issue" || intent.requestId || !issue) return undefined;
  const restrictions = knownTaskRestrictions({ request: intent.request, systemPrompt: task.run.systemPrompt, requirements: issue.description ?? "", source: intent.source, acceptance: intent.acceptance });
  const scope = `${intent.request}\n${task.run.systemPrompt}\n${issue.description ?? ""}`;
  const gitRestricted = /\b(?:do not|don't|never|must not)\s+(?:commit|push|merge)\b|\bno[- ](?:commits?|push(?:es)?|merg(?:e|es|ing))\b/i.test(scope);
  const statusRestricted = /\bkeep\s+(?:the\s+)?(?:(?:issue|ticket)\s+)?(?:status|state)\s+unchanged\b|\b(?:do not|don't|never|must not)\s+(?:change|update|modify|move|close|complete|resolve|mark|set)\s+(?:the\s+)?(?:(?:issue|ticket)\s+)?(?:status|state|issue|ticket)\b/i.test(scope);
  if (restrictions.length || gitRestricted || statusRestricted) return undefined;
  if (!project.worktree) throw new ConfigurationError("Automatic completion requires an isolated task worktree. Enable worktree isolation or choose the review lifecycle.");
  const actor = await protocol.identity(signal);
  if (!actor.isAgent || issue.delegateUserId !== actor.id) throw new ConfigurationError("The issue is no longer delegated to this external agent; automatic lifecycle was not started.");
  const columns = await protocol.columns(issue.projectId, signal);
  if (columns.some((column) => column.projectId !== issue.projectId)) throw new ConfigurationError("Issue workflow columns belong to a different project.");
  const current = columns.find((column) => column.id === issue.columnId);
  if (current && ["completed", "canceled"].includes(current.stateType)) throw new ConfigurationError("The delegated issue is already closed. Reopen it before starting new automatic implementation work.");
  const captured = await captureWorkflowRepository({ repository: project.repository, options, signal });
  return { ...captured, version: 1, options, actorId: actor.id, stage: "starting", inProgressColumnId: destination(columns, "started", options.inProgressColumnId), doneColumnId: destination(columns, "completed", options.doneColumnId), checks: [], notices: [] };
}

export async function assertWorkflowAuthority(record: SessionRecord, protocol: Protocol, gateway: Gateway, signal: AbortSignal, requireIdleSession = true): Promise<void> {
  signal.throwIfAborted();
  if (!record.workflow?.actorId || !record.taskIssue || record.task?.kind !== "run" || !record.issueId) throw new ConfigurationError("The automatic lifecycle's captured issue and execution authority are unavailable.");
  const [actor, run, issue, native] = await Promise.all([protocol.identity(signal), protocol.getRun(record.externalId, signal), protocol.issue(record.issueId, signal), requireIdleSession ? gateway.inspect(record.agentId, { includeHistory: false }) : Promise.resolve(null)]);
  signal.throwIfAborted();
  if (!actor.isAgent || actor.id !== record.workflow.actorId || issue.delegateUserId !== actor.id) throw new ConfigurationError("The issue's delegated agent changed; automatic integration stopped.");
  if (!run || run.id !== record.externalId || run.issueId !== record.issueId || run.projectId !== record.projectId || run.attempts !== record.attempt || run.status !== "pending" || run.executionState !== "running") throw new ConfigurationError("The automatic lifecycle no longer owns the current execution attempt; integration stopped.");
  if (issue.projectId !== record.taskIssue.projectId || issue.title !== record.taskIssue.title || (issue.description ?? "") !== (record.taskIssue.description ?? "")) throw new ConfigurationError("The issue requirements changed during execution; review the preserved work before integration.");
  if (!requireIdleSession) return;
  if (record.workflow.stage === "starting" && issue.columnId !== record.taskIssue.columnId && issue.columnId !== record.workflow.inProgressColumnId) throw new ConfigurationError("The issue state changed before startup; automatic execution stopped.");
  if (!["starting", "completed"].includes(record.workflow.stage) && issue.columnId !== record.workflow.inProgressColumnId && !(record.workflow.publishedAt !== undefined && issue.columnId === record.workflow.doneColumnId)) throw new ConfigurationError("The issue was moved out of this execution's In Progress state; automatic integration stopped.");
  if (!native || native.archived || native.active || native.pendingPermissionCount || native.id !== record.agentId || native.cwd !== record.cwd || native.workspaceId !== record.workspaceId || native.provider !== record.provider || native.model !== record.model || native.modeId !== record.modeId || (native.lastUserMessageAt ?? null) !== (record.nativeLastUserMessageAt ?? null) || (record.plan && !matchesProfileSelection(native, record.plan.selection))) throw new ConfigurationError("The task session is busy, changed, or has a newer user turn; automatic integration stopped.");
}

export interface WorkflowContext {
  record(): SessionRecord;
  protocol: Protocol;
  signal: AbortSignal;
  persist(patch: Partial<SessionRecord>): Promise<void>;
  assertAuthorized(requireIdleSession?: boolean): Promise<void>;
}

export async function startAutomaticWorkflow(context: WorkflowContext): Promise<void> {
  const { protocol, signal, persist, assertAuthorized } = context;
  const record = context.record();
  if (!record.workflow) return;
  await assertAuthorized();
  if (record.workflow.stage !== "starting") return;
  if (!record.projectMapping || !record.branchName) throw new ConfigurationError("The task repository or issue branch was not captured.");
  const captured = await captureWorkflowRepository({ repository: record.projectMapping.repository, cwd: record.cwd, branchName: record.branchName, options: record.workflow.options, signal });
  if (captured.remoteIdentity !== record.workflow.remoteIdentity) throw new ConfigurationError("The repository remote changed during startup; automatic integration was not authorized for the new target.");
  await persist({ workflow: { ...record.workflow, ownership: captured.ownership } });
  await protocol.setColumn(record.issueId!, record.workflow.inProgressColumnId, signal);
  await persist({ workflow: { ...context.record().workflow!, stage: "running" } });
}

async function notice(context: WorkflowContext, kind: "completed" | "blocked", message: string): Promise<void> {
  const { protocol, signal, persist } = context;
  let record = context.record();
  if (!record.workflow || !record.issueId) return;
  const marker = `<!-- paseo-workflow:${createHash("sha256").update(record.workflow.operationKey ?? record.key).digest("hex")}:${kind} -->`;
  const existing = record.workflow.notices.find((item) => item.kind === kind);
  if (existing?.state === "delivered") return;
  const body = existing?.body ?? `${message}\n\n${marker}`;
  const allowCreate = !existing;
  if (!existing) {
    await persist({ workflow: { ...record.workflow, notices: [...record.workflow.notices, { kind, body, state: "submitting" }] } });
    record = context.record();
  }
  try {
    const receipt = await protocol.workflowComment(record.issueId!, marker, body, allowCreate, signal);
    if (!receipt) throw new ConfigurationError("The lifecycle report's acknowledgment is unknown. Inspect the issue before retrying; the report was not blindly posted again.");
    const workflow = context.record().workflow!;
    await persist({ workflow: { ...workflow, notices: workflow.notices.map((item) => item.kind === kind ? { ...item, state: "delivered", commentId: receipt.id } : item) } });
  } catch (error) {
    const workflow = context.record().workflow!;
    await persist({ workflow: { ...workflow, notices: workflow.notices.map((item) => item.kind === kind ? { ...item, state: "unknown" } : item) } });
    throw error;
  }
}

export async function completeAutomaticWorkflow(context: WorkflowContext): Promise<void> {
  const { persist, protocol, signal, assertAuthorized } = context;
  let record = context.record();
  if (!record.workflow || record.workflow.stage === "completed") return;
  if (record.result?.status !== "success") throw new ConfigurationError("The coding task did not succeed; no automatic integration was attempted.");
  const match = /```paseo-workflow\s*\n([^`]+)\n```\s*$/.exec(record.result.output ?? "");
  let outcome: z.infer<typeof outcomeSchema> | undefined;
  try { outcome = match ? outcomeSchema.parse(JSON.parse(match[1]!)) : undefined; } catch { /* An invalid attestation never authorizes integration. */ }
  if (outcome?.outcome !== "completed") throw new ConfigurationError("The agent did not report all original requirements and validation completed. Inspect its report; changes were not merged and the issue was not marked Done.");
  if (!record.projectMapping || !record.branchName || !record.issueIdentifier) throw new ConfigurationError("The captured task repository or branch is unavailable for automatic integration.");
  await assertAuthorized();
  await finalizeGitWorkflow({
    key: record.workflow.operationKey ?? record.key, repository: record.projectMapping.repository, cwd: record.cwd, branchName: record.branchName,
    issueIdentifier: record.issueIdentifier, workflow: record.workflow, signal, assertAuthorized,
    checkpoint: async (workflow) => { await persist({ workflow }); },
  });
  record = context.record();
  if (!record.workflow?.integratedCommit || record.workflow.stage !== "published" || !record.workflow.checks.length) throw new ConfigurationError("The merged commit, validation, and remote publication could not all be verified. The issue remains unfinished.");
  await assertAuthorized();
  await notice(context, "completed", `Implementation integrated for ${record.issueIdentifier}.\n\nCommit: ${record.workflow.integratedCommit}\nTarget: ${record.workflow.options.remote}/${record.workflow.options.targetBranch}\nValidation: ${record.workflow.checks.length} successful command receipts, including the integrated tree.\nThe commit was verified on the remote target branch.`);
  await assertAuthorized();
  const current = await protocol.issue(record.issueId!, signal);
  if (current.columnId !== record.workflow.doneColumnId) {
    await persist({ workflow: { ...context.record().workflow!, stage: "completing" } });
    try {
      await protocol.setColumn(record.issueId!, record.workflow.doneColumnId, signal);
    } catch (error) {
      if (error instanceof RequestError && error.status >= 400 && error.status < 500) {
        await persist({ workflow: { ...context.record().workflow!, stage: "published" } });
        throw error;
      }
      const message = "The Done transition acknowledgment is unknown; the issue may already be Done. Inspect its current state before scheduling another attempt.";
      await persist({ workflow: { ...context.record().workflow!, stage: "uncertain", error: message } });
      let observed: Issue | undefined;
      try { observed = await protocol.issue(record.issueId!, signal); } catch {}
      if (observed?.columnId !== record.workflow.doneColumnId) throw new ConfigurationError(message);
      await assertAuthorized();
    }
  }
  await persist({ workflow: { ...context.record().workflow!, stage: "completed", error: undefined } });
}

export async function blockAutomaticWorkflow(context: WorkflowContext, error: string): Promise<void> {
  const workflow = context.record().workflow;
  if (!workflow || workflow.stage === "completed") return;
  const uncertain = workflow.stage === "uncertain" || workflow.stage === "completing";
  await context.persist({ workflow: { ...workflow, stage: uncertain ? "uncertain" : "blocked", error } });
  await context.assertAuthorized(false);
  await notice(context, "blocked", uncertain
    ? `Issue completion needs reconciliation.\n\n${error}\n\nGit publication is recorded, but the final issue status is unconfirmed. No status write will be blindly repeated.`
    : `Automatic completion blocked.\n\n${error}\n\nThis run did not confirm issue completion. Task work and any recorded commits have been preserved.`);
}
