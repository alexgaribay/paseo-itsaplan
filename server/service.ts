import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { configSchema, type Config } from "../shared/config";
import { publicSessionSchema, type SessionRecord } from "../shared/models";
import type { IntegrationRuntime } from "../shared/experience";
import type { Gateway, Secrets, SessionSnapshot } from "./contracts";
import { PrivateStorage } from "./storage";
import { Engine, safeError } from "./engine";
import { AgentIdentityError, Client, isAuthError } from "./protocol";
import { connectGateway, PaseoGateway } from "./paseo";
import { ConfigurationError } from "./errors";
import { connectHost } from "./host";
import type { ExperienceContext } from "./experience";

const manualPhases = new Set<SessionRecord["phase"]>(["preparing", "created", "sending", "running"]);

export class IntegrationService {
  state = "initializing";
  message = "Loading private integration state";
  config: Config | undefined;
  engine: Engine | undefined;
  private gateway: Gateway | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private readonly lifetime = new AbortController();
  private bootstrap = new AbortController();
  private epoch = 0;
  private configuredEpoch = 0;
  private serial = Promise.resolve();
  private initialized: Promise<void>;
  private connectionKey: string | undefined;
  private pendingConfiguration = false;
  private draining: Promise<void> | undefined;
  private controls: Promise<void> = Promise.resolve();
  private readonly interactiveEngines = new Set<Engine>();
  constructor(readonly storage: PrivateStorage, private readonly settings: PluginSettings<typeof configSchema>, private readonly connect = connectGateway) {
    this.initialized = storage.initialize();
  }
  async initialize(): Promise<void> {
    await this.initialized;
    const state = await this.settings.read();
    if (state.status !== "ready") { this.state = "configuration-error"; this.message = "Plugin settings are invalid; repair or reset the saved document"; return; }
    await this.configure(state.values);
  }
  configuration(): Config {
    if (!this.config) throw new ConfigurationError("Plugin settings have not loaded");
    return structuredClone(this.config);
  }

  runtime(): IntegrationRuntime {
    const runtime = this.engine?.runtime() ?? { claiming: false, paused: this.storage.paused(), active: 0, reservations: 0, pendingConfiguration: false, lastPollAt: null };
    const manual = this.storage.records().filter((record) => record.kind === "manual" && manualPhases.has(record.phase)).length;
    return { ...runtime, paused: this.storage.paused(), active: runtime.active + manual, pendingConfiguration: this.pendingConfiguration };
  }

  configure(config: Config): Promise<void> {
    const snapshot = structuredClone(config);
    const epoch = ++this.epoch;
    this.bootstrap.abort();
    this.bootstrap = new AbortController();
    const signal = AbortSignal.any([this.bootstrap.signal, this.lifetime.signal]);
    clearTimeout(this.reconnect);
    const operation = this.serial.then(async () => {
      await this.initialized;
      if (signal.aborted || epoch !== this.epoch) return;
      this.config = snapshot;
      this.configuredEpoch = epoch;
      const secrets = await this.storage.secrets();
      const key = JSON.stringify([snapshot.serverUrl, snapshot.paseoConnectionMode, snapshot.paseoUrl, secrets.apiKey, secrets.paseoPassword]);
      if (this.engine && this.connectionKey === key && !this.pendingConfiguration) {
        this.engine.updateConfiguration(snapshot, secrets);
        return;
      }
      if (this.engine) {
        this.pendingConfiguration = true;
        if (!this.draining) {
          const engine = this.engine;
          const gateway = this.gateway;
          this.draining = engine.drain().then(async () => {
            if (this.lifetime.signal.aborted) return;
            await gateway?.close();
            this.engine = undefined;
            this.gateway = undefined;
            this.connectionKey = undefined;
            this.pendingConfiguration = false;
            this.draining = undefined;
            if (this.config) await this.configure(this.config);
          }).catch(() => {
            this.draining = undefined;
            this.state = "offline";
            this.message = "Connection change is pending; previous executions remain preserved";
          });
        }
        return;
      }
      if (!snapshot.serverUrl || !secrets.apiKey) { this.state = "unconfigured"; this.message = "Configure an It's a Plan URL and external-agent key"; return; }
      const recovery = this.storage.records().some((record) => record.serverUrl === snapshot.serverUrl && record.task &&
        (["preparing", "created", "sending", "running", "stopping", "reporting"].includes(record.phase) || record.cancellation === "unconfirmed"));
      if (!snapshot.automatic && !recovery) { this.state = "idle"; this.message = "Configured; automatic delegation is disabled"; return; }
      this.state = "connecting";
      this.message = "Connecting managed plugin backend";
      const protocol = new Client({ url: snapshot.serverUrl, apiKey: secrets.apiKey });
      try {
        await protocol.test(signal);
        const gateway = await this.connect(snapshot, secrets);
        if (signal.aborted || epoch !== this.epoch) { await gateway.close(); return; }
        this.gateway = gateway;
        this.connectionKey = key;
        this.engine = new Engine(snapshot, protocol, gateway, this.storage, secrets);
        await this.engine.start(this.storage.paused());
        this.state = "ready";
        this.message = "Managed backend ready";
      } catch (error) {
        if (signal.aborted) return;
        this.state = isAuthError(error) ? "authentication-error" : "offline";
        this.message = isAuthError(error) && !(error instanceof AgentIdentityError) ? "External-agent key rejected; replace the key in Connection" : safeError(error);
        if (!isAuthError(error)) this.reconnect = setTimeout(() => { if (this.config) void this.configure(this.config); }, 5000);
      }
    });
    this.serial = operation.catch(() => { this.state = "storage-error"; this.message = "Private integration state is unreadable; preserved for recovery"; });
    return this.serial;
  }

  async control(action: "pause" | "resume" | "stop"): Promise<{ ok: boolean; message: string; runtime: IntegrationRuntime }> {
    const operation = this.controls.then(() => this.applyControl(action));
    this.controls = operation.then(() => {}, () => {});
    return operation;
  }

  private async applyControl(action: "pause" | "resume" | "stop"): Promise<{ ok: boolean; message: string; runtime: IntegrationRuntime }> {
    await this.initialized;
    if (action === "resume" && !this.config?.automatic) return { ok: false, message: "Enable automatic delegation in Execution settings before resuming", runtime: this.runtime() };
    if (action === "resume" && this.storage.records().some((record) => record.cancellation === "unconfirmed")) {
      return { ok: false, message: "Confirm native cancellation before resuming automatic claims", runtime: this.runtime() };
    }
    await this.storage.setPaused(action !== "resume");
    this.engine?.setPaused(action !== "resume");
    if (action === "stop") {
      await Promise.all([...this.interactiveEngines].map((entry) => entry.stopActive()));
      let engine = this.engine;
      let temporary: Gateway | undefined;
      const outstanding = this.storage.records().some((record) => manualPhases.has(record.phase) || record.phase === "stopping" || record.cancellation === "unconfirmed");
      try {
        if (!engine && outstanding) {
          const config = this.configuration();
          const secrets = await this.storage.secrets();
          temporary = await this.connect(config, secrets);
          engine = new Engine(config, await this.protocol(config), temporary, this.storage, secrets);
        }
        const ok = engine ? await engine.stopActive() : true;
        return { ok, message: ok ? "Paused; native cancellation confirmed for stopped executions" : "Paused; native cancellation is unconfirmed. Inspect the linked session", runtime: this.runtime() };
      } catch {
        for (const record of this.storage.records()) {
          await this.storage.update(record.key, (current) => manualPhases.has(current.phase) || current.phase === "stopping"
            ? { ...current, phase: "uncertain", cancellation: "unconfirmed", error: "Native cancellation could not be confirmed; inspect the linked Paseo session", updatedAt: Date.now() } : undefined);
        }
        return { ok: false, message: "Paused; native cancellation could not be confirmed. Inspect the linked session", runtime: this.runtime() };
      } finally { await temporary?.close(); }
    }
    if (action === "resume" && !this.engine && this.config) await this.configure(this.config);
    return { ok: true, message: action === "pause" ? "Paused; existing executions continue with their leases" : "Resumed; automatic claims run when the connection is ready", runtime: this.runtime() };
  }
  async credentials(patch: Secrets): Promise<void> {
    await this.initialized;
    await this.storage.saveSecrets(patch);
    if (this.config) await this.configure(this.config);
  }
  async experience(paseo: PaseoApi): Promise<ExperienceContext> {
    await this.initialized;
    const epoch = this.epoch;
    const config = this.configuration();
    const assertCurrent = () => {
      if (this.lifetime.signal.aborted || epoch !== this.epoch || this.configuredEpoch !== epoch) {
        throw new ConfigurationError("Settings or credentials changed; refresh the preview before continuing.");
      }
    };
    assertCurrent();
    if (!config.serverUrl) throw new ConfigurationError("Configure the It's a Plan server URL first");
    const secrets = await this.storage.secrets();
    assertCurrent();
    if (!secrets.apiKey) throw new ConfigurationError("Configure an external-agent API key first");
    const captured = Promise.resolve(Object.freeze(secrets));
    const protocol = new Client({ url: config.serverUrl, apiKey: secrets.apiKey, signal: AbortSignal.any([this.bootstrap.signal, this.lifetime.signal]) });
    return {
      config, protocol, gateway: this.gatewayFor(paseo, config, secrets), storage: this.storage, runtime: this.runtime(),
      credentials: () => { assertCurrent(); return captured; }, assertCurrent,
    };
  }
  async protocol(config: Config = this.configuration()): Promise<Client> {
    const epoch = this.epoch;
    await this.initialized;
    if (!config.serverUrl) throw new ConfigurationError("Configure the It's a Plan server URL first");
    const secrets = await this.storage.secrets();
    if (epoch !== this.epoch || config.serverUrl !== this.config?.serverUrl) throw new ConfigurationError("Connection settings changed while preparing the request; try again");
    if (!secrets.apiKey) throw new ConfigurationError("Configure an external-agent API key first");
    return new Client({ url: config.serverUrl, apiKey: secrets.apiKey, signal: this.lifetime.signal });
  }
  async checkHost(): Promise<void> {
    await this.initialized;
    if (!this.config) throw new ConfigurationError("Plugin settings have not loaded");
    const gateway = await connectGateway(this.config, await this.storage.secrets());
    await gateway.close();
  }
  gatewayFor(paseo: PaseoApi, config = this.configuration(), capturedSecrets?: Secrets): Gateway {
    const owned = this.gateway;
    const secrets = () => capturedSecrets ?? this.storage.secrets();
    const cancel = async (id: string) => {
      if (owned) { await owned.cancel(id); return; }
      const gateway = await this.connect(config, await secrets());
      try { await gateway.cancel(id); } finally { await gateway.close(); }
    };
    return owned?.withApi?.(paseo) ?? new PaseoGateway(paseo, cancel, undefined, async (options) => {
      const client = await connectHost(config, await secrets());
      try { return await client.createAgent(options); } finally { await client.close(); }
    }, cancel);
  }

  async interactive(paseo: PaseoApi): Promise<{ engine: Engine; gateway: Gateway; protocol: Client }> {
    if (this.pendingConfiguration) throw new ConfigurationError("Wait for the previous connection's executions and results to drain before starting work");
    const epoch = this.epoch;
    const config = this.configuration();
    const protocol = await this.protocol(config);
    const secrets = await this.storage.secrets();
    if (epoch !== this.epoch || this.pendingConfiguration) throw new ConfigurationError("Settings changed while preparing the session; preview it again before starting");
    const gateway = this.gatewayFor(paseo, config, secrets);
    for (const entry of this.interactiveEngines) if (entry.runtime().active === 0) this.interactiveEngines.delete(entry);
    const engine = new Engine(config, protocol, gateway, this.storage, secrets);
    this.interactiveEngines.add(engine);
    return { engine, gateway, protocol };
  }
  async status(gateway?: Pick<Gateway, "inspect">) {
    await this.initialized;
    const native = new Map<string, SessionSnapshot | null>();
    if (gateway) {
      for (const record of this.storage.records()) {
        if (!manualPhases.has(record.phase) && record.phase !== "stopping" && record.cancellation !== "unconfirmed") continue;
        let session;
        try { session = await gateway.inspect(record.agentId); native.set(record.agentId, session); }
        catch { continue; }
        if (record.kind !== "manual" || record.updatedAt > Date.now() - 60000) continue;
        if (session?.active && !session.archived) continue;
        const missing = !session || session.archived;
        await this.storage.update(record.key, (current) => {
          if (!manualPhases.has(current.phase) || current.updatedAt !== record.updatedAt) return undefined;
          return { ...current, phase: missing ? "finished" : "uncertain", updatedAt: Date.now(),
            result: missing ? { status: "failed", error: "Manual Paseo session is missing or archived" } : undefined,
            error: missing ? undefined : "Manual session is idle without an observed turn outcome; inspect native history before retrying" };
        });
        this.engine?.observeTurnEnd(record.agentId, "completed");
      }
    }
    const secrets = await this.storage.secrets();
    return {
      state: this.engine?.state ?? this.state,
      message: this.engine?.message ?? this.message,
      credentialPresent: Boolean(secrets.apiKey), mcpCredentialPresent: Boolean(secrets.mcpToken), passwordPresent: Boolean(secrets.paseoPassword), requestCredentialPresent: Boolean(secrets.requestApiKey),
      runtime: this.runtime(),
      requests: this.storage.requests().map(({ body: _body, planDigest: _digest, serverUrl: _url, continuation: _continuation, continuationScope: _scope, ...request }) => request),
      sessions: this.storage.records().sort((a, b) => b.updatedAt - a.updatedAt).map((record) => {
        const session = native.get(record.agentId);
        return publicSession(session ? { ...record, provider: session.provider, model: session.model, modeId: session.modeId, pendingPermissionCount: session.pendingPermissionCount } : record);
      }),
      dataDirectory: this.storage.directory,
    };
  }
  async turnEnded(agentId: string, outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string }): Promise<void> {
    await this.initialized;
    this.engine?.observeTurnEnd(agentId, outcome.kind);
    for (const record of this.storage.records()) {
      if (record.kind !== "manual" || record.agentId !== agentId || !["sending", "running"].includes(record.phase)) continue;
      await this.storage.put({ ...record, phase: "finished", result: outcome.kind === "completed" ? { status: "success" } : { status: "failed", error: outcome.kind === "canceled" ? "Agent turn canceled" : "Agent turn failed; inspect the linked Paseo session" }, updatedAt: Date.now() });
    }
    this.engine?.observeTurnEnd(agentId, outcome.kind);
  }
  async cancel(key: string, paseo: PaseoApi): Promise<void> {
    if (this.engine) { await this.engine.cancel(key); return; }
    const { engine } = await this.interactive(paseo);
    await engine.cancel(key);
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    this.bootstrap.abort();
    ++this.epoch;
    clearTimeout(this.reconnect);
    // The owned SDK connection remains usable here; Paseo revokes context APIs
    // before plugin cleanup. Its two-second soft shutdown bounds this handoff.
    try { await Promise.all([this.engine?.stop(), ...[...this.interactiveEngines].map((entry) => entry.stop())]); }
    finally {
      try { await this.gateway?.close(); }
      finally {
        await this.initialized.catch(() => {});
        for (const record of this.storage.records()) {
          if (record.kind === "manual" && (manualPhases.has(record.phase) || record.phase === "stopping")) {
            await this.storage.update(record.key, (current) => manualPhases.has(current.phase) || current.phase === "stopping" ? { ...current, phase: "uncertain", cancellation: "unconfirmed", error: "Plugin unloaded without observing native turn completion", updatedAt: Date.now() } : undefined);
          }
        }
        await this.storage.close();
      }
    }
  }
}

export function publicSession(record: SessionRecord) { return publicSessionSchema.parse(record); }
