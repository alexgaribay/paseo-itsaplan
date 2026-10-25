import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectMapping } from "../shared/config";
import type { Issue } from "../shared/models";
import { contextLimits, developmentSchema, taskContextSnapshotSchema, type PersistedTaskContext, type TaskContextAsset, type TaskContextSnapshot } from "../shared/task-context";

const id = z.number().int().positive();
const text = z.string().max(contextLimits.responseBytes);
const reference = z.object({ id, identifier: text, title: text, archived: z.boolean() });
const checklist = z.object({ id, title: text, items: z.array(z.object({ id, content: text, done: z.boolean() })) });
const relation = z.object({ id, kind: z.enum(["blocks", "relates", "duplicates"]), direction: z.enum(["inward", "outward"]), issue: reference });
const development = developmentSchema.extend({ title: text, sourceBranch: text.nullable().optional(), targetBranch: text.nullable().optional(), issueId: id.optional(), projectId: id.optional() });
const details = z.object({ id, projectId: id, identifier: text, checklists: z.unknown().optional(), parent: z.unknown().optional(), subtasks: z.unknown().optional(), links: z.unknown().optional(), development: z.unknown().optional() });
const documentLink = z.object({ documentId: id, isPrivate: z.boolean(), archived: z.boolean() });
const documentBody = z.object({ id, projectId: id, title: text, content: text, isPrivate: z.boolean(), archivedAt: z.string().nullable() });
const attachment = z.object({ id: z.string().uuid(), filename: z.string().max(500), contentType: z.string().max(200), sizeBytes: z.number().int().nonnegative() });
const attachmentView = z.object({
  images: z.array(z.object({ id: z.string().uuid(), filename: z.string().max(500), contentType: z.string().max(200), data: z.string().max(Math.ceil(contextLimits.assetBytes / 3) * 4) })).max(1),
  others: z.array(attachment.extend({ text: text.optional() })).max(1),
});

type ReadContext = <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) => Promise<T>;
type Section = { heading: string; lines: string[] };
export type TaskContextCollectionOptions = { projectReference?: string; redact?: readonly string[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function taskContextDigest(snapshot: TaskContextSnapshot | PersistedTaskContext | Omit<TaskContextSnapshot, "digest"> | Omit<PersistedTaskContext, "digest">): string {
  const { digest: _digest, assets, ...content } = snapshot as TaskContextSnapshot | PersistedTaskContext;
  const references = assets.map(({ id, filename, mimeType, digest }) => ({ id, filename, mimeType, digest }));
  return createHash("sha256").update(canonical({ ...content, assets: references })).digest("hex");
}

export function renderTaskContextSection(section: Section): string {
  return section.lines.length ? `## ${section.heading}\n${section.lines.join("\n")}` : "";
}

function assetPath(value: string): boolean {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Malformed escapes are handled as literal text. */ }
  return /\/(?:attachments|initiative-attachments|chat-attachments)\//i.test(decoded) || /\/documents\/[^/]+\/assets(?:\/|$)/i.test(decoded);
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || assetPath(url.pathname)) return null;
    if ([...url.searchParams.keys()].some((key) => /token|secret|key|auth|credential|signature|password/i.test(key))) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function redactText(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  return result
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`\)\]]+/gi, (url) => safeUrl(url) ?? "[redacted URL]")
    .replace(/\/(?:attachments|initiative-attachments|chat-attachments)\/[^\s<>"'`\)\]]+/gi, "[redacted asset URL]")
    .replace(/\/projects\/[^\s/]+\/documents\/[^\s/]+\/assets\/[^\s<>"'`\)\]]+/gi, "[redacted asset URL]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, "[redacted token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;]+["']?/gi, "$1=[redacted]");
}

export function imageMatches(bytes: Buffer, mimeType: TaskContextAsset["mimeType"]): boolean {
  switch (mimeType) {
    case "image/png": return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR";
    case "image/jpeg": return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    case "image/gif": return bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
    case "image/webp": return bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16));
  }
}

class ContextBudgetError extends Error {}
class ContextIdentityError extends Error {}

export async function collectTaskContext(
  issue: Issue,
  project: ProjectMapping,
  read: ReadContext,
  signal?: AbortSignal,
  options: TaskContextCollectionOptions = {},
): Promise<TaskContextSnapshot> {
  signal?.throwIfAborted();
  const capturedAt = Date.now();
  const sections: Section[] = [];
  const warnings: string[] = [];
  const assets: TaskContextAsset[] = [];
  const links: TaskContextSnapshot["development"] = [];
  const secrets = options.redact ?? [];
  let chars = 0;
  let responseBytes = 0;
  let assetBytes = 0;
  let redacted = false;
  const warn = (message: string) => {
    const sanitized = redactText(message, secrets).slice(0, 1000);
    if (!warnings.includes(sanitized) && warnings.length < 99) warnings.push(sanitized);
  };
  const clean = (value: string) => {
    const result = redactText(value, secrets);
    if (result !== value) redacted = true;
    return result;
  };
  const add = (heading: string, lines: string[]) => {
    const section = { heading: clean(heading), lines: lines.map(clean) };
    const rendered = renderTaskContextSection(section);
    if (!rendered) return;
    const separator = sections.length ? 2 : 0;
    const remaining = contextLimits.chars - chars - separator;
    if (rendered.length > remaining) {
      warn("Context text was truncated at the character limit.");
      if (remaining <= section.heading.length + 4) return;
      const prefix = `## ${section.heading}\n`;
      section.lines = [rendered.slice(prefix.length, remaining)];
    }
    sections.push(section);
    chars += renderTaskContextSection(section).length + separator;
  };
  const finish = (): TaskContextSnapshot => {
    if (assets.length) warn("Images are attached through Paseo. Model image support is not exposed by the SDK; unsupported models may receive only a local-file reference, not image content.");
    if (redacted) warn("Known credentials and public asset URLs were redacted. This is not a complete secret scan.");
    const content = { version: 1 as const, issueId: issue.id, projectId: issue.projectId, capturedAt, text: sections.map(renderTaskContextSection).join("\n\n"), warnings, development: links, assets };
    return taskContextSnapshotSchema.parse({ ...content, digest: taskContextDigest(content) });
  };
  const enabled = project.taskContext;
  if (!enabled?.enabled) return finish();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Context deadline exceeded", "TimeoutError")), contextLimits.timeoutMs);
  const joined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    joined.throwIfAborted();
    if (responseBytes >= contextLimits.responseBytes) throw new ContextBudgetError();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(joined.reason);
      joined.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => { joined.throwIfAborted(); return read(path, z.unknown(), joined); }).then(resolve, reject).finally(() => joined.removeEventListener("abort", abort));
    });
    joined.throwIfAborted();
    responseBytes += Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
    if (responseBytes > contextLimits.responseBytes) throw new ContextBudgetError();
    return schema.parse(raw);
  };
  const optional = async <T>(label: string, action: () => Promise<T> | T): Promise<T | undefined> => {
    try { joined.throwIfAborted(); return await action(); }
    catch (error) {
      signal?.throwIfAborted();
      if (deadline.signal.aborted) warn("Optional context collection reached its time limit.");
      else if (error instanceof ContextBudgetError) warn("Optional context collection reached its response byte limit.");
      else if (error instanceof ContextIdentityError) warn(`${label} was omitted because its source identity did not match.`);
      else {
        const status = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
        if (status === 401 || status === 403) warn(`${label} access was denied.`);
        else if (status === 404 || status === 405 || status === 501) warn(`${label} is unavailable or unsupported.`);
        else warn(`${label} could not be read safely.`);
      }
      return undefined;
    }
  };
  const bounded = <T>(items: T[], count: number, label: string): T[] => {
    if (items.length > count) warn(`${label} was truncated at the item limit.`);
    return items.slice(0, count);
  };
  try {
    const source = await optional("Issue context", async () => {
      const value = await get(`/issues/${issue.id}`, details);
      if (value.id !== issue.id || value.projectId !== issue.projectId || value.identifier !== issue.identifier) throw new ContextIdentityError();
      return value;
    });
    if (!source) return finish();
    if (enabled.checklists) await optional("Checklists", () => {
      const lists = bounded(z.array(checklist).parse(source.checklists), contextLimits.relations, "Checklists");
      let remaining = contextLimits.relations;
      for (const list of lists) {
        const items = bounded(list.items, remaining, "Checklist items");
        remaining -= items.length;
        add("Checklist", [list.title, ...items.map((item) => `- [${item.done ? "x" : " "}] ${item.content}`)]);
      }
    });
    if (enabled.relations) await optional("Relations", () => {
      const parent = reference.nullable().parse(source.parent);
      const children = z.array(reference).parse(source.subtasks);
      const relations = z.array(relation).parse(source.links);
      const rows = [
        ...(parent ? [{ kind: "Parent", issue: parent }] : []),
        ...children.map((child) => ({ kind: "Subtask", issue: child })),
        ...relations.map((link) => ({ kind: link.kind === "relates" || link.direction === "outward" ? link.kind : link.kind === "blocks" ? "blocked_by" : "duplicated_by", issue: link.issue })),
      ];
      add("Related work", bounded(rows, contextLimits.relations, "Relations").map((row) => `${row.kind}: ${row.issue.identifier} ${row.issue.title}${row.issue.archived ? " [archived]" : ""}`));
    });
    if (enabled.development) await optional("Development", () => {
      const items = bounded(z.array(development).parse(source.development), contextLimits.relations, "Development");
      if (items.some((item) => (item.issueId !== undefined && item.issueId !== issue.id) || (item.projectId !== undefined && item.projectId !== issue.projectId))) throw new ContextIdentityError();
      for (const item of items) {
        const url = safeUrl(item.url);
        if (url !== item.url) warn("Unsafe development URLs or URL credentials were omitted.");
        const sanitized = clean(url ?? "");
        const entry = { id: item.id, provider: clean(item.provider).slice(0, 100), kind: clean(item.kind).slice(0, 100), title: clean(item.title).slice(0, 2000), state: clean(item.state).slice(0, 100), url: sanitized && !sanitized.includes("[redacted") ? sanitized : null, sourceBranch: item.sourceBranch == null ? null : clean(item.sourceBranch).slice(0, 500), targetBranch: item.targetBranch == null ? null : clean(item.targetBranch).slice(0, 500) };
        links.push(entry);
      }
      add("Development", links.map((link) => `${link.provider} ${link.kind}: ${link.title} [${link.state}]${link.sourceBranch ? ` (${link.sourceBranch}${link.targetBranch ? ` -> ${link.targetBranch}` : ""})` : ""}${link.url ? ` ${link.url}` : ""}`));
    });
    if (enabled.documents) await optional("Linked documents", async () => {
      let projectReference = options.projectReference;
      if (projectReference === undefined) {
        const page = await get(`/projects/search?ids=${issue.projectId}&page=1&pageSize=100`, z.object({
          items: z.array(z.object({ id, ref: z.string().min(1).max(200) })).max(100),
          total: z.number().int().nonnegative(), page: id, pageSize: id.max(100),
        }));
        if (page.page !== 1 || page.pageSize !== 100 || page.total !== 1 || page.items.length !== 1 || page.items[0]!.id !== issue.projectId) throw new ContextIdentityError();
        projectReference = page.items[0]!.ref;
      }
      if (projectReference.length > 200 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(projectReference)) throw new ContextIdentityError();
      const base = `/projects/${encodeURIComponent(projectReference)}/documents`;
      const documents = await get(`${base}/for-issue/${issue.id}`, z.array(documentLink));
      const seen = new Set<number>();
      for (const link of bounded(documents, contextLimits.documents, "Linked documents")) {
        if (link.isPrivate) { warn("Private linked documents were omitted without reading their content."); continue; }
        if (link.archived) { warn("Archived linked documents were omitted."); continue; }
        if (seen.has(link.documentId)) continue;
        seen.add(link.documentId);
        if (chars >= contextLimits.chars) { warn("Linked documents were truncated at the character limit."); break; }
        await optional("Linked document", async () => {
          const document = await get(`${base}/${link.documentId}`, documentBody);
          if (document.id !== link.documentId || document.projectId !== issue.projectId) throw new ContextIdentityError();
          if (document.isPrivate || document.archivedAt !== null) { warn("A linked document became private or archived and was omitted."); return; }
          add("Linked document", [document.title, document.content]);
        });
      }
    });
    if (enabled.attachments) await optional("Attachments", async () => {
      const items = await get(`/issues/${issue.id}/attachments`, z.array(attachment));
      const seen = new Set<string>();
      for (const item of bounded(items, contextLimits.assets, "Attachments")) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const mime = item.contentType.toLowerCase().split(";")[0]!.trim();
        const imageMime = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).safeParse(mime);
        const readable = mime === "application/pdf" || mime.startsWith("text/");
        if (!imageMime.success && !readable) { warn("An attachment has an unsupported content type and was omitted."); continue; }
        if (item.sizeBytes <= 0 || item.sizeBytes > contextLimits.assetBytes || item.sizeBytes + assetBytes > contextLimits.totalAssetBytes) { warn("An attachment was omitted at the asset byte limit."); continue; }
        if (!imageMime.success && chars >= contextLimits.chars) { warn("Attachment text was truncated at the character limit."); continue; }
        assetBytes += item.sizeBytes;
        await optional("Attachment", async () => {
          const view = await get(`/attachments/view?attachment=${encodeURIComponent(item.id)}`, attachmentView);
          if (view.images.length + view.others.length !== 1) throw new ContextIdentityError();
          const body = view.images[0] ?? view.others[0]!;
          if (body.id !== item.id || body.filename !== item.filename || body.contentType !== item.contentType || ("sizeBytes" in body && body.sizeBytes !== item.sizeBytes)) throw new ContextIdentityError();
          if (imageMime.success) {
            if (!("data" in body)) { warn("An image attachment could not be delivered as an authenticated image."); return; }
            const data = body.data;
            if (!data || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) { warn("An image attachment had invalid base64 data and was omitted."); return; }
            const bytes = Buffer.from(data, "base64");
            if (bytes.toString("base64") !== data || bytes.length !== item.sizeBytes || bytes.length > contextLimits.assetBytes || !imageMatches(bytes, imageMime.data)) { warn("An image attachment failed byte, size, or MIME verification and was omitted."); return; }
            assets.push({ id: item.id, filename: clean(item.filename).slice(0, 500), mimeType: imageMime.data, data, digest: createHash("sha256").update(bytes).digest("hex") });
          } else if ("text" in body && typeof body.text === "string" && body.text.trim()) {
            add("Attachment text", [item.filename, body.text]);
          } else warn(mime === "application/pdf" ? "A PDF attachment had no readable text. Scanned images were not transcribed." : "An attachment had no readable text and was omitted.");
        });
      }
    });
    signal?.throwIfAborted();
    return finish();
  } finally { clearTimeout(timer); }
}
