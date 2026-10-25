import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { contextLimits, persistedTaskContextSchema, taskContextSnapshotSchema, type PersistedTaskContext, type TaskContextAsset, type TaskContextSnapshot } from "../shared/task-context";
import { imageMatches, taskContextDigest } from "./task-context";
import { StorageError } from "./errors";

async function cacheDirectory(directory: string): Promise<string> {
  if (await realpath(directory) !== directory) throw new StorageError("Task context storage must be canonical");
  const cache = join(directory, "context-assets");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if (await realpath(cache) !== cache) throw new StorageError("Task context asset directory must not be a symlink");
  await chmod(cache, 0o700);
  return cache;
}

async function readAsset(cache: string, digest: string): Promise<Buffer> {
  const file = await open(join(cache, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > contextLimits.assetBytes) throw new StorageError("Task context image is invalid or exceeds its size limit");
    const bytes = await file.readFile();
    if (bytes.length > contextLimits.assetBytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new StorageError("Task context image changed; execution requires a fresh context review");
    return bytes;
  } finally { await file.close(); }
}

async function publishAsset(cache: string, digest: string, bytes: Buffer): Promise<void> {
  const temporary = join(cache, `.${digest}-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await file.close();
  try {
    try { await link(temporary, join(cache, digest)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readAsset(cache, digest);
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function cacheContextAssets(directory: string, input: TaskContextSnapshot): Promise<PersistedTaskContext> {
  try {
    const snapshot = taskContextSnapshotSchema.parse(input);
    if (taskContextDigest(snapshot) !== snapshot.digest) throw new StorageError("Task context snapshot does not match its recorded digest");
    let total = 0;
    const decoded = snapshot.assets.map((asset) => {
      const bytes = Buffer.from(asset.data, "base64");
      total += bytes.length;
      if (bytes.length > contextLimits.assetBytes || total > contextLimits.totalAssetBytes || bytes.toString("base64") !== asset.data || !imageMatches(bytes, asset.mimeType) || createHash("sha256").update(bytes).digest("hex") !== asset.digest) throw new StorageError("Task context image is invalid or exceeds its size limit");
      return bytes;
    });
    if (snapshot.assets.length) {
      const cache = await cacheDirectory(directory);
      for (let index = 0; index < snapshot.assets.length; index++) await publishAsset(cache, snapshot.assets[index]!.digest, decoded[index]!);
    }
    return persistedTaskContextSchema.parse({ ...snapshot, assets: snapshot.assets.map(({ data: _data, ...asset }) => asset) });
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("Task context images could not be stored privately");
  }
}

export async function hydrateContextAssets(directory: string, input: PersistedTaskContext): Promise<TaskContextAsset[]> {
  try {
    const snapshot = persistedTaskContextSchema.parse(input);
    if (taskContextDigest(snapshot) !== snapshot.digest) throw new StorageError("Task context snapshot changed; execution requires a fresh review");
    if (!snapshot.assets.length) return [];
    const cache = await cacheDirectory(directory);
    const assets: TaskContextAsset[] = [];
    let total = 0;
    for (const asset of snapshot.assets) {
      const bytes = await readAsset(cache, asset.digest);
      if (!imageMatches(bytes, asset.mimeType)) throw new StorageError("Task context image type does not match its captured bytes");
      total += bytes.length;
      if (total > contextLimits.totalAssetBytes) throw new StorageError("Task context images exceed the delivery size limit");
      assets.push({ ...asset, data: bytes.toString("base64") });
    }
    return assets;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("Task context images are missing or unreadable; captured inputs were not replaced");
  }
}
