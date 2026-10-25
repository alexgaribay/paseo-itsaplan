import { expect, test } from "bun:test";
import { defaults, projectMappingSchema } from "../shared/config";
import { makePlan, resolvePreferences } from "./plan";

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
