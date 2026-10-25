import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sessionSchema, type SessionRecord } from "../shared/models";
import { rerunRequestSchema, type RerunRequest } from "../shared/experience";
import type { Journal, Secrets } from "./contracts";
import { ConfigurationError, StorageError } from "./errors";

const storedSchema = z.object({
  version: z.literal(1), records: z.record(z.string(), sessionSchema), threads: z.record(z.string(), z.object({ agentId: z.string(), projectId: z.string() })),
  paused: z.boolean().default(false), requests: z.record(z.string(), rerunRequestSchema).default({}),
});
const tokenSchema = z.string().trim().max(8192).refine((value) => !/[\r\n\0]/.test(value), "Credential contains invalid header characters");
const secretsSchema = z.object({ apiKey: tokenSchema.optional(), mcpToken: tokenSchema.optional(), paseoPassword: z.string().max(8192).optional(), requestApiKey: tokenSchema.optional() }).strict();
type Stored = z.infer<typeof storedSchema>;

export function dataDirectory(): string {
  const path = process.env.ITSAPLAN_PASEO_DATA_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "itsaplan");
  if (!isAbsolute(path)) throw new Error("ITSAPLAN_PASEO_DATA_DIR must be absolute");
  return path;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function jsonOrMissing(path: string): Promise<unknown | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Private integration storage is unreadable or invalid; preserved for recovery");
  }
}

export class PrivateStorage implements Journal {
  private value: Stored = { version: 1, records: {}, threads: {}, paused: false, requests: {} };
  private closing = false;
  private serial = Promise.resolve();
  private credentialsSerial = Promise.resolve();
  private releaseLock: (() => Promise<void>) | undefined;
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    if (this.closing) throw new StorageError("Private integration storage is closed");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory) throw new Error("Integration data directory must be canonical, not a symlink");
    await chmod(this.directory, 0o700);
    const lockPath = join(this.directory, "backend.lock");
    const ownerName = `owner-${process.pid}-${randomUUID()}`;
    const prepared = join(this.directory, ownerName);
    await mkdir(prepared, { mode: 0o700 });
    await writeFile(join(prepared, ownerName), "", { mode: 0o600, flag: "wx" });
    let held = false;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          // A published lock is always nonempty. Rename cannot replace another
          // owner's nonempty directory, on POSIX or Windows.
          await rename(prepared, lockPath);
          held = true;
          break;
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        let entries: string[];
        try { entries = await readdir(lockPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (entries.length === 0) {
          await rmdir(lockPath).catch((error: NodeJS.ErrnoException) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error; });
          continue;
        }
        const owner = entries.length === 1 ? /^owner-(\d+)-[0-9a-f-]{36}$/.exec(entries[0]) : null;
        if (!owner) throw new Error("Integration storage lock is invalid; preserved for inspection");
        let alive = true;
        try { process.kill(Number(owner[1]), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new Error("Another integration backend owns this data directory");
        // Only one contender can remove this exact owner's nonce. A stale
        // contender can never unlink the replacement owner's different file.
        try { await unlink(join(lockPath, entries[0])); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        await rmdir(lockPath).catch((error: NodeJS.ErrnoException) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error; });
      }
      if (!held) throw new Error("Integration storage ownership changed during recovery; retry startup");
    } finally { if (!held) await rm(prepared, { recursive: true, force: true }); }
    this.releaseLock = async () => {
      try { await unlink(join(lockPath, ownerName)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      await rmdir(lockPath);
    };
    try {
      const raw = await jsonOrMissing(join(this.directory, "sessions.json"));
      if (raw !== undefined) this.value = storedSchema.parse(raw);
    } catch (error) { await this.close(); throw error; }
  }

  records(): SessionRecord[] { return structuredClone(Object.values(this.value.records)); }
  get(key: string): SessionRecord | undefined { const value = this.value.records[key]; return value ? structuredClone(value) : undefined; }
  thread(threadId: string) { const value = this.value.threads[threadId]; return value ? { ...value } : undefined; }
  paused(): boolean { return this.value.paused; }
  setPaused(paused: boolean): Promise<void> { return this.commit((next) => { next.paused = paused; }); }
  requests(): RerunRequest[] { return structuredClone(Object.values(this.value.requests)); }
  request(id: string): RerunRequest | undefined { const value = this.value.requests[id]; return value ? structuredClone(value) : undefined; }
  putRequest(request: RerunRequest): Promise<void> { return this.commit((next) => { next.requests[request.id] = request; }); }
  updateRequest(id: string, change: (request: RerunRequest) => RerunRequest | undefined): Promise<void> {
    return this.commit((next) => {
      const current = next.requests[id];
      if (!current) throw new Error("Execution request association is missing");
      const updated = change(current);
      if (!updated) return false;
      next.requests[id] = updated;
    });
  }
  private commit(change: (next: Stored) => void | false): Promise<void> {
    if (this.closing) return Promise.reject(new StorageError("Private integration storage is closed"));
    const operation = this.serial.then(async () => {
      const next = structuredClone(this.value);
      if (change(next) === false) return;
      const valid = storedSchema.parse(next);
      await atomicJson(join(this.directory, "sessions.json"), valid);
      this.value = valid;
    }).catch(() => { throw new StorageError("Execution journal commit failed"); });
    this.serial = operation.catch(() => {});
    return operation;
  }
  put(record: SessionRecord): Promise<void> { return this.commit((next) => { next.records[record.key] = record; }); }
  putMany(records: SessionRecord[]): Promise<void> {
    return this.commit((next) => { for (const record of records) next.records[record.key] = record; });
  }
  update(key: string, change: (record: SessionRecord) => SessionRecord | undefined): Promise<void> {
    return this.commit((next) => {
      const current = next.records[key];
      if (!current) throw new Error("Execution association is missing");
      const updated = change(current);
      if (!updated) return false;
      next.records[key] = updated;
    });
  }
  bindThread(threadId: string, binding: { agentId: string; projectId: string }): Promise<void> {
    return this.commit((next) => { next.threads[threadId] = binding; });
  }
  secrets(): Promise<Secrets> {
    if (this.closing) return Promise.reject(new StorageError("Private integration storage is closed"));
    return this.readSecrets();
  }
  private async readSecrets(): Promise<Secrets> {
    const path = join(this.directory, "credentials.json");
    const raw = await jsonOrMissing(path);
    if (raw === undefined) return {};
    await chmod(path, 0o600);
    return secretsSchema.parse(raw);
  }
  saveSecrets(patch: Secrets): Promise<void> {
    if (this.closing) return Promise.reject(new StorageError("Private integration storage is closed"));
    const operation = this.credentialsSerial.then(async () => {
      const next = { ...await this.readSecrets(), ...secretsSchema.parse(patch) };
      for (const key of Object.keys(next) as (keyof Secrets)[]) if (!next[key]) delete next[key];
      if (next.apiKey && next.mcpToken && next.apiKey === next.mcpToken) throw new ConfigurationError("MCP must use a different credential from the execution key");
      if (next.requestApiKey && [next.apiKey, next.mcpToken].includes(next.requestApiKey)) throw new ConfigurationError("Reruns require a separate human API credential that is never shared with coding agents");
      await atomicJson(join(this.directory, "credentials.json"), next);
    });
    this.credentialsSerial = operation.catch(() => {});
    return operation;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.serial;
    await this.credentialsSerial;
    const release = this.releaseLock;
    this.releaseLock = undefined;
    await release?.();
  }
}
