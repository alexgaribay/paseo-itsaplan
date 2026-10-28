import { expect, test } from "bun:test";
import { defaults, projectMappingSchema, selectionSchema } from "../shared/config";
import { executionPreferences, makePlan, resolvePreferences } from "./plan";

test("changing providers does not inherit another provider's model or permission mode", () => {
  const config = { ...defaults(), defaultProvider: "codex", defaultModel: "codex-model", defaultModeId: "codex-mode" };
  const project = projectMappingSchema.parse({ provider: "omp", model: "omp-model", modeId: "ask" });
  expect(resolvePreferences(config, project, { provider: "claude" })).toEqual({ selection: { provider: "claude", model: "", modeId: "" }, sources: { provider: "issue", model: "provider", mode: "provider" } });
});

test("selection tracks independent compatible issue, project and global sources", () => {
  const config = { ...defaults(), defaultProvider: "omp", defaultModel: "global-model", defaultModeId: "ask" };
  const project = projectMappingSchema.parse({ provider: "omp", model: "project-model" });
  expect(resolvePreferences(config, project, { model: "issue-model" })).toEqual({ selection: { provider: "omp", model: "issue-model", modeId: "ask" }, sources: { provider: "project", model: "issue", mode: "global" } });
  expect(resolvePreferences(config, project, { modeId: "approve" }, "manual").sources).toEqual({ provider: "project", model: "project", mode: "manual" });
});

test("preview keeps an unpinned model explicitly unresolved", () => {
  const config = defaults();
  const project = projectMappingSchema.parse({ repository: "/configured/repository", provider: "omp" });
  const plan = makePlan(config, project, resolvePreferences(config, project).selection, { projectId: "7", issueId: 1, issueIdentifier: "TW-1" });
  expect(plan).toMatchObject({ selection: { model: "" }, sources: { model: "provider" }, defaultModelUnresolved: true, noToolsEnforcement: "instruction-only" });
});

test("named profile previews identify authoritative configuration rather than shared override sources", () => {
  const config = { ...defaults(), profileId: "worker", defaultProvider: "different-provider" };
  const project = projectMappingSchema.parse({ repository: "/configured/repository", provider: "shared-project-provider" });
  const selection = { profileId: "worker", profileName: "Careful worker", provider: "omp", model: "model", modeId: "ask", thinkingOptionId: "deep", featureValues: { sandbox: true } };
  const plan = makePlan(config, project, selection, { projectId: "7", issueId: 1, issueIdentifier: "TW-1", sources: { provider: "manual", model: "issue", mode: "project" } });
  expect(plan.selection).toEqual({ profileId: "worker", profileName: "Careful worker", provider: "omp", model: "model", modeId: "ask", thinkingOptionId: "deep", featureValues: { sandbox: true } });
  expect(plan.sources).toEqual({ provider: "provider", model: "provider", mode: "provider" });
  expect(plan.warnings.join("\n")).toContain('Named Paseo profile "Careful worker" (worker)');
});

test("named profile execution bypasses stale issue-field preferences before gateway resolution", async () => {
  const config = { ...defaults(), profileId: "worker", defaultProvider: "ignored-global" };
  const project = projectMappingSchema.parse({ provider: "ignored-project", fieldBindings: [{ projectId: 7, issueTypeId: null, fieldId: 2, optionId: 3, provider: "stale-provider" }] });
  const preferences = await executionPreferences({ issueSelection: async () => { throw new Error("Stale field bindings must not block a named profile"); } }, config, project, { id: 1, projectId: 7, identifier: "TW-1", title: "Issue" }, { provider: "ignored-manual" });
  expect(preferences).toEqual({ selection: { provider: "", model: "", modeId: "" }, sources: { provider: "provider", model: "provider", mode: "provider" } });
});

test("legacy captured selections do not gain optional profile bundle fields", () => {
  expect(selectionSchema.parse({ provider: "omp", model: "model", modeId: "ask" })).toEqual({ provider: "omp", model: "model", modeId: "ask" });
});
