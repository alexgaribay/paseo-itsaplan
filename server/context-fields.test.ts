import { expect, test } from "bun:test";
import { defaults, projectMappingSchema } from "../shared/config";
import { executionPreferences, makePlan } from "./plan";
import { Client } from "./protocol";

const issue = { id: 42, projectId: 7, identifier: "TW-42", title: "Implement selection" };
const binding = { projectId: 7, issueTypeId: null, fieldId: 12, optionId: 21, provider: "claude", model: "sonnet" };
const field = { id: 12, issueTypeId: null, name: "Agent", fieldType: "select", options: [{ id: 21, value: "Friendly name" }] };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function clientWith(options: { fields?: unknown; issue?: unknown; status?: number } = {}) {
  return new Client({ url: "https://planner.test/api", apiKey: "execution-secret", fetch: (async (url) => {
    const path = new URL(String(url)).pathname;
    if (options.status) return new Response("private diagnostics execution-secret", { status: options.status });
    if (path.endsWith("/issues/42")) return json(options.issue ?? { ...issue, typeId: 3, fields: [{ fieldId: 12, fieldType: "select", optionIds: [21] }] });
    if (path.endsWith("/projects/search")) return json({ items: [{ id: 7, key: "TW", name: "Team work", ref: "team.TW" }], total: 1, page: 1, pageSize: 100 });
    if (path.endsWith("/custom-fields")) return json(options.fields ?? [field]);
    throw new Error("Unexpected request");
  }) as typeof fetch });
}

test("field selection uses option IDs instead of renamed display labels", async () => {
  const mapping = projectMappingSchema.parse({ fieldBindings: [binding] });
  expect(await clientWith({ fields: [{ ...field, name: "Renamed", options: [{ id: 21, value: "Renamed option" }] }] }).issueSelection(issue, mapping)).toEqual({ provider: "claude", model: "sonnet" });
});

test("field selection rejects changed option, field type and wrong project", async () => {
  const mapping = projectMappingSchema.parse({ fieldBindings: [binding] });
  await expect(clientWith({ fields: [{ ...field, options: [{ id: 22, value: "Friendly name" }] }] }).issueSelection(issue, mapping)).rejects.toThrow("unavailable or changed type");
  await expect(clientWith({ fields: [{ ...field, fieldType: "text" }] }).issueSelection(issue, mapping)).rejects.toThrow("unavailable or changed type");
  await expect(clientWith().issueSelection(issue, projectMappingSchema.parse({ fieldBindings: [{ ...binding, projectId: 8 }] }))).rejects.toThrow("different project");
  await expect(clientWith({ issue: { ...issue, projectId: 8, typeId: 3, fields: [] } }).issueSelection(issue, mapping)).rejects.toMatchObject({ status: 502 });
});

test("type-scoped mappings do not apply to another issue type", async () => {
  const mapping = projectMappingSchema.parse({ fieldBindings: [{ ...binding, issueTypeId: 4 }] });
  expect(await clientWith().issueSelection(issue, mapping)).toEqual({});
  expect(await clientWith({ fields: [{ ...field, issueTypeId: 4 }], issue: { ...issue, typeId: 4, fields: [{ fieldId: 12, fieldType: "select", optionIds: [21] }] } }).issueSelection(issue, mapping)).toEqual({ provider: "claude", model: "sonnet" });
});

test("conflicting multi-select options block execution instead of choosing array order", async () => {
  const mapping = projectMappingSchema.parse({ fieldBindings: [binding, { ...binding, optionId: 22, provider: "codex", model: "gpt" }] });
  const client = clientWith({ fields: [{ ...field, fieldType: "multi_select", options: [{ id: 21, value: "Claude" }, { id: 22, value: "Codex" }] }], issue: { ...issue, typeId: 3, fields: [{ fieldId: 12, fieldType: "multi_select", optionIds: [21, 22] }] } });
  await expect(client.issueSelection(issue, mapping)).rejects.toThrow("conflicting providers or models");
});

test("configured field permission errors stay explicit instead of falling back", async () => {
  await expect(clientWith({ status: 403 }).issueSelection(issue, projectMappingSchema.parse({ fieldBindings: [binding] }))).rejects.toMatchObject({ status: 403, message: "It's a Plan request failed (HTTP 403)" });
});

test("manual, saved issue, field, project and global preferences retain compatible provenance", async () => {
  const config = { ...defaults(), defaultProvider: "codex", defaultModel: "global-gpt", defaultModeId: "global-mode", issueOverrides: { "42": { provider: "", model: "saved-sonnet", modeId: "" } } };
  const mapping = projectMappingSchema.parse({ provider: "codex", model: "project-gpt", modeId: "project-mode", fieldBindings: [binding] });
  const protocol = clientWith();
  const resolved = await executionPreferences(protocol, config, mapping, issue);
  expect(resolved).toEqual({ selection: { provider: "claude", model: "saved-sonnet", modeId: "" }, sources: { provider: "field", model: "issue", mode: "provider" } });
  const explicit = await executionPreferences(protocol, config, mapping, issue, { provider: "omp", model: "manual-model", modeId: "ask" });
  expect(explicit).toEqual({ selection: { provider: "omp", model: "manual-model", modeId: "ask" }, sources: { provider: "manual", model: "manual", mode: "manual" } });
  expect(makePlan(config, mapping, resolved.selection, { projectId: "7", issueId: 42, issueIdentifier: "TW-42", sources: resolved.sources }).sources).toEqual({ provider: "field", model: "issue", mode: "provider" });
});

test("off and unconfigured context and field settings stay absent after config parsing", () => {
  expect(projectMappingSchema.parse({})).toEqual({ provider: "", model: "", modeId: "", repository: "", workspaceId: "", automatic: false, worktree: true, baseBranch: "" });
  expect(projectMappingSchema.safeParse({ fieldBindings: [binding, binding] }).success).toBe(false);
});
