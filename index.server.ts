import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { preferences } from "./shared/config";
import { attachRpc, cancelRpc, controlRpc, credentialsRpc, detailRpc, diagnosticsRpc, hostRpc, markReviewedRpc, milestoneRpc, planRpc, projectsRpc, providersRpc, queueRpc, readinessRpc, recoverHandoffRpc, rerunDiscardRpc, rerunPreviewRpc, rerunReconcileRpc, rerunSubmitRpc, reviewRpc, searchRpc, smokePreviewRpc, startRpc, statusRpc, testConnectionRpc, testHostRpc } from "./shared/rpc";
import { PrivateStorage, dataDirectory } from "./server/storage";
import { IntegrationService, publicSession } from "./server/service";
import { safeError } from "./server/engine";
import { ConfigurationError } from "./server/errors";
import { describeHost } from "./server/host";
import { discoverProjects } from "./server/projects";
import { planForIssue, queuePreview, readiness, type ExperienceContext } from "./server/experience";
import { discardRerun, prepareRerun, prepareSmoke, reconcileRerun, recoverHandoff, submitRerun } from "./server/rerun";
import { diagnostics } from "./server/diagnostics";
import { markExecutionReviewed, reviewExecution } from "./server/review";

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(safeError(error)); }
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const service = new IntegrationService(new PrivateStorage(dataDirectory()), settings);
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status === "ready") return service.configure(state.values);
  });
  const unsubscribeTurns = server.on("agent.turn_ended", (event) => guarded(() => service.turnEnded(event.agent.id, event.outcome)));
  void service.initialize().catch(() => { service.state = "storage-error"; service.message = "Integration storage could not be loaded; existing data has been preserved"; });
  const experience = (paseo: PaseoApi): Promise<ExperienceContext> => service.experience(paseo);

  server.handle(statusRpc, (_input, { paseo }) => guarded(() => service.status(service.config ? service.gatewayFor(paseo) : undefined)));
  server.handle(credentialsRpc, (patch) => guarded(async () => {
    await service.credentials(patch);
    return { ok: true, message: "Credentials stored privately; existing plaintext is never returned" };
  }));
  server.handle(testConnectionRpc, () => guarded(async () => {
    await (await service.protocol()).test();
    return { ok: true, message: "External-agent authentication succeeded without claiming work" };
  }));
  server.handle(hostRpc, async (_input, { paseo }) => {
    try {
      const state = await settings.read();
      if (state.status !== "ready") throw new ConfigurationError("Repair the saved plugin settings first");
      const host = await describeHost({ ...state.values, paseoConnectionMode: "auto" });
      const directory = await paseo.hosts.list();
      if (!host.serverId || host.serverId !== directory.self.serverId) throw new ConfigurationError("Paseo runtime metadata does not identify this plugin's owning host");
      return { status: "detected" as const, endpoint: host.endpoint, serverId: host.serverId };
    } catch (error) { return { status: "unavailable" as const, message: safeError(error) }; }
  });
  server.handle(testHostRpc, () => guarded(async () => {
    await service.checkHost();
    return { ok: true, message: "Connected to the owning Paseo daemon without claiming work" };
  }));
  server.handle(providersRpc, ({ cwd }, { paseo }) => guarded(async () => {
    // Provider discovery uses the caller's daemon context, never another host.
    const gateway = service.gatewayFor(paseo);
    return gateway.catalog(cwd);
  }));
  server.handle(projectsRpc, (_input, { paseo }) => guarded(async () => discoverProjects(await service.protocol(), service.gatewayFor(paseo), AbortSignal.timeout(30_000))));
  server.handle(searchRpc, ({ projectId, query }) => guarded(async () => (await service.protocol()).search(projectId, query)));
  server.handle(detailRpc, ({ issueId }) => guarded(async () => (await service.protocol()).issue(issueId)));
  server.handle(startRpc, ({ issueId, provider, model, modeId }, { paseo }) => guarded(async () => {
    const { engine, gateway, protocol } = await service.interactive(paseo);
    const issue = await protocol.issue(issueId);
    return publicSession(await engine.manual(issue, gateway, { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(modeId ? { modeId } : {}) }));
  }));
  server.handle(attachRpc, ({ issueId, agentId }, { paseo }) => guarded(async () => {
    const { engine, gateway, protocol } = await service.interactive(paseo);
    return publicSession(await engine.attach(await protocol.issue(issueId), agentId, gateway));
  }));
  server.handle(cancelRpc, ({ key }, { paseo }) => guarded(async () => {
    await service.cancel(key, paseo);
    return { ok: true, message: "Native cancellation confirmed; conversation and worktree preserved. Execution result delivery is tracked separately." };
  }));
  server.handle(milestoneRpc, ({ key, milestone, evidence }, { paseo }) => guarded(async () => {
    const { engine } = await service.interactive(paseo);
    await engine.milestone(key, milestone, evidence);
    return { ok: true, message: "Evidence posted and configured issue column applied" };
  }));
  server.handle(readinessRpc, (_input, { paseo }) => guarded(async () => {
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
    return readiness(await experience(paseo));
  }));
  server.handle(planRpc, (input, { paseo }) => guarded(async () => planForIssue(await experience(paseo), input)));
  server.handle(queueRpc, (_input, { paseo }) => guarded(async () => queuePreview(await experience(paseo))));
  server.handle(controlRpc, ({ action }) => guarded(() => service.control(action)));
  server.handle(rerunPreviewRpc, (input, { paseo }) => guarded(async () => prepareRerun(await experience(paseo), input)));
  server.handle(rerunSubmitRpc, (input, { paseo }) => guarded(async () => submitRerun(await experience(paseo), input)));
  server.handle(rerunReconcileRpc, (input, { paseo }) => guarded(async () => reconcileRerun(await experience(paseo), input)));
  server.handle(rerunDiscardRpc, (input, { paseo }) => guarded(async () => discardRerun(await experience(paseo), input)));
  server.handle(smokePreviewRpc, (input, { paseo }) => guarded(async () => prepareSmoke(await experience(paseo), input)));
  server.handle(recoverHandoffRpc, (input, { paseo }) => guarded(async () => recoverHandoff(await experience(paseo), input)));
  server.handle(reviewRpc, (input, { paseo }) => guarded(async () => reviewExecution(await experience(paseo), input)));
  server.handle(markReviewedRpc, (input, { paseo }) => guarded(async () => markExecutionReviewed(await experience(paseo), input)));
  server.handle(diagnosticsRpc, (_input, { paseo }) => guarded(async () => diagnostics(
    { config: service.configuration(), storage: service.storage, runtime: service.runtime() },
    await service.status(service.gatewayFor(paseo)),
  )));
  return async () => {
    unsubscribeSettings();
    unsubscribeTurns();
    await service.close();
  };
}
