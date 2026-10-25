import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir, networkInterfaces, uptime } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";
import type { DaemonClient, DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import type { Config } from "../shared/config";
import type { Secrets } from "./contracts";
import { ConfigurationError } from "./errors";

export interface HostDescription {
  mode: "auto" | "manual";
  endpoint: string;
  serverId: string | null;
}
export interface HostRuntime {
  env: NodeJS.ProcessEnv;
  userHome: string;
  now: () => number;
  uptime: () => number;
  uid: number | undefined;
  bootId: () => Promise<string | null>;
  processRunning: (pid: number) => boolean;
  interfaces: typeof networkInterfaces;
  createClient: (endpoint: string, options: Omit<DaemonClientConfig, "url" | "transportFactory">) => DaemonClient;
  deadline: (callback: () => void, milliseconds: number) => () => void;
}

const metadataSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  hostname: z.string().min(1),
  uid: z.number().int().nonnegative(),
  listen: z.string().nullable(),
  serverId: z.string().min(1).nullable().optional(),
  bootId: z.string().optional(),
});
type Metadata = z.infer<typeof metadataSchema> & { listen: string; serverId: string };
type Target = { endpoint: string; key: string };
const connectionTimeoutMs = 10_000;
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

function runtime(overrides: Partial<HostRuntime>): HostRuntime {
  return {
    env: process.env,
    userHome: homedir(),
    now: Date.now,
    uptime,
    uid: process.getuid?.(),
    bootId: async () => {
      try { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || null; }
      catch { return null; }
    },
    processRunning: (pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    },
    interfaces: networkInterfaces,
    createClient: createHostClient,
    deadline: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    ...overrides,
  };
}

function homeFor(host: HostRuntime): string {
  const raw = host.env.PASEO_HOME ?? "~/.paseo";
  return resolve(raw === "~" ? host.userHome : raw.startsWith("~/") ? join(host.userHome, raw.slice(2)) : raw);
}

async function privateFile(home: string, name: string, secret: boolean, host: HostRuntime): Promise<string> {
  const directory = await stat(home);
  if (!directory.isDirectory() || (host.uid !== undefined && (directory.uid !== host.uid || (directory.mode & 0o077) !== 0))) {
    throw new Error("Unsafe Paseo home");
  }
  const file = await open(join(home, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > (secret ? 128 : 16_384) ||
      (host.uid !== undefined && (info.uid !== host.uid || (info.mode & (secret ? 0o077 : 0o022)) !== 0))) {
      throw new Error("Unsafe Paseo runtime file");
    }
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

async function readMetadata(home: string, host: HostRuntime): Promise<Metadata> {
  let parsed: z.infer<typeof metadataSchema>;
  try { parsed = metadataSchema.parse(JSON.parse(await privateFile(home, "paseo.pid", false, host))); }
  catch { throw new ConfigurationError("Owning Paseo daemon metadata is missing, malformed, or not private"); }
  const started = Date.parse(parsed.startedAt);
  const bootId = await host.bootId();
  if (!Number.isFinite(started) || started > host.now() + 5_000 ||
    (host.uid !== undefined && parsed.uid !== host.uid) ||
    (parsed.bootId && bootId ? parsed.bootId !== bootId : started < host.now() - host.uptime() * 1000 - 5_000) ||
    !host.processRunning(parsed.pid)) {
    throw new ConfigurationError("Owning Paseo daemon metadata is stale or belongs to another host or user");
  }
  if (!parsed.listen || !parsed.serverId) throw new ConfigurationError("Owning Paseo daemon is not ready");
  return { ...parsed, listen: parsed.listen, serverId: parsed.serverId };
}

function localAddress(hostname: string, host: HostRuntime): boolean {
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(hostname) ||
    Object.values(host.interfaces()).some((addresses) => addresses?.some((address) => address.address === hostname));
}

function checkedTarget(connection: string, mode: HostDescription["mode"], host: HostRuntime): Target {
  try {
    if (/^(?:wss?|tcp):\/\//.test(connection)) {
      const url = new URL(connection);
      if (url.username || url.password || url.hash ||
        (url.search && !(url.protocol === "tcp:" && url.search === "?ssl=true"))) throw new Error("Embedded credentials");
    }
    const target = parseHostTarget(connection);
    if (target.kind !== "socket" || target.offer || target.password) throw new Error("Unsupported host transport");
    if (target.socketPath) {
      if (mode === "manual") throw new Error("Manual connection requires WebSocket URL");
      if (target.description.startsWith("pipe://")) {
        if (!target.socketPath.startsWith("\\\\.\\pipe\\")) throw new Error("Invalid named pipe");
        return { endpoint: connection, key: `pipe:${target.socketPath}` };
      }
      const path = target.socketPath.startsWith("~/") ? join(host.userHome, target.socketPath.slice(2)) : target.socketPath;
      if (!isAbsolute(path)) throw new Error("Relative socket path");
      return { endpoint: connection, key: `unix:${resolve(path)}` };
    }
    const url = new URL(target.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/ws" || url.search || url.hash) throw new Error("Invalid WebSocket URL");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const local = localAddress(hostname, host);
    if ((mode === "auto" || url.protocol === "ws:") && !local) {
      throw new ConfigurationError(mode === "auto"
        ? "Owning Paseo daemon metadata must target this machine"
        : "Unencrypted Paseo connections must target this machine's loopback or assigned interface; use WSS for a remote host");
    }
    // A wildcard is a bind address, not another discovered host.
    if (hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (hostname === "::") url.hostname = "[::1]";
    return { endpoint: url.toString(), key: url.toString() };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Invalid or unsupported Paseo host endpoint");
  }
}

function manualTarget(config: Config, host: HostRuntime): Target {
  try {
    const url = new URL(config.paseoUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/ws") {
      throw new Error("Invalid manual URL");
    }
  } catch { throw new ConfigurationError("Invalid Paseo manual connection URL"); }
  return checkedTarget(config.paseoUrl, "manual", host);
}

function assertSameDaemon(expected: Metadata, actual: Metadata, key: string, host: HostRuntime): void {
  if (expected.pid !== actual.pid || expected.startedAt !== actual.startedAt || expected.serverId !== actual.serverId ||
    checkedTarget(actual.listen, "auto", host).key !== key) {
    throw new ConfigurationError("Owning Paseo daemon changed during connection; reconnect to discover it again");
  }
}

export async function describeHost(config: Config, overrides: Partial<HostRuntime> = {}): Promise<HostDescription> {
  const host = runtime(overrides);
  const manual = config.paseoConnectionMode === "manual" ? manualTarget(config, host) : null;
  const metadata = await readMetadata(homeFor(host), host);
  const ownerTarget = checkedTarget(metadata.listen, "auto", host);
  return {
    mode: config.paseoConnectionMode,
    endpoint: (manual ?? ownerTarget).endpoint,
    serverId: metadata.serverId,
  };
}

export async function connectHost(config: Config, secrets: Secrets, overrides: Partial<HostRuntime> = {}): Promise<DaemonClient> {
  const host = runtime(overrides);
  const automatic = config.paseoConnectionMode === "auto";
  const home = homeFor(host);
  const manual = automatic ? null : manualTarget(config, host);
  const metadata = await readMetadata(home, host);
  const ownerTarget = checkedTarget(metadata.listen, "auto", host);
  const target = manual ?? ownerTarget;
  const localCredential = automatic ? async () => {
    const current = await readMetadata(home, host);
    assertSameDaemon(metadata, current, ownerTarget.key, host);
    let token: string;
    try { token = (await privateFile(home, "local-credential", true, host)).trim(); }
    catch { throw new ConfigurationError("Owning Paseo local credential is missing or not private"); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ConfigurationError("Owning Paseo local credential is malformed");
    assertSameDaemon(metadata, await readMetadata(home, host), ownerTarget.key, host);
    return token;
  } : undefined;
  let client: DaemonClient | undefined;
  let cancelDeadline: (() => void) | undefined;
  let identityFailure: ConfigurationError | undefined;
  try {
    client = host.createClient(target.endpoint, {
      clientId: `itsaplan-${randomUUID()}`, clientType: "cli", logger: quietLogger,
      connectTimeoutMs: connectionTimeoutMs, reconnect: { enabled: true },
      ...(localCredential ? { localCredential } : { password: secrets.paseoPassword }),
    });
    const connected = client;
    const close = connected.close.bind(connected);
    let unsubscribe: (() => void) | undefined;
    connected.close = async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      await close();
    };
    unsubscribe = connected.subscribeConnectionStatus((state) => {
      if (state.status === "connected" && connected.getLastServerInfoMessage()?.serverId !== metadata.serverId) {
        identityFailure = new ConfigurationError("Connected Paseo daemon identity does not match its owning host metadata");
        void connected.close().catch(() => {});
      }
    });
    await Promise.race([
      (async () => {
        await connected.connect();
        if (connected.getLastServerInfoMessage()?.serverId !== metadata.serverId) {
          throw new ConfigurationError("Connected Paseo daemon identity does not match its owning host metadata");
        }
        assertSameDaemon(metadata, await readMetadata(home, host), ownerTarget.key, host);
      })(),
      new Promise<never>((_resolve, reject) => {
        cancelDeadline = host.deadline(() => reject(new ConfigurationError("Paseo host connection timed out")), connectionTimeoutMs);
      }),
    ]);
    return connected;
  } catch (error) {
    await client?.close().catch(() => {});
    if (identityFailure) throw identityFailure;
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(automatic
      ? "Unable to connect to the owning Paseo daemon. Its runtime metadata or local credential may have changed."
      : "Unable to connect to Paseo. Check the manual endpoint and Paseo password.");
  } finally { cancelDeadline?.(); }
}
