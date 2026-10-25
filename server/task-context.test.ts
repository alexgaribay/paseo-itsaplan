import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { projectMappingSchema } from "../shared/config";
import { persistedTaskContextSchema, taskContextSnapshotSchema, type TaskContextOptions, type TaskContextSnapshot } from "../shared/task-context";
import { collectTaskContext, taskContextDigest } from "./task-context";

const issue = { id: 42, projectId: 7, identifier: "TW-42", title: "Implement the change" };
const source = { ...issue, parent: null, subtasks: [], links: [], checklists: [], development: [] };
const configured = (options: Partial<TaskContextOptions> = {}) => projectMappingSchema.parse({ taskContext: { enabled: true, ...options } });
const assetId = "1b75347a-d213-47f3-8466-43e1c9c578c3";
const otherAssetId = "ee1969a8-e94a-4502-b182-e29aa755ca38";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64");
const asset = (overrides: Record<string, unknown> = {}) => ({ id: assetId, filename: "diagram.png", contentType: "image/png", sizeBytes: png.length, createdAt: "2026-01-01T00:00:00.000Z", url: `/attachments/${assetId}/raw`, ...overrides });
const image = (overrides: Record<string, unknown> = {}) => ({ id: assetId, filename: "diagram.png", contentType: "image/png", data: png.toString("base64"), ...overrides });
const doc = (overrides: Record<string, unknown> = {}) => ({ id: 9, projectId: 7, title: "Design", content: "Use the existing adapter.", isPrivate: false, archivedAt: null, ...overrides });
const ref = (id: number, title: string) => ({ id, identifier: `TW-${id}`, title, archived: false });
const dev = (overrides: Record<string, unknown> = {}) => ({ id: 3, issueId: 42, projectId: 7, provider: "github", kind: "pull_request", title: "Implement adapter", state: "open", url: "https://github.com/example/repo/pull/5", sourceBranch: "feature", targetBranch: "main", ...overrides });

function reader(routes: Record<string, unknown>, paths: string[] = []) {
  return async <T>(path: string, schema: z.ZodType<T>, _signal?: AbortSignal): Promise<T> => {
    paths.push(path);
    if (!(path in routes)) throw new Error(`Unexpected private route ${path}`);
    const value = routes[path];
    if (value instanceof Error) throw value;
    return schema.parse(value);
  };
}

function snapshot(overrides: Partial<TaskContextSnapshot> = {}): TaskContextSnapshot {
  return { version: 1, issueId: 42, projectId: 7, capturedAt: 100, digest: "0".repeat(64), text: "context", warnings: [], development: [], assets: [], ...overrides };
}

test("unconfigured and disabled context returns a valid empty snapshot without reads", async () => {
  const paths: string[] = [];
  for (const project of [projectMappingSchema.parse({}), configured({ enabled: false, attachments: true })]) {
    const result = await collectTaskContext(issue, project, reader({}, paths));
    expect(taskContextSnapshotSchema.parse(result)).toMatchObject({ version: 1, issueId: 42, projectId: 7, text: "", warnings: [], assets: [], development: [] });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(paths).toEqual([]);
});

test("renders checklists and direct relations without fetching related work", async () => {
  const paths: string[] = [];
  const result = await collectTaskContext(issue, configured({ checklists: true, relations: true }), reader({ "/issues/42": {
    ...source, checklists: [{ id: 1, title: "Acceptance", items: [{ id: 2, content: "Keep defaults", done: true }, { id: 3, content: "Handle failures", done: false }] }],
    parent: ref(10, "Parent task"), subtasks: [ref(43, "Child task")], links: [{ id: 4, kind: "blocks", direction: "inward", issue: ref(44, "Dependency") }],
  } }, paths));
  expect(result.text).toBe("## Checklist\nAcceptance\n- [x] Keep defaults\n- [ ] Handle failures\n\n## Related work\nParent: TW-10 Parent task\nSubtask: TW-43 Child task\nblocked_by: TW-44 Dependency");
  expect(result.warnings).toEqual([]);
  expect(paths).toEqual(["/issues/42"]);
});

test("malformed optional sections do not discard valid independent sections", async () => {
  const result = await collectTaskContext(issue, configured({ checklists: true, development: true }), reader({ "/issues/42": { ...source, checklists: [{ id: 1, title: "bad", items: [{ done: "yes", content: "private" }] }], development: [dev()] } }));
  expect(result.development).toEqual([{ id: 3, provider: "github", kind: "pull_request", title: "Implement adapter", state: "open", url: "https://github.com/example/repo/pull/5", sourceBranch: "feature", targetBranch: "main" }]);
  expect(result.warnings).toEqual(["Checklists could not be read safely."]);
  expect(result.text).not.toContain("private");
});

for (const mismatch of [{ id: 43 }, { projectId: 8 }, { identifier: "OTHER-42" }]) {
  test(`rejects mismatched source identity ${JSON.stringify(mismatch)}`, async () => {
    const paths: string[] = [];
    const result = await collectTaskContext(issue, configured({ checklists: true, attachments: true, documents: true }), reader({ "/issues/42": { ...source, ...mismatch } }, paths), undefined, { projectReference: "project-ref" });
    expect(result).toMatchObject({ text: "", assets: [], development: [], warnings: ["Issue context was omitted because its source identity did not match."] });
    expect(paths).toEqual(["/issues/42"]);
  });
}

test("reads only explicitly linked public documents and checks body identity", async () => {
  const paths: string[] = [];
  const result = await collectTaskContext(issue, configured({ documents: true }), reader({
    "/issues/42": source,
    "/projects/project-ref/documents/for-issue/42": [{ documentId: 9, isPrivate: false, archived: false }, { documentId: 10, isPrivate: true, archived: false }, { documentId: 11, isPrivate: false, archived: true }, { documentId: 12, isPrivate: false, archived: false }],
    "/projects/project-ref/documents/9": doc(),
    "/projects/project-ref/documents/12": doc({ id: 12, projectId: 8, content: "Other project's private body" }),
  }, paths), undefined, { projectReference: "project-ref" });
  expect(result.text).toBe("## Linked document\nDesign\nUse the existing adapter.");
  expect(result.warnings).toEqual(["Private linked documents were omitted without reading their content.", "Archived linked documents were omitted.", "Linked document was omitted because its source identity did not match."]);
  expect(paths).toEqual(["/issues/42", "/projects/project-ref/documents/for-issue/42", "/projects/project-ref/documents/9", "/projects/project-ref/documents/12"]);
});

for (const body of [doc({ id: 100 }), doc({ isPrivate: true }), doc({ archivedAt: "2026-01-01" })]) {
  test(`omits a document that changed identity or visibility ${JSON.stringify(body)}`, async () => {
    const result = await collectTaskContext(issue, configured({ documents: true }), reader({ "/issues/42": source, "/projects/TW/documents/for-issue/42": [{ documentId: 9, isPrivate: false, archived: false }], "/projects/TW/documents/9": body }), undefined, { projectReference: "TW" });
    expect(result.text).toBe("");
    expect(result.warnings).toEqual([body.id === 100 ? "Linked document was omitted because its source identity did not match." : "A linked document became private or archived and was omitted."]);
  });
}

test("resolves and verifies a document project reference inside the collector", async () => {
  const paths: string[] = [];
  const result = await collectTaskContext(issue, configured({ documents: true }), reader({
    "/issues/42": source,
    "/projects/search?ids=7&page=1&pageSize=100": { items: [{ id: 7, ref: "team.TW" }], total: 1, page: 1, pageSize: 100 },
    "/projects/team.TW/documents/for-issue/42": [{ documentId: 9, isPrivate: false, archived: false }],
    "/projects/team.TW/documents/9": doc(),
  }, paths));
  expect(result.text).toBe("## Linked document\nDesign\nUse the existing adapter.");
  expect(result.warnings).toEqual([]);
  expect(paths).toEqual(["/issues/42", "/projects/search?ids=7&page=1&pageSize=100", "/projects/team.TW/documents/for-issue/42", "/projects/team.TW/documents/9"]);
});

test("uses supplied team-qualified references without extra discovery", async () => {
  const paths: string[] = [];
  const result = await collectTaskContext(issue, configured({ documents: true }), reader({
    "/issues/42": source,
    "/projects/team.TW/documents/for-issue/42": [{ documentId: 9, isPrivate: false, archived: false }],
    "/projects/team.TW/documents/9": doc(),
  }, paths), undefined, { projectReference: "team.TW" });
  expect(result.text).toBe("## Linked document\nDesign\nUse the existing adapter.");
  expect(result.warnings).toEqual([]);
  expect(paths).toEqual(["/issues/42", "/projects/team.TW/documents/for-issue/42", "/projects/team.TW/documents/9"]);
});

test("wrong project search identities cannot route linked-document reads", async () => {
  const result = await collectTaskContext(issue, configured({ documents: true }), reader({
    "/issues/42": source,
    "/projects/search?ids=7&page=1&pageSize=100": { items: [{ id: 8, ref: "foreign-ref" }], total: 1, page: 1, pageSize: 100 },
  }));
  expect(result).toMatchObject({ text: "", warnings: ["Linked documents was omitted because its source identity did not match."] });
});

test("denied project-reference discovery leaves a safe document warning", async () => {
  const result = await collectTaskContext(issue, configured({ documents: true }), reader({
    "/issues/42": source,
    "/projects/search?ids=7&page=1&pageSize=100": Object.assign(new Error("private reference"), { status: 403 }),
  }));
  expect(result).toMatchObject({ text: "", warnings: ["Linked documents access was denied."] });
});

test("embeds authenticated verified images and extracted PDF or text without raw URLs", async () => {
  const paths: string[] = [];
  const pdf = asset({ id: otherAssetId, filename: "spec.pdf", contentType: "application/pdf", sizeBytes: 400 });
  const result = await collectTaskContext(issue, configured({ attachments: true }), reader({
    "/issues/42": source, "/issues/42/attachments": [asset(), pdf],
    [`/attachments/view?attachment=${assetId}`]: { images: [image()], others: [] },
    [`/attachments/view?attachment=${otherAssetId}`]: { images: [], others: [{ ...pdf, text: "The adapter must preserve defaults." }] },
  }, paths));
  expect(result.assets).toEqual([{ id: assetId, filename: "diagram.png", mimeType: "image/png", data: png.toString("base64"), digest: createHash("sha256").update(png).digest("hex") }]);
  expect(result.text).toBe("## Attachment text\nspec.pdf\nThe adapter must preserve defaults.");
  expect(result.warnings).toEqual(["Images are attached through Paseo. Model image support is not exposed by the SDK; unsupported models may receive only a local-file reference, not image content."]);
  expect(result.digest).toBe(taskContextDigest(result));
  expect(taskContextDigest({ ...result, warnings: [] })).not.toBe(result.digest);
  expect(JSON.stringify(result)).not.toContain("/raw");
  expect(paths).toEqual(["/issues/42", "/issues/42/attachments", `/attachments/view?attachment=${assetId}`, `/attachments/view?attachment=${otherAssetId}`]);
});

for (const invalid of [image({ id: otherAssetId }), image({ filename: "other.png" }), image({ contentType: "image/jpeg" }), image({ data: "%%%=" }), image({ data: Buffer.from("not a png").toString("base64") }), image({ data: png.subarray(0, -1).toString("base64") }), image({ data: png.toString("base64").replace(/=$/, "") })]) {
  test(`rejects untrusted image identity or bytes ${JSON.stringify(invalid)}`, async () => {
    const result = await collectTaskContext(issue, configured({ attachments: true }), reader({ "/issues/42": source, "/issues/42/attachments": [asset()], [`/attachments/view?attachment=${assetId}`]: { images: [invalid], others: [] } }));
    expect(result.assets).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/source identity did not match|invalid base64|failed byte, size, or MIME verification/);
  });
}

test("rejects matching size and MIME when image magic does not match", async () => {
  const fake = Buffer.alloc(png.length, 65);
  const result = await collectTaskContext(issue, configured({ attachments: true }), reader({ "/issues/42": source, "/issues/42/attachments": [asset()], [`/attachments/view?attachment=${assetId}`]: { images: [image({ data: fake.toString("base64") })], others: [] } }));
  expect(result).toMatchObject({ assets: [], warnings: ["An image attachment failed byte, size, or MIME verification and was omitted."] });
});

test("rejects attachment view substitution, mixed results and text size changes", async () => {
  const plain = asset({ contentType: "text/plain", filename: "notes.txt", sizeBytes: 20 });
  for (const view of [{ images: [], others: [{ ...plain, id: otherAssetId, text: "Substituted" }] }, { images: [image()], others: [plain] }, { images: [], others: [{ ...plain, sizeBytes: 19, text: "Changed" }] }]) {
    const result = await collectTaskContext(issue, configured({ attachments: true }), reader({ "/issues/42": source, "/issues/42/attachments": [plain], [`/attachments/view?attachment=${assetId}`]: view }));
    expect(result).toMatchObject({ text: "", assets: [], warnings: ["Attachment was omitted because its source identity did not match."] });
  }
});

test("unsupported files and scanned PDFs produce explicit missing-context warnings", async () => {
  const pdf = asset({ id: otherAssetId, filename: "scan.pdf", contentType: "application/pdf", sizeBytes: 100 });
  const result = await collectTaskContext(issue, configured({ attachments: true }), reader({ "/issues/42": source, "/issues/42/attachments": [asset({ contentType: "image/svg+xml" }), pdf], [`/attachments/view?attachment=${otherAssetId}`]: { images: [], others: [{ ...pdf, text: "" }] } }));
  expect(result).toMatchObject({ text: "", assets: [], warnings: ["An attachment has an unsupported content type and was omitted.", "A PDF attachment had no readable text. Scanned images were not transcribed."] });
});

test("redacts configured credentials, known tokens, public assets and credential URLs before digest", async () => {
  const secret = "opaque-runner-credential";
  const token = "ghp_123456789012345678901234567890";
  const result = await collectTaskContext(issue, configured({ checklists: true, development: true, attachments: true }), reader({
    "/issues/42": { ...source, checklists: [{ id: 1, title: `Do ${secret}`, items: [{ id: 2, done: false, content: `${token} /attachments/${assetId}/raw https://host/attachments/${assetId}/raw https://user:pass@host/path https://host/path?access_token=hidden Bearer secretvalue` }] }], development: [dev({ title: secret, sourceBranch: secret, url: "https://github.com/example/repo/pull/5?access_token=hidden#private" }), dev({ id: 4, url: "https://github.com/example/repo/pull/6?view=checks#anchor" })] },
    "/issues/42/attachments": [asset({ filename: `${secret}.png` })], [`/attachments/view?attachment=${assetId}`]: { images: [image({ filename: `${secret}.png` })], others: [] },
  }), undefined, { redact: [secret] });
  const serialized = JSON.stringify(result);
  for (const forbidden of [secret, token, "/raw", "user:pass", "hidden", "secretvalue", "#private", "#anchor", "?view="]) expect(serialized).not.toContain(forbidden);
  expect(result.assets[0]?.filename).toBe("[redacted].png");
  expect(result.development[0]).toMatchObject({ title: "[redacted]", sourceBranch: "[redacted]", url: null });
  expect(result.development[1]?.url).toBe("https://github.com/example/repo/pull/6");
  expect(result.warnings).toContain("Known credentials and public asset URLs were redacted. This is not a complete secret scan.");
  expect(result.digest).toBe(taskContextDigest(result));
});

test("development identity mismatch cannot become trusted metadata", async () => {
  const result = await collectTaskContext(issue, configured({ development: true }), reader({ "/issues/42": { ...source, development: [dev({ issueId: 43 })] } }));
  expect(result).toMatchObject({ text: "", development: [], warnings: ["Development was omitted because its source identity did not match."] });
});

test("caps rendered characters and item counts with truncation evidence", async () => {
  const result = await collectTaskContext(issue, configured({ checklists: true, relations: true }), reader({ "/issues/42": { ...source, checklists: [{ id: 1, title: "Long", items: [{ id: 2, done: false, content: "x".repeat(60_000) }] }], subtasks: Array.from({ length: 31 }, (_, index) => ref(index + 100, "Child")) } }));
  expect(result.text.length).toBe(48_000);
  expect(result.text.slice(0, 25)).toBe("## Checklist\nLong\n- [ ] x");
  expect(result.warnings).toContain("Context text was truncated at the character limit.");
  expect(result.warnings).toContain("Relations was truncated at the item limit.");
});

test("limits linked-document reads and does not traverse document parents", async () => {
  const routes: Record<string, unknown> = { "/issues/42": source, "/projects/TW/documents/for-issue/42": Array.from({ length: 9 }, (_, index) => ({ documentId: index + 1, isPrivate: false, archived: false })) };
  for (let index = 1; index <= 8; index++) routes[`/projects/TW/documents/${index}`] = doc({ id: index, parentId: 999, content: `Body ${index}` });
  const paths: string[] = [];
  const result = await collectTaskContext(issue, configured({ documents: true }), reader(routes, paths), undefined, { projectReference: "TW" });
  expect(result.text).toContain("Body 8");
  expect(result.text).not.toContain("Body 9");
  expect(result.warnings).toEqual(["Linked documents was truncated at the item limit."]);
  expect(paths.length).toBe(10);
  expect(paths.some((path) => path.endsWith("/999"))).toBe(false);
});

test("caps individual and cumulative asset bytes before requesting content", async () => {
  const items = Array.from({ length: 5 }, (_, index) => asset({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, filename: `file${index}.txt`, contentType: "text/plain", sizeBytes: index === 0 ? 2_000_001 : 2_000_000 }));
  const routes: Record<string, unknown> = { "/issues/42": source, "/issues/42/attachments": items };
  for (const item of items.slice(1, 4)) routes[`/attachments/view?attachment=${item.id}`] = { images: [], others: [{ ...item, text: item.filename }] };
  const paths: string[] = [];
  const result = await collectTaskContext(issue, configured({ attachments: true }), reader(routes, paths));
  expect(result.text).toContain("file3.txt");
  expect(result.text).not.toContain("file4.txt");
  expect(result.warnings).toEqual(["An attachment was omitted at the asset byte limit."]);
  expect(paths.length).toBe(5);
});

test("caps attachment count even when additional files are supported", async () => {
  const items = Array.from({ length: 7 }, (_, index) => asset({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, filename: `file${index}.txt`, contentType: "text/plain", sizeBytes: 10 }));
  const routes: Record<string, unknown> = { "/issues/42": source, "/issues/42/attachments": items };
  for (const item of items.slice(0, 6)) routes[`/attachments/view?attachment=${item.id}`] = { images: [], others: [{ ...item, text: item.filename }] };
  const result = await collectTaskContext(issue, configured({ attachments: true }), reader(routes));
  expect(result.text).toContain("file5.txt");
  expect(result.text).not.toContain("file6.txt");
  expect(result.warnings).toEqual(["Attachments was truncated at the item limit."]);
});

test("caps total response bytes even when each response fits the transport limit", async () => {
  const result = await collectTaskContext(issue, configured({ documents: true }), reader({
    "/issues/42": { ...source, unused: "x".repeat(4_100_000) },
    "/projects/TW/documents/for-issue/42": [{ documentId: 9, isPrivate: false, archived: false }],
    "/projects/TW/documents/9": doc({ content: "x".repeat(4_100_000) }),
  }), undefined, { projectReference: "TW" });
  expect(result).toMatchObject({ text: "", warnings: ["Optional context collection reached its response byte limit."] });
});

for (const [status, message] of [[403, "Attachments access was denied."], [404, "Attachments is unavailable or unsupported."], [500, "Attachments could not be read safely."]] as const) {
  test(`optional HTTP ${status} emits only a generic warning`, async () => {
    const error = Object.assign(new Error("private body https://user:password@host/secret"), { status });
    const result = await collectTaskContext(issue, configured({ attachments: true }), reader({ "/issues/42": source, "/issues/42/attachments": error }));
    expect(result).toMatchObject({ text: "", assets: [], warnings: [message] });
    expect(JSON.stringify(result)).not.toContain("private body");
  });
}

test("external cancellation propagates even when an optional read ignores its signal", async () => {
  const controller = new AbortController();
  const reason = new Error("Caller canceled");
  const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    if (path === "/issues/42") return schema.parse(source);
    controller.abort(reason);
    return new Promise<T>(() => {});
  };
  await expect(collectTaskContext(issue, configured({ attachments: true }), read, controller.signal)).rejects.toBe(reason);
});

test("already aborted callers cannot read or obtain even disabled context", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stop"));
  await expect(collectTaskContext(issue, projectMappingSchema.parse({}), reader({}), controller.signal)).rejects.toThrow("Stop");
});

test("the collection deadline bounds a reader that never settles", async () => {
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce(new Proxy(original, { apply: (target, receiver, args) => Reflect.apply(target, receiver, [args[0], 1, ...args.slice(2)]) }));
  const observed: { signal?: AbortSignal } = {};
  try {
    const result = await collectTaskContext(issue, configured({ attachments: true }), async <T>(_path: string, _schema: z.ZodType<T>, signal?: AbortSignal) => { observed.signal = signal; return new Promise<T>(() => {}); });
    expect(result).toMatchObject({ text: "", assets: [] });
    expect(observed.signal?.aborted).toBe(true);
  } finally { timer.mockRestore(); }
});

test("canonical digest binds metadata and image digests identically before and after external persistence", () => {
  const full = snapshot({ assets: [{ id: assetId, filename: "diagram.png", mimeType: "image/png", data: png.toString("base64"), digest: createHash("sha256").update(png).digest("hex") }] });
  const persisted = persistedTaskContextSchema.parse(full);
  const expected = createHash("sha256").update(JSON.stringify({ assets: [{ digest: createHash("sha256").update(png).digest("hex"), filename: "diagram.png", id: assetId, mimeType: "image/png" }], capturedAt: 100, development: [], issueId: 42, projectId: 7, text: "context", version: 1, warnings: [] })).digest("hex");
  expect(taskContextDigest(full)).toBe(expected);
  expect(taskContextDigest(persisted)).toBe(expected);
  for (const changed of [snapshot({ text: "changed" }), snapshot({ issueId: 43 }), snapshot({ warnings: ["Missing context"] }), { ...full, assets: [{ ...full.assets[0]!, digest: "1".repeat(64) }] }]) expect(taskContextDigest(changed)).not.toBe(expected);
  expect(taskContextDigest({ ...full, digest: "2".repeat(64) })).toBe(expected);
});
