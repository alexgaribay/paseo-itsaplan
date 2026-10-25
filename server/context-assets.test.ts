import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { TaskContextSnapshot } from "../shared/task-context";
import { cacheContextAssets, hydrateContextAssets } from "./context-assets";
import { taskContextDigest } from "./task-context";
import { StorageError } from "./errors";

const roots: string[] = [];
async function root() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "iap-context-assets-")));
  roots.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
function snapshot(): TaskContextSnapshot {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB2cAAAAASUVORK5CYII=";
  const value: TaskContextSnapshot = { version: 1, issueId: 7, projectId: 8, capturedAt: 1, digest: "0".repeat(64), text: "Observed screenshot", warnings: [], development: [], assets: [{ id: "2c039047-1dab-4c77-9acb-0e665b0a9e30", filename: "screenshot.png", mimeType: "image/png", data, digest: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") }] };
  return { ...value, digest: taskContextDigest(value) };
}

test("persisted context keeps image references and recovers exact bytes independently of the hydrated input", async () => {
  const directory = await root();
  const input = snapshot();
  const captured = await cacheContextAssets(directory, input);
  expect(JSON.stringify(captured)).not.toContain(input.assets[0]!.data);
  await writeFile(join(directory, "captured.json"), JSON.stringify(captured));
  input.assets[0]!.data = "changed transient input";
  const recovered = JSON.parse(await readFile(join(directory, "captured.json"), "utf8"));
  expect(await hydrateContextAssets(directory, recovered)).toEqual(snapshot().assets);
});

test("tampered or missing cached images fail closed instead of replacing captured task inputs", async () => {
  const directory = await root();
  const captured = await cacheContextAssets(directory, snapshot());
  const file = join(directory, "context-assets", captured.assets[0]!.digest);
  await writeFile(file, "corrupt bytes");
  await expect(hydrateContextAssets(directory, captured)).rejects.toThrow(StorageError);
  await expect(cacheContextAssets(directory, snapshot())).rejects.toThrow(StorageError);
  await unlink(file);
  await expect(hydrateContextAssets(directory, captured)).rejects.toThrow(StorageError);
});

test("asset digest/path manipulation cannot read credentials or escape the private asset directory", async () => {
  const directory = await root();
  await writeFile(join(directory, "credentials.json"), "private sentinel");
  const captured = await cacheContextAssets(directory, snapshot());
  captured.assets[0]!.digest = "../../credentials.json";
  await expect(hydrateContextAssets(directory, captured)).rejects.toThrow(StorageError);
  expect(await readFile(join(directory, "credentials.json"), "utf8")).toBe("private sentinel");
});

test("a symlinked cache cannot publish task content outside plugin storage", async () => {
  const directory = await root();
  const outside = await root();
  await writeFile(join(outside, "sentinel"), "preserved");
  await symlink(outside, join(directory, "context-assets"));
  await expect(cacheContextAssets(directory, snapshot())).rejects.toThrow(StorageError);
  expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserved");
});

test("a corrupted manifest cannot silently substitute different text or image bytes", async () => {
  const directory = await root();
  const captured = await cacheContextAssets(directory, snapshot());
  captured.text = "Different acceptance requirements";
  await expect(hydrateContextAssets(directory, captured)).rejects.toThrow(StorageError);
  const bad = snapshot();
  bad.assets[0]!.data = Buffer.from("replacement bytes").toString("base64");
  await expect(cacheContextAssets(directory, bad)).rejects.toThrow(StorageError);
});
