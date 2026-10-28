import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { preferences } from "./shared/config";
import { attachRpc, cancelRpc, continuationPreviewRpc, controlRpc, credentialsRpc, customFieldsRpc, detailRpc, diagnosticsRpc, hostRpc, markReviewedRpc, milestoneRpc, planRpc, profilesRpc, projectsRpc, providersRpc, queueRpc, readinessRpc, recoverHandoffRpc, rerunDiscardRpc, rerunPreviewRpc, rerunReconcileRpc, rerunSubmitRpc, reviewRpc, searchRpc, smokePreviewRpc, startRpc, statusRpc, taskContextRpc, testConnectionRpc, testHostRpc, ticketReportPreviewRpc, ticketReportReconcileRpc, ticketReportSubmitRpc } from "./shared/rpc";
import { dataDirectory } from "./server/storage";
import { publicSession } from "./server/service";
import { BotRegistry } from "./server/bots";
import { safeError } from "./server/engine";
import { ConfigurationError } from "./server/errors";
import { describeHost } from "./server/host";
import { discoverProjects } from "./server/projects";
import { planForIssue, queuePreview, readiness, type ExperienceContext } from "./server/experience";
import { discardRerun, prepareContinuation, prepareRerun, prepareSmoke, reconcileRerun, recoverHandoff, submitRerun } from "./server/rerun";
import { diagnostics } from "./server/diagnostics";
import { markExecutionReviewed, reviewExecution } from "./server/review";
import { prepareTicketReport, reconcileTicketReport, submitTicketReport } from "./server/ticket-report";
import { selectedExecutionContext } from "./server/selected-context";

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(safeError(error)); }
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const bots = new BotRegistry(dataDirectory(), settings);
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status === "ready") return bots.configure(state.values);
  });
  const unsubscribeTurns = server.on("agent.turn_ended", (event) => guarded(() => bots.turnEnded(event.agent.id, event.outcome)));
  void bots.initialize().catch(() => {});
  const experience = async (paseo: PaseoApi, botId?: string): Promise<ExperienceContext> => (await bots.service(botId)).experience(paseo);

  server.handle(statusRpc, ({ botId }, { paseo }) => guarded(async () => {
    const service = await bots.service(botId);
    return service.status(service.config ? service.gatewayFor(paseo) : undefined);
  }));
  server.handle(credentialsRpc, ({ botId, ...patch }) => guarded(async () => {
    await bots.credentials(botId, patch);
    return { ok: true, message: "Credentials stored privately; existing plaintext is never returned" };
  }));
  server.handle(testConnectionRpc, ({ botId }) => guarded(async () => {
    await (await (await bots.service(botId)).protocol()).test();
    return { ok: true, message: "External-agent authentication succeeded without claiming work" };
  }));
  server.handle(hostRpc, async ({ botId }, { paseo }) => {
    try {
      await bots.service(botId);
      const state = await settings.read();
      if (state.status !== "ready") throw new ConfigurationError("Repair the saved plugin settings first");
      const host = await describeHost({ ...state.values, paseoConnectionMode: "auto" });
      const directory = await paseo.hosts.list();
      if (!host.serverId || host.serverId !== directory.self.serverId) throw new ConfigurationError("Paseo runtime metadata does not identify this plugin's owning host");
      return { status: "detected" as const, endpoint: host.endpoint, serverId: host.serverId };
    } catch (error) { return { status: "unavailable" as const, message: safeError(error) }; }
  });
  server.handle(testHostRpc, ({ botId }) => guarded(async () => {
    await (await bots.service(botId)).checkHost();
    return { ok: true, message: "Connected to the owning Paseo daemon without claiming work" };
  }));
  server.handle(providersRpc, ({ botId, cwd }, { paseo }) => guarded(async () => (await bots.service(botId)).gatewayFor(paseo).catalog(cwd)));
  server.handle(profilesRpc, ({ botId }, { paseo }) => guarded(async () => {
    await bots.service(botId);
    const { config } = await paseo.config.get();
    return (config.agentProfiles ?? []).map(({ id, name, provider, model, modeId, thinkingOptionId, featureValues }) => ({
      id, name, provider,
      ...(model !== undefined ? { model } : {}),
      ...(modeId !== undefined ? { modeId } : {}),
      ...(thinkingOptionId !== undefined ? { thinkingOptionId } : {}),
      ...(featureValues !== undefined ? { featureValues } : {}),
    }));
  }));
  server.handle(projectsRpc, ({ botId }, { paseo }) => guarded(async () => {
    const service = await bots.service(botId);
    return discoverProjects(await service.protocol(), service.gatewayFor(paseo), AbortSignal.timeout(30_000));
  }));
  server.handle(customFieldsRpc, ({ botId, projectId, issueTypeId }) => guarded(async () => (await (await bots.service(botId)).protocol()).customFields(projectId, issueTypeId)));
  server.handle(taskContextRpc, ({ botId, key }, { paseo }) => guarded(async () => selectedExecutionContext(await experience(paseo, botId), key)));
  server.handle(searchRpc, ({ botId, projectId, query }) => guarded(async () => (await (await bots.service(botId)).protocol()).search(projectId, query)));
  server.handle(detailRpc, ({ botId, issueId }) => guarded(async () => (await (await bots.service(botId)).protocol()).issue(issueId)));
  server.handle(startRpc, ({ botId, issueId, provider, model, modeId }, { paseo }) => guarded(async () => {
    const { engine, gateway, protocol } = await (await bots.service(botId)).interactive(paseo);
    const issue = await protocol.issue(issueId);
    return publicSession(await engine.manual(issue, gateway, { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(modeId ? { modeId } : {}) }));
  }));
  server.handle(attachRpc, ({ botId, issueId, agentId }, { paseo }) => guarded(async () => {
    const { engine, gateway, protocol } = await (await bots.service(botId)).interactive(paseo);
    return publicSession(await engine.attach(await protocol.issue(issueId), agentId, gateway));
  }));
  server.handle(cancelRpc, ({ botId, key }, { paseo }) => guarded(async () => {
    await (await bots.service(botId)).cancel(key, paseo);
    return { ok: true, message: "Native cancellation confirmed; conversation and worktree preserved. Execution result delivery is tracked separately." };
  }));
  server.handle(milestoneRpc, ({ botId, key, milestone, evidence }, { paseo }) => guarded(async () => {
    const { engine } = await (await bots.service(botId)).interactive(paseo);
    await engine.milestone(key, milestone, evidence);
    return { ok: true, message: "Evidence posted and configured issue column applied" };
  }));
  server.handle(readinessRpc, ({ botId }, { paseo }) => guarded(async () => {
    const service = await bots.service(botId);
    const config = service.configuration();
    const secrets = await service.storage.secrets();
    if (!config.serverUrl || !secrets.apiKey) {
      const checkedAt = Date.now();
      return {
        checkedAt, ready: false, projects: [],
        checks: [{ id: "configuration", label: "Saved connection", state: "fail" as const, message: !config.serverUrl ? "Save the It's a Plan API server URL before checking readiness." : "Save the external agent's execution API key before checking readiness.", action: { kind: !config.serverUrl ? "connection" as const : "credentials" as const } }],
        queue: { availability: "unavailable" as const, complete: false, checkedAt, unfilteredClaims: true as const, agentUsername: null, items: [], queued: 0, running: 0, warning: "The connection is not configured. The upstream queue has not been read; it is not known to be empty." },
      };
    }
    return readiness(await experience(paseo, botId));
  }));
  server.handle(planRpc, ({ botId, ...input }, { paseo }) => guarded(async () => planForIssue(await experience(paseo, botId), input)));
  server.handle(queueRpc, ({ botId }, { paseo }) => guarded(async () => queuePreview(await experience(paseo, botId))));
  server.handle(controlRpc, ({ botId, action }) => guarded(async () => (await bots.service(botId)).control(action)));
  server.handle(rerunPreviewRpc, ({ botId, ...input }, { paseo }) => guarded(async () => prepareRerun(await experience(paseo, botId), input)));
  server.handle(rerunSubmitRpc, ({ botId, ...input }, { paseo }) => guarded(async () => submitRerun(await experience(paseo, botId), input)));
  server.handle(rerunReconcileRpc, ({ botId, ...input }, { paseo }) => guarded(async () => reconcileRerun(await experience(paseo, botId), input)));
  server.handle(rerunDiscardRpc, ({ botId, ...input }, { paseo }) => guarded(async () => discardRerun(await experience(paseo, botId), input)));
  server.handle(smokePreviewRpc, ({ botId, ...input }, { paseo }) => guarded(async () => prepareSmoke(await experience(paseo, botId), input)));
  server.handle(continuationPreviewRpc, ({ botId, ...input }, { paseo }) => guarded(async () => prepareContinuation(await experience(paseo, botId), input)));
  server.handle(ticketReportPreviewRpc, ({ botId, ...input }, { paseo }) => guarded(async () => prepareTicketReport(await experience(paseo, botId), input)));
  server.handle(ticketReportSubmitRpc, ({ botId, ...input }, { paseo }) => guarded(async () => submitTicketReport(await experience(paseo, botId), input)));
  server.handle(ticketReportReconcileRpc, ({ botId, ...input }, { paseo }) => guarded(async () => reconcileTicketReport(await experience(paseo, botId), input)));
  server.handle(recoverHandoffRpc, ({ botId, ...input }, { paseo }) => guarded(async () => recoverHandoff(await experience(paseo, botId), input)));
  server.handle(reviewRpc, ({ botId, ...input }, { paseo }) => guarded(async () => reviewExecution(await experience(paseo, botId), input)));
  server.handle(markReviewedRpc, ({ botId, ...input }, { paseo }) => guarded(async () => markExecutionReviewed(await experience(paseo, botId), input)));
  server.handle(diagnosticsRpc, ({ botId }, { paseo }) => guarded(async () => {
    const service = await bots.service(botId);
    return diagnostics({ config: service.configuration(), storage: service.storage, runtime: service.runtime() }, await service.status(service.gatewayFor(paseo)));
  }));
  return async () => {
    unsubscribeSettings();
    unsubscribeTurns();
    await bots.close();
  };
}
