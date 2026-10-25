import type { Config, Selection } from "../shared/config";
import type { ExecutionPlan, IntegrationRuntime, QueuePreview, Readiness } from "../shared/experience";
import type { Gateway, Secrets } from "./contracts";
import { ConfigurationError } from "./errors";
import { repository } from "./git";
import { executionPreferences, makePlan, resolvePreferences } from "./plan";
import { discoverProjects, resolveProject } from "./projects";
import { Client, RequestError } from "./protocol";
import type { PrivateStorage } from "./storage";

export interface ExperienceContext {
  config: Config;
  protocol: Client;
  gateway: Gateway;
  storage: PrivateStorage;
  runtime: IntegrationRuntime;
  credentials(): Promise<Readonly<Secrets>>;
  assertCurrent(): void;
}

export async function planForIssue(context: ExperienceContext, input: { issueId: number; provider?: string; model?: string; modeId?: string }): Promise<ExecutionPlan> {
  const { config, protocol, gateway } = context;
  const issue = await protocol.issue(input.issueId);
  const projectId = String(issue.projectId);
  const mapping = await resolveProject(config, protocol, gateway, projectId);
  const project = { ...mapping, repository: (await repository(mapping.repository)).root };
  const resolved = await executionPreferences(protocol, config, project, issue, { provider: input.provider, model: input.model, modeId: input.modeId });
  const selection = await gateway.select(config, project, resolved.selection);
  const host = await gateway.host();
  return makePlan(config, project, selection, { projectId, issueId: issue.id, issueIdentifier: issue.identifier, host, sources: resolved.sources });
}

const claimWarning = "Claims are unfiltered across the agent's projects. Disabled or unmapped projects can still be claimed and fail; this preview does not change scheduling.";

export async function queuePreview(context: ExperienceContext): Promise<QueuePreview> {
  const checkedAt = Date.now();
  let agentUsername: string | null = null;
  try {
    const identity = await context.protocol.identity();
    agentUsername = identity.username;
    if (!identity.isAgent) throw new ConfigurationError("Use the external agent execution API key, not a personal key, for queue preview.");
    const queue = await context.protocol.queue();
    const items = queue.items.map((run) => {
      const project = context.config.projects[run.projectId];
      return {
        id: run.id, agentId: run.agentId, username: run.username, projectId: run.projectId, projectName: run.projectName,
        issueId: run.issueId, issueIdentifier: run.issueIdentifier, state: run.executionState, attempts: run.attempts,
        createdAt: run.createdAt, dueAt: run.nextAttemptAt, configured: project !== undefined, automatic: project?.automatic ?? false,
      };
    });
    return {
      availability: "available", complete: queue.complete, checkedAt, unfilteredClaims: true, agentUsername, items,
      queued: items.filter((item) => item.state === "queued").length, running: items.filter((item) => item.state === "running").length,
      warning: `${claimWarning}${queue.complete ? "" : " Only a bounded page is visible. Counts are partial, not queue totals."}`,
    };
  } catch (error) {
    const reason = error instanceof ConfigurationError ? error.message
      : error instanceof RequestError && error.status === 403 ? "Queue access is denied. Review the external agent's queue permissions."
      : error instanceof RequestError && error.status === 401 ? "Queue authentication failed. Review the external agent execution API key."
      : "Queue preview is unavailable. No conclusion about an empty queue can be drawn.";
    return { availability: "unavailable", complete: false, checkedAt, unfilteredClaims: true, agentUsername, items: [], queued: 0, running: 0, warning: `${reason} ${claimWarning}` };
  }
}

export async function readiness(context: ExperienceContext): Promise<Readiness> {
  const checks: Readiness["checks"] = [];
  const projects: Readiness["projects"] = [];
  const add = (check: Readiness["checks"][number]) => checks.push(check);
  let agentReady = false;
  try {
    const identity = await context.protocol.identity();
    add({ id: "identity", label: "Execution credential", state: identity.isAgent ? "pass" : "fail", message: identity.isAgent ? "The execution key belongs to an agent." : "This is a personal key. Save the external agent execution key here; personal keys belong only in the optional request credential setting.", action: { kind: "credentials" } });
    if (identity.isAgent) {
      try {
        const agent = await context.protocol.agent();
        agentReady = agent !== null && agent.kind === "external" && !agent.invocationUrl;
        add({ id: "invocation", label: "Agent invocation", state: agent === null ? "unknown" : agentReady ? "pass" : "fail", message: agent === null ? "Agent settings are not visible. Polling compatibility is not proven; review the agent in It's a Plan." : agent.kind !== "external" ? "Select an external agent. Internal agents do not use this polling integration." : agent.invocationUrl ? "This agent has a push invocation URL. Remove it in the agent settings before using polling." : "The external agent uses polling without a push invocation URL.", action: { kind: "agent", ...(agent ? { agentId: String(agent.id), externalPath: agent.settingsPath } : {}) } });
      } catch {
        add({ id: "invocation", label: "Agent invocation", state: "unknown", message: "Agent settings are unavailable. Polling compatibility is not proven; review agent visibility and permissions.", action: { kind: "agent" } });
      }
    }
  } catch (error) {
    const connection = error instanceof RequestError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500) || error instanceof Error && error.name === "TimeoutError";
    add({ id: "identity", label: connection ? "API connection" : "Execution credential", state: "fail", message: connection ? "The API could not be reached or returned an invalid response. Check the saved API server URL and connectivity; the credential has not been verified." : "The server rejected the execution credential. Save the external agent's execution API key, not a personal or MCP key.", action: { kind: connection ? "connection" : "credentials" } });
  }
  try {
    await context.gateway.host();
    add({ id: "host", label: "Paseo host", state: "pass", message: "The configured native Paseo host is available.", action: { kind: "host" } });
  } catch {
    add({ id: "host", label: "Paseo host", state: "fail", message: "The native Paseo host is unavailable. Check the host connection.", action: { kind: "host" } });
  }
  try {
    const visible = await discoverProjects(context.protocol, context.gateway);
    for (const item of visible) {
      const projectId = String(item.id);
      const configured = context.config.projects[projectId];
      const problems: string[] = [];
      let path: string | null = null;
      let selection: Selection | null = null;
      if (!configured) problems.push("Configure this project's repository and execution preferences before enabling it.");
      if (!configured?.automatic) problems.push("Automatic execution is disabled for this project. Unfiltered claims can still reach it.");
      try {
        const mapping = await resolveProject(context.config, context.protocol, context.gateway, projectId);
        const project = { ...mapping, repository: (await repository(mapping.repository)).root };
        path = project.repository;
        selection = await context.gateway.select(context.config, project);
      } catch (error) {
        problems.push(error instanceof ConfigurationError ? error.message : "Repository or provider/model/mode validation is unavailable. Check the repository mapping and execution preferences.");
      }
      const preferences = configured ? resolvePreferences(context.config, configured).selection : null;
      projects.push({ projectId, key: item.key, name: item.name, automatic: configured?.automatic ?? false, ready: !!configured?.automatic && selection !== null && path !== null, repository: path, provider: selection?.provider ?? preferences?.provider ?? null, model: selection?.model ?? preferences?.model ?? null, modeId: selection?.modeId ?? preferences?.modeId ?? null, problems });
    }
    for (const projectId of Object.keys(context.config.projects)) {
      if (visible.some((item) => String(item.id) === projectId)) continue;
      projects.push({ projectId, key: projectId, name: projectId, automatic: context.config.projects[projectId]!.automatic, ready: false, repository: null, provider: null, model: null, modeId: null, problems: ["This configured project is not visible. Review project membership and agent permissions."] });
    }
    add({ id: "projects", label: "Project routing", state: projects.some((project) => project.ready) ? projects.some((project) => !project.ready) ? "warning" : "pass" : "fail", message: projects.some((project) => project.ready) ? "Review each project's readiness. Claims are not filtered to enabled or mapped projects." : "No visible project is enabled with a valid repository and execution selection.", action: { kind: "projects" } });
  } catch {
    add({ id: "projects", label: "Project routing", state: "fail", message: "Projects are unavailable. Review the agent's project membership and read permissions.", action: { kind: "projects" } });
  }
  const blocked = context.runtime.pendingConfiguration || context.config.automatic && !context.runtime.paused && !context.runtime.claiming;
  add({ id: "automatic", label: "Automatic execution", state: blocked ? "fail" : context.config.automatic && !context.runtime.paused ? "pass" : "warning", message: context.runtime.pendingConfiguration ? "A connection change is waiting for existing work and result delivery. Inspect executions before sending new work." : blocked ? "New claims are blocked. Inspect runtime failures and unconfirmed native cancellations before resuming." : !context.config.automatic ? "Automatic execution is disabled in settings. Readiness does not enable it." : context.runtime.paused ? "Claiming is paused. Existing work can continue; resume explicitly when ready." : "Automatic execution is enabled. Readiness itself never claims work.", action: { kind: "execution" } });
  const queue = await queuePreview(context);
  add({ id: "queue", label: "Queue visibility", state: queue.availability === "unavailable" ? "unknown" : queue.complete ? "pass" : "warning", message: queue.availability === "unavailable" ? "Queue preview is unavailable, not empty. Review queue read permissions." : queue.complete ? "Queue metadata is available. Claims remain unfiltered." : "Queue metadata is partial. Visible counts are not queue totals.", action: { kind: "agent" } });
  return { checkedAt: Date.now(), ready: agentReady && checks.every((check) => check.state !== "fail" && check.state !== "unknown"), checks, projects, queue };
}

