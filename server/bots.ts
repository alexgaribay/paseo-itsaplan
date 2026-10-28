import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { z } from "zod";
import { botIdSchema, botSchema, configSchema, type Config } from "../shared/config";
import type { Secrets } from "./contracts";
import { ConfigurationError } from "./errors";
import { IntegrationService } from "./service";
import { atomicJson, PrivateStorage, validateSecrets } from "./storage";
import { connectGateway } from "./paseo";
import { Client } from "./protocol";

const manifestSchema = z.record(botIdSchema, botSchema);
type Bot = z.infer<typeof botSchema>;
type Entry = { bot: Bot; service: IntegrationService };

export class BotRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly identities = new Map<string, string>();
  private configured = new Set(["default"]);
  private config: Config | undefined;
  private initialized: Promise<void> | undefined;
  private serial: Promise<void> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly root: PrivateStorage;

  constructor(
    readonly directory: string,
    private readonly settings: PluginSettings<typeof configSchema>,
    private readonly connect = connectGateway,
  ) {
    this.root = new PrivateStorage(directory);
    this.entries.set("default", this.create("default", { name: "Default bot", profileId: "", enabled: true }, this.root));
  }

  initialize(): Promise<void> { return this.initialized ??= this.load(); }

  private async load(): Promise<void> {
    await this.entries.get("default")!.service.status();
    let manifest: Record<string, Bot> = {};
    try {
      const file = await open(join(this.directory, "bots.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { manifest = manifestSchema.parse(JSON.parse(await file.readFile("utf8"))); }
      finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigurationError("Saved bot registry is unreadable; existing data has been preserved");
    }
    for (const [id, bot] of Object.entries(manifest)) {
      if (id === "default") continue;
      this.entries.set(id, this.create(id, bot));
    }
    const state = await this.settings.read();
    if (state.status !== "ready") {
      for (const { service } of this.entries.values()) {
        service.state = "configuration-error";
        service.message = "Plugin settings are invalid; repair the saved document";
      }
      return;
    }
    await this.apply(state.values);
  }

  private create(id: string, bot: Bot, storage = new PrivateStorage(join(this.directory, "bots", id), () => this.root.secrets())): Entry {
    const service = new IntegrationService(storage, this.settings, this.connect, async (config, protocol, signal) => {
      await this.checkKeys();
      const identity = await protocol.identity(signal);
      signal.throwIfAborted();
      this.reserveIdentity(id, config.serverUrl, identity);
    });
    return { bot: structuredClone(bot), service };
  }

  private reserveIdentity(id: string, serverUrl: string, identity: { id: string; isAgent: boolean }): void {
    if (!identity.isAgent) return;
    const key = JSON.stringify([serverUrl, identity.id]);
    const owner = this.identities.get(key);
    if (owner && owner !== id) throw new ConfigurationError("This external agent is already registered to another bot; use a different agent account");
    this.identities.set(key, id);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.serial.then(() => {
      if (this.closed) throw new ConfigurationError("The bot registry is closed");
      return operation();
    });
    this.serial = next.catch(() => {});
    return next;
  }

  async configure(config: Config): Promise<void> {
    const snapshot = structuredClone(config);
    await this.initialize();
    await this.enqueue(() => this.apply(snapshot));
  }

  private async apply(config: Config): Promise<void> {
    if (!Object.hasOwn(config.bots, "default")) throw new ConfigurationError("Keep the default bot to preserve legacy credentials and execution history");
    for (const [id, bot] of Object.entries(config.bots)) {
      botIdSchema.parse(id);
      const entry = this.entries.get(id);
      if (entry) entry.bot = structuredClone(bot);
      else this.entries.set(id, this.create(id, bot));
    }
    await Promise.all([...this.entries.values()].map(({ service }) => service.status()));
    const manifest = Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.bot]));
    await atomicJson(join(this.directory, "bots.json"), manifest);
    this.config = structuredClone(config);
    this.configured = new Set(Object.keys(config.bots));
    await this.checkKeys();
    await Promise.all([...this.entries].map(async ([id, { bot, service }]) => {
      const overlay = { ...structuredClone(config), botId: id, profileId: bot.profileId, automatic: config.automatic && this.configured.has(id) && bot.enabled };
      await service.initialize(overlay);
    }));
  }

  private select(id = "default"): IntegrationService {
    if (!this.configured.has(id)) throw new ConfigurationError("Unknown bot; select a configured bot and try again");
    const entry = this.entries.get(id);
    if (!entry) throw new ConfigurationError("Unknown bot; select a configured bot and try again");
    return entry.service;
  }

  async service(id?: string): Promise<IntegrationService> {
    await this.initialize();
    await this.serial;
    if (this.closed) throw new ConfigurationError("The bot registry is closed");
    return this.select(id);
  }

  private async checkKeys(patch?: { id: string; secrets: Secrets }): Promise<void> {
    const owners = new Map<string, string>();
    const root = await this.root.secrets();
    const shared = patch ? { ...root, ...Object.fromEntries(Object.entries(patch.secrets).filter(([key]) => key !== "apiKey")) } : root;
    for (const [id, { service }] of this.entries) {
      const current = await service.storage.secrets();
      const apiKey = patch?.id === id && patch.secrets.apiKey !== undefined ? patch.secrets.apiKey : current.apiKey;
      const secrets = validateSecrets({ ...shared, apiKey });
      if (!secrets.apiKey) continue;
      if (owners.has(secrets.apiKey)) throw new ConfigurationError("An execution API key is already registered to another bot; each bot needs its own key");
      owners.set(secrets.apiKey, id);
    }
  }

  async credentials(id: string | undefined, patch: Secrets): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const botId = id ?? "default";
      const service = this.select(botId);
      const normalized = validateSecrets(patch);
      const parsed: Secrets = Object.fromEntries(Object.keys(patch).map((key) => [key, normalized[key as keyof Secrets] ?? ""]));
      await this.checkKeys({ id: botId, secrets: parsed });
      const apiKey = parsed.apiKey;
      if (apiKey && this.config?.serverUrl) {
        for (const [otherId, entry] of this.entries) {
          if (otherId === botId) continue;
          const otherKey = (await entry.service.storage.secrets()).apiKey;
          if (!otherKey) continue;
          let identity;
          try { identity = await new Client({ url: this.config.serverUrl, apiKey: otherKey }).identity(AbortSignal.timeout(10_000)); }
          catch { /* Credentials can be saved while the upstream server is unavailable. */ }
          if (identity) this.reserveIdentity(otherId, this.config.serverUrl, identity);
        }
        let identity;
        try { identity = await new Client({ url: this.config.serverUrl, apiKey }).identity(AbortSignal.timeout(10_000)); }
        catch { /* Credentials can be saved while the upstream server is unavailable. */ }
        if (identity) this.reserveIdentity(botId, this.config.serverUrl, identity);
      }
      const { apiKey: _executionKey, ...shared } = parsed;
      if (botId === "default") await this.root.saveSecrets(parsed);
      else {
        if (apiKey !== undefined) await service.storage.saveSecrets({ apiKey });
        if (Object.keys(shared).length) await this.root.saveSecrets(shared);
      }
      if (this.config) await this.apply(this.config);
    });
  }

  async turnEnded(...args: Parameters<IntegrationService["turnEnded"]>): Promise<void> {
    await this.initialize();
    await Promise.all([...this.entries.values()].map(({ service }) => service.turnEnded(...args)));
  }

  close(): Promise<void> { return this.closing ??= this.shutdown(); }

  private async shutdown(): Promise<void> {
    this.closed = true;
    await this.initialized?.catch(() => {});
    await this.serial;
    const entries = [...this.entries.values()];
    const results = await Promise.allSettled(entries.filter(({ service }) => service.storage !== this.root).map(({ service }) => service.close()));
    await this.entries.get("default")!.service.close();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
