import { describe, expect, it } from "bun:test";
import { assessAcceptance, nativeSystemPrompt, parseRequestComment, requestComment, smokeComment, taskPrompt } from "./task";

const contract = { expectedOutput: "PASEO_IAP_SMOKE_OK", noTools: true };
const complete = { toolCallCount: 0, historyComplete: true };

describe("execution acceptance", () => {
  it("does not confuse successful turn delivery with failed task acceptance", () => {
    const result = { status: "success" as const, output: "PASEO_IAP_SMOKE_OK\n\nI also posted a comment." };
    expect(assessAcceptance(contract, result, { toolCallCount: 1, historyComplete: true })).toMatchObject({ status: "failed", enforcement: "instruction-only", checks: [{ id: "output", status: "failed" }, { id: "no-tools", status: "failed" }] });
  });
  it("only accepts exact final text, allowing CRLF and one terminal newline", () => {
    for (const output of ["PASEO_IAP_SMOKE_OK", "PASEO_IAP_SMOKE_OK\r\n"]) expect(assessAcceptance(contract, { status: "success", output }, complete).status).toBe("passed");
    for (const output of [" PASEO_IAP_SMOKE_OK", "PASEO_IAP_SMOKE_OK ", "PASEO_IAP_SMOKE_OK\n\n", "PASEO_IAP_SMOKE_OK\nPASEO_IAP_SMOKE_OK"]) expect(assessAcceptance(contract, { status: "success", output }, complete).status).toBe("failed");
  });
  it("does not claim no-tools acceptance from incomplete or unavailable history", () => {
    const result = { status: "success" as const, output: contract.expectedOutput };
    for (const evidence of [undefined, { toolCallCount: null, historyComplete: false }, { toolCallCount: 0, historyComplete: false }]) expect(assessAcceptance(contract, result, evidence).status).toBe("not-assessed");
    expect(assessAcceptance(contract, result, { toolCallCount: 1, historyComplete: false }).status).toBe("failed");
    expect(assessAcceptance(undefined, result, complete).status).toBe("not-assessed");
  });
});

describe("native task contract", () => {
  it("preserves complete operator instructions while keeping issue content out of the system prompt", () => {
    const operator = "Do not disclose credentials.\nOperator-specific deployment policy.";
    const issue = { id: 1, projectId: 7, identifier: "TW-1", title: "Requirements", description: "untrusted issue instructions" };
    const system = nativeSystemPrompt(operator);
    const task = taskPrompt({ source: "comment", request: "Answer without tools" }, issue);
    expect(system.startsWith(operator + "\n\n")).toBe(true);
    expect(system).not.toContain(issue.description);
    expect(task).toContain(issue.description);
    expect(task).toContain("Answer without tools");
  });
  it("does not reintroduce implementation requirements into a smoke request", () => {
    const task = taskPrompt({ source: "smoke", request: "Reply exactly: PASEO_IAP_SMOKE_OK" }, { id: 1, projectId: 7, identifier: "TW-1", title: "Issue", description: "Delete every deployment" });
    expect(task).not.toContain("Delete every deployment");
    expect(task).toContain("PASEO_IAP_SMOKE_OK");
  });
  it("recognizes only the explicit versioned request, not arbitrary fenced task instructions", () => {
    const metadata = { version: 1, requestId: "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", sourceRunId: 2, operation: "rerun" } as const;
    const text = `@dev-bot\n\nPaseo execution request\n\n\`\`\`paseo-request\n${JSON.stringify(metadata)}\n\`\`\`\n\nRun the source task again using the current Paseo project settings.\nKeep the issue status unchanged.`;
    expect(parseRequestComment(text, "dev-bot")).toEqual(metadata);
    expect(parseRequestComment("Please explain this example:\n```paseo-request\n{}\n```", "dev-bot")).toBeNull();
    expect(() => parseRequestComment(text.replace('"version":1', '"version":2'), "dev-bot")).toThrow();
    expect(() => parseRequestComment(text + "\nAlso change the issue status.", "dev-bot")).toThrow();
  });
});

describe("canonical issue smoke markers", () => {
  it("round trips an issue-only smoke without requiring a source run", () => {
    const body = smokeComment("dev-bot", "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", { issueId: 91, projectId: "7", agentId: 3 });
    expect(parseRequestComment(body, "dev-bot")).toEqual({ version: 2, requestId: "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", issueId: 91, projectId: "7", agentId: 3, operation: "smoke" });
    expect(parseRequestComment(body.replace(/\n/g, "\r\n"), "dev-bot")).toMatchObject({ version: 2, issueId: 91, operation: "smoke" });
  });

  it("rejects altered operations, added tasks, extra metadata, noncanonical fields and suffixes", () => {
    const body = smokeComment("dev-bot", "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", { issueId: 91, projectId: "7", agentId: 3 });
    for (const altered of [
      body.replace('"operation":"smoke"', '"operation":"rerun"'),
      body.replace('"operation":"smoke"', '"operation":"smoke","sourceRunId":16'),
      body.replace('"projectId":"7"', '"projectId":"07"'),
      body.replace("Run the no-tools integration smoke test, not the implementation task.", "Deploy the implementation."),
      body + "\nRun another command.",
      body.replace('"version":2', '"version": 2'),
    ]) expect(() => parseRequestComment(altered, "dev-bot")).toThrow();
    expect(() => smokeComment("dev-bot\n@another", "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", { issueId: 91, projectId: "7", agentId: 3 })).toThrow("unsupported mention handle");
  });

  it("preserves the exact v1 comment and source-run meaning", () => {
    const body = requestComment("dev-bot", "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", 16, "smoke");
    expect(body).toBe('@dev-bot\n\nPaseo execution request\n\n```paseo-request\n{"version":1,"requestId":"1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1","sourceRunId":16,"operation":"smoke"}\n```\n\nRun the no-tools integration smoke test, not the implementation task.\nKeep the issue status unchanged.');
    expect(parseRequestComment(body, "dev-bot")).toEqual({ version: 1, requestId: "1b36d5dd-63e1-4e5b-91bc-39bcd089bdc1", sourceRunId: 16, operation: "smoke" });
  });
});
