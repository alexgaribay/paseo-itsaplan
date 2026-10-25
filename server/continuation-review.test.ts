import { expect, test } from "bun:test";
import { configSchema } from "../shared/config";
import type { SessionRecord } from "../shared/models";
import { captureProvenance, sourceFacts } from "./continuation";
import { ConfigurationError } from "./errors";
import { makePlan } from "./plan";

function source(description: string): SessionRecord {
  const config = configSchema.parse({ serverUrl: "https://plan.test", projects: { "7": { repository: "/configured", provider: "omp", model: "model", modeId: "ask", worktree: false } } });
  const project = config.projects["7"]!;
  const issue = { id: 42, projectId: 7, identifier: "TW-42", title: "Parser change", description };
  const intent = { version: 1 as const, source: "comment" as const, request: "Implement the parser change.", projectId: "7", sourceRunId: 1 };
  const systemPrompt = "Preserve operator instructions.";
  return {
    key: "run-1", kind: "run", externalId: 1, attempt: 1, serverUrl: config.serverUrl,
    issueId: 42, issueIdentifier: "TW-42", projectId: "7", agentId: "native-1", workspaceId: null,
    cwd: "/configured", provider: "omp", model: "model", modeId: "ask", phase: "finished",
    createdAt: 1, updatedAt: 2, eventOffset: 0, result: { status: "success" },
    evidence: { toolCallCount: 0, historyComplete: true },
    nativeLastUserMessageAt: "2026-10-25T00:00:00Z", projectMapping: project, taskIssue: issue, intent,
    task: { kind: "run", run: { id: 1, attempts: 1, trigger: "mention", prompt: intent.request, systemPrompt, issueId: 42, issueIdentifier: "TW-42" } },
    plan: makePlan(config, project, { provider: "omp", model: "model", modeId: "ask" }, { projectId: "7", issueId: 42, issueIdentifier: "TW-42" }),
    taskProvenance: captureProvenance(config, "bot-actor", intent, systemPrompt, issue),
  };
}

test.each([
  ["Do not\nuse tools.", "no-tools"],
  ["Do not\npost comments.", "no-posting"],
  ["Only\ninspect the parser.", "bounded-scope"],
])("multiline original requirement %s cannot authorize continuation or ticket posting", (description, restriction) => {
  const record = source(description);
  expect(record.taskProvenance!.restrictions).toContain(restriction);
  expect(() => sourceFacts(record)).toThrow(ConfigurationError);
});

test("the human scope review preserves readable original requirement line breaks", () => {
  const record = source("Preserve input ordering.\n\nValidate the empty-input boundary.");
  const facts = sourceFacts(record);
  expect(facts.requirements).toContain(record.taskIssue!.description!);
  expect(facts.task).toBe("Implement the parser change.");
});
