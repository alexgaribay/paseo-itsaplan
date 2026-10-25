import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";
import { DaemonClient, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import { defaults } from "../shared/config";
import { connectHost, describeHost, type HostRuntime } from "./host";
import { ConfigurationError } from "./errors";

const now = Date.parse("2026-10-24T10:00:00Z");
const token = "a".repeat(43);
const uid = process.getuid?.() ?? 0;
let directory: string;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "itsaplan-host-"));
  await chmod(directory, 0o700);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await rm(directory, { recursive: true, force: true });
});

function metadata(patch: Record<string, unknown> = {}) {
  return {
    pid: 12345, startedAt: new Date(now - 1000).toISOString(), hostname: "Fixture computer",
    uid, listen: "127.0.0.1:7467", serverId: "fixture-owner", bootId: "fixture-boot", ...patch,
  };
}
async function writeMetadata(home: string, patch: Record<string, unknown> = {}) {
  await writeFile(join(home, "paseo.pid"), JSON.stringify(metadata(patch)), { mode: 0o600 });
}
async function home(name = "custom", patch: Record<string, unknown> = {}) {
  const path = join(directory, name);
  await mkdir(path, { mode: 0o700 });
  await writeMetadata(path, patch);
  await writeFile(join(path, "local-credential"), `${token}\n`, { mode: 0o600 });
  return path;
}
function environment(path: string): Partial<HostRuntime> {
  return {
    env: { PASEO_HOME: path }, userHome: directory, now: () => now,
    uptime: () => 3600, uid, bootId: async () => "fixture-boot",
    processRunning: (pid) => pid === 12345, interfaces: () => ({}),
  };
}

class TestTransport implements DaemonTransport {
  private opens = new Set<() => void>();
  private closes = new Set<(event?: unknown) => void>();
  private messages = new Set<(data: unknown, binary: boolean) => void>();
  closed = false;
  sent: unknown[] = [];
  constructor(private serverId: string, private stalled: boolean) {}
  onOpen(handler: () => void) {
    this.opens.add(handler);
    if (!this.stalled) queueMicrotask(() => { if (!this.closed) handler(); });
    return () => { this.opens.delete(handler); };
  }
  onClose(handler: (event?: unknown) => void) { this.closes.add(handler); return () => { this.closes.delete(handler); }; }
  onError(_handler: (event?: unknown) => void) { return () => {}; }
  onMessage(handler: (data: unknown, binary: boolean) => void) { this.messages.add(handler); return () => { this.messages.delete(handler); }; }
  send(data: string | Uint8Array | ArrayBuffer) {
    if (this.closed) throw new Error("Fixture transport closed");
    const parsed = JSON.parse(typeof data === "string" ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString());
    this.sent.push(parsed);
    if (parsed.type === "hello") queueMicrotask(() => this.serverInfo(this.serverId));
  }
  serverInfo(serverId: string) {
    const message = JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId, hostname: "Fixture computer", version: "0.13.0" } } });
    if (!this.closed) for (const handler of this.messages) handler(message, false);
  }
  close() { this.closed = true; }
  disconnect() { this.closed = true; for (const handler of this.closes) handler({ code: 1006 }); }
}

function connection(path: string, options: { serverId?: string; serverIds?: string[]; stalled?: boolean; error?: string; immediateTimeout?: boolean; afterConnect?: () => Promise<void> } = {}) {
  const transports: TestTransport[] = [];
  const attempts: { endpoint: string; config: Omit<DaemonClientConfig, "url" | "transportFactory"> }[] = [];
  let activeDeadlines = 0;
  const dependencies: Partial<HostRuntime> = {
    ...environment(path),
    deadline: (callback) => {
      activeDeadlines++;
      if (options.immediateTimeout) queueMicrotask(callback);
      return () => { activeDeadlines--; };
    },
    createClient: (endpoint, config) => {
      attempts.push({ endpoint, config });
      if (options.error) throw new Error(options.error);
      const parsed = parseHostTarget(endpoint);
      if (parsed.kind !== "socket") throw new Error("Fixture only supports direct hosts");
      // Constructing the public factory checks its real grammar without opening a socket.
      clients.push(createHostClient(endpoint, config));
      const client = new DaemonClient({
        ...config, url: parsed.url,
        transportFactory: () => {
          const transport = new TestTransport(options.serverIds?.[transports.length] ?? options.serverId ?? "fixture-owner", options.stalled ?? false);
          transports.push(transport);
          return transport;
        },
      });
      if (options.afterConnect) {
        const connect = client.connect.bind(client);
        client.connect = async () => { await connect(); await options.afterConnect?.(); };
      }
      clients.push(client);
      return client;
    },
  };
  return { dependencies, transports, attempts, activeDeadlines: () => activeDeadlines };
}

describe("owning host metadata", () => {
  test("discovers an inherited custom home and ignores the old URL", async () => {
    const path = await home();
    expect(await describeHost({ ...defaults(), paseoUrl: "ws://localhost:6767/ws" }, environment(path))).toEqual({ mode: "auto", endpoint: "ws://127.0.0.1:7467/ws", serverId: "fixture-owner" });
  });

  test("uses the default private home without changing the environment", async () => {
    await home(".paseo");
    const deps = { ...environment("unused"), env: {} };
    expect(await describeHost(defaults(), deps)).toEqual({ mode: "auto", endpoint: "ws://127.0.0.1:7467/ws", serverId: "fixture-owner" });
    expect(deps.env).toEqual({});
  });

  test("expands a custom tilde home", async () => {
    await home("selected");
    expect(await describeHost(defaults(), { ...environment("~/selected"), userHome: directory })).toEqual({ mode: "auto", endpoint: "ws://127.0.0.1:7467/ws", serverId: "fixture-owner" });
  });

  test.each([
    ["127.0.0.1:7467", "ws://127.0.0.1:7467/ws"],
    ["7467", "ws://127.0.0.1:7467/ws"],
    ["0.0.0.0:7467", "ws://127.0.0.1:7467/ws"],
    ["[::]:7467", "ws://[::1]:7467/ws"],
    ["[::1]:7467", "ws://[::1]:7467/ws"],
    ["tcp://127.0.0.1:7467", "ws://127.0.0.1:7467/ws"],
    ["tcp://127.0.0.1:7467?ssl=true", "wss://127.0.0.1:7467/ws"],
    ["ws://localhost:7467/ws", "ws://localhost:7467/ws"],
    ["wss://localhost:7467/ws", "wss://localhost:7467/ws"],
    ["/private/tmp/paseo.sock", "/private/tmp/paseo.sock"],
    ["unix:///private/tmp/paseo.sock", "unix:///private/tmp/paseo.sock"],
    ["\\\\.\\pipe\\paseo-fixture", "\\\\.\\pipe\\paseo-fixture"],
    ["pipe://\\\\.\\pipe\\paseo-fixture", "pipe://\\\\.\\pipe\\paseo-fixture"],
  ])("accepts SDK endpoint %s", async (listen, endpoint) => {
    const path = await home("variant", { listen });
    const fixture = connection(path);
    const client = await connectHost(defaults(), {}, fixture.dependencies);
    expect(await describeHost(defaults(), fixture.dependencies)).toEqual({ mode: "auto", endpoint, serverId: "fixture-owner" });
    expect(client.getLastServerInfoMessage()?.serverId).toBe("fixture-owner");
    await client.close();
    expect(fixture.transports[0].closed).toBe(true);
  });

  test.each([
    { listen: null, serverId: null }, { serverId: null }, { serverId: undefined },
  ])("rejects metadata that has not published readiness %j", async (patch) => {
    const path = await home("not-ready", patch);
    await expect(describeHost(defaults(), environment(path))).rejects.toThrow("not ready");
  });

  test("rejects missing and malformed metadata without echoing file contents", async () => {
    const path = await home();
    await rm(join(path, "paseo.pid"));
    await expect(describeHost(defaults(), environment(path))).rejects.toThrow("missing, malformed, or not private");
    await writeFile(join(path, "paseo.pid"), `secret-${token}`);
    await expect(describeHost(defaults(), environment(path))).rejects.toThrow("Owning Paseo daemon metadata is missing, malformed, or not private");
  });

  test.each([
    { pid: 54321 }, { bootId: "old-boot" }, { uid: uid + 1 }, { startedAt: "invalid" },
    { startedAt: new Date(now + 60_000).toISOString() },
  ])("rejects stale or foreign metadata %j", async (patch) => {
    const path = await home("stale", patch);
    await expect(describeHost(defaults(), environment(path))).rejects.toThrow("stale or belongs to another host or user");
  });

  test("rejects pre-boot metadata on systems without boot identifiers", async () => {
    const path = await home("stale", { bootId: undefined, startedAt: new Date(now - 7_200_000).toISOString() });
    await expect(describeHost(defaults(), { ...environment(path), bootId: async () => null })).rejects.toThrow("stale");
  });

  test.each(["unrelated.example:7467", "wss://unrelated.example:7467/ws", "ssh://unrelated.example", "ws://localhost:7467/ws?password=private", "tcp://localhost:7467?password=private", "relative.sock"]) ("rejects unsafe automatic target %s", async (listen) => {
    const path = await home("unsafe", { listen });
    await expect(describeHost(defaults(), environment(path))).rejects.toThrow("Paseo");
  });

  test("rejects a shared home and symlinked metadata", async () => {
    const path = await home();
    if (process.getuid) {
      await chmod(path, 0o755);
      await expect(describeHost(defaults(), environment(path))).rejects.toThrow("not private");
      await chmod(path, 0o700);
    }
    const replacement = join(path, "replacement");
    await writeFile(replacement, JSON.stringify(metadata()), { mode: 0o600 });
    await rm(join(path, "paseo.pid"));
    await symlink(replacement, join(path, "paseo.pid"));
    await expect(describeHost(defaults(), environment(path))).rejects.toThrow("not private");
  });
});

describe("owning host connections", () => {
  test("authenticates locally without sending the manual password or exposing the token in discovery", async () => {
    const path = await home();
    const fixture = connection(path);
    const client = await connectHost({ ...defaults(), paseoUrl: "ws://localhost:1/ws" }, { paseoPassword: "manual-password" }, fixture.dependencies);
    expect(fixture.transports[0].sent[0]).toMatchObject({ type: "hello", auth: { kind: "localCredential", token } });
    expect(fixture.attempts[0].config.password).toBeUndefined();
    expect(JSON.stringify(await describeHost(defaults(), fixture.dependencies))).toBe('{"mode":"auto","endpoint":"ws://127.0.0.1:7467/ws","serverId":"fixture-owner"}');
    expect(fixture.activeDeadlines()).toBe(0);
    await client.close();
  });

  test("binds credential resolution to the original pid, endpoint and identity", async () => {
    const path = await home();
    const fixture = connection(path);
    const client = await connectHost(defaults(), {}, fixture.dependencies);
    const credential = fixture.attempts[0].config.localCredential!;
    for (const patch of [{ listen: "127.0.0.1:9999" }, { listen: "[::1]:7467" }, { serverId: "other-owner" }, { startedAt: new Date(now).toISOString() }]) {
      await writeMetadata(path, patch);
      await expect(Promise.resolve().then(credential)).rejects.toThrow("changed during connection");
    }
    await writeMetadata(path);
    expect(await credential()).toBe(token);
    await client.close();
  });

  test("closes a wrong-identity connection and releases its deadline", async () => {
    const path = await home();
    const fixture = connection(path, { serverId: "wrong-owner" });
    await expect(connectHost(defaults(), {}, fixture.dependencies)).rejects.toThrow("identity does not match");
    expect(fixture.transports[0].closed).toBe(true);
    expect(fixture.transports[0].sent).toEqual([expect.objectContaining({ type: "hello" })]);
    expect(fixture.activeDeadlines()).toBe(0);
  });

  test("rejects metadata replacement during the handshake", async () => {
    const path = await home();
    const fixture = connection(path, { afterConnect: () => writeMetadata(path, { listen: "127.0.0.1:9999" }) });
    await expect(connectHost(defaults(), {}, fixture.dependencies)).rejects.toThrow("changed during connection");
    expect(fixture.transports[0].closed).toBe(true);
    expect(fixture.activeDeadlines()).toBe(0);
  });

  test("recovers a transient same-daemon disconnect and guards the next identity", async () => {
    const path = await home();
    const fixture = connection(path, { serverIds: ["fixture-owner", "fixture-owner", "other-owner"] });
    const client = await connectHost(defaults(), {}, fixture.dependencies);
    fixture.transports[0].disconnect();
    await client.connect();
    expect(client.getLastServerInfoMessage()?.serverId).toBe("fixture-owner");
    expect(fixture.transports[1].sent[0]).toMatchObject({ type: "hello", auth: { kind: "localCredential", token } });
    fixture.transports[1].disconnect();
    const reconnect = client.connect();
    await expect(reconnect).rejects.toThrow("closed");
    expect(fixture.transports[2].closed).toBe(true);
    expect(fixture.transports[2].sent).toEqual([expect.objectContaining({ type: "hello" })]);
  });

  test("enforces the external deadline and closes a stalled client", async () => {
    const path = await home();
    const fixture = connection(path, { stalled: true, immediateTimeout: true });
    await expect(connectHost(defaults(), {}, fixture.dependencies)).rejects.toThrow("timed out");
    expect(fixture.transports.every((transport) => transport.closed)).toBe(true);
    expect(clients.at(-1)?.getConnectionState()).toEqual({ status: "disposed" });
    expect(fixture.activeDeadlines()).toBe(0);
  });

  test.each(["short", "!".repeat(43)])("rejects malformed local credentials", async (credential) => {
    const path = await home();
    await writeFile(join(path, "local-credential"), credential);
    const fixture = connection(path);
    await expect(connectHost(defaults(), {}, fixture.dependencies)).rejects.toThrow("credential is malformed");
    expect(fixture.activeDeadlines()).toBe(0);
  });

  test("rejects missing, public and symlinked local credentials", async () => {
    const path = await home();
    await rm(join(path, "local-credential"));
    await expect(connectHost(defaults(), {}, connection(path).dependencies)).rejects.toThrow("credential is missing or not private");
    await writeFile(join(path, "local-credential"), token, { mode: 0o644 });
    if (process.getuid) await expect(connectHost(defaults(), {}, connection(path).dependencies)).rejects.toThrow("credential is missing or not private");
    await rm(join(path, "local-credential"));
    await writeFile(join(path, "other-secret"), token, { mode: 0o600 });
    await symlink(join(path, "other-secret"), join(path, "local-credential"));
    await expect(connectHost(defaults(), {}, connection(path).dependencies)).rejects.toThrow("credential is missing or not private");
  });

  test("redacts transport failures instead of returning raw errors or credentials", async () => {
    const path = await home();
    const fixture = connection(path, { error: `credential ${token} ws://private:password@localhost/ws` });
    const error: unknown = await connectHost(defaults(), { paseoPassword: "private-password" }, fixture.dependencies).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigurationError);
    if (!(error instanceof ConfigurationError)) throw error;
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("private:password");
    expect(fixture.activeDeadlines()).toBe(0);
  });
});

describe("manual host override", () => {
  test("uses the explicit WSS endpoint and manual password for the owning daemon without reading local credentials", async () => {
    const path = await home();
    await rm(join(path, "local-credential"));
    const fixture = connection(path);
    const config = { ...defaults(), paseoConnectionMode: "manual" as const, paseoUrl: "wss://proxy.example/ws" };
    const client = await connectHost(config, { paseoPassword: "manual-password" }, fixture.dependencies);
    expect(await describeHost(config, fixture.dependencies)).toEqual({ mode: "manual", endpoint: "wss://proxy.example/ws", serverId: "fixture-owner" });
    expect(fixture.transports[0].sent[0]).toMatchObject({ type: "hello", auth: { kind: "password", password: "manual-password" } });
    expect(fixture.attempts[0].config.localCredential).toBeUndefined();
    expect(fixture.attempts[0].endpoint).toBe("wss://proxy.example/ws");
    await client.close();
  });

  test("requires owning runtime metadata even when a manual endpoint is configured", async () => {
    const fixture = connection(join(directory, "missing"));
    const config = { ...defaults(), paseoConnectionMode: "manual" as const, paseoUrl: "wss://proxy.example/ws" };
    await expect(describeHost(config, fixture.dependencies)).rejects.toThrow("metadata is missing");
    await expect(connectHost(config, { paseoPassword: "manual-password" }, fixture.dependencies)).rejects.toThrow("metadata is missing");
  });

  test("rejects an unrelated manual daemon and closes its transport", async () => {
    const fixture = connection(await home(), { serverId: "unrelated-daemon" });
    const config = { ...defaults(), paseoConnectionMode: "manual" as const, paseoUrl: "wss://proxy.example/ws" };
    await expect(connectHost(config, { paseoPassword: "manual-password" }, fixture.dependencies)).rejects.toThrow("identity does not match");
    expect(fixture.transports[0].closed).toBe(true);
    expect(fixture.transports[0].sent).toEqual([expect.objectContaining({ type: "hello", auth: { kind: "password", password: "manual-password" } })]);
    expect(fixture.activeDeadlines()).toBe(0);
  });

  test("recovers a manual same-daemon disconnect but closes a wrong-identity reconnect", async () => {
    const fixture = connection(await home(), { serverIds: ["fixture-owner", "fixture-owner", "unrelated-daemon"] });
    const config = { ...defaults(), paseoConnectionMode: "manual" as const, paseoUrl: "wss://proxy.example/ws" };
    const client = await connectHost(config, { paseoPassword: "manual-password" }, fixture.dependencies);
    fixture.transports[0].disconnect();
    await client.connect();
    expect(client.getLastServerInfoMessage()?.serverId).toBe("fixture-owner");
    expect(fixture.transports[1].sent[0]).toMatchObject({ type: "hello", auth: { kind: "password", password: "manual-password" } });
    fixture.transports[1].disconnect();
    await expect(client.connect()).rejects.toThrow("closed");
    expect(fixture.transports[2].closed).toBe(true);
    expect(fixture.transports[2].sent).toEqual([expect.objectContaining({ type: "hello" })]);
  });

  test("accepts plaintext only on loopback or an assigned interface", async () => {
    const fixture = connection(await home());
    const config = { ...defaults(), paseoConnectionMode: "manual" as const, paseoUrl: "ws://remote.example/ws" };
    await expect(describeHost(config, fixture.dependencies)).rejects.toThrow("use WSS");
    expect(await describeHost({ ...config, paseoUrl: "ws://127.0.0.1:7467/ws" }, fixture.dependencies)).toEqual({ mode: "manual", endpoint: "ws://127.0.0.1:7467/ws", serverId: "fixture-owner" });
    expect(await describeHost({ ...config, paseoUrl: "ws://192.168.1.42:7467/ws" }, {
      ...fixture.dependencies, interfaces: () => ({ fixture: [{ address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "192.168.1.42/24" }] }),
    })).toEqual({ mode: "manual", endpoint: "ws://192.168.1.42:7467/ws", serverId: "fixture-owner" });
  });

  test.each(["", "ws://user:password@localhost/ws", "ws://localhost/ws?password=secret", "ws://localhost/ws#secret", "ws://localhost/other", "unix:///tmp/paseo.sock", "tcp://localhost:7467"]) ("rejects invalid manual URL %s", async (paseoUrl) => {
    const fixture = connection(join(directory, "missing"));
    await expect(describeHost({ ...defaults(), paseoConnectionMode: "manual", paseoUrl }, fixture.dependencies)).rejects.toThrow("Invalid Paseo manual connection URL");
  });
});
