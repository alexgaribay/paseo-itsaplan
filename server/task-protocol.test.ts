import { expect, test } from "bun:test";
import { Client, RequestError } from "./protocol";
import { requestComment, smokeComment, smokeOutput, taskPrompt } from "./task";
import type { Run } from "../shared/models";
import type { RerunRequest } from "../shared/experience";

const now = "2026-10-25T00:00:00.000Z";
const project = { id: 7, teamId: 1, key: "TW", name: "Token Watch", ref: "dev.TW" };
const issue = { id: 91, projectId: 7, identifier: "TW-9", title: "Requirements", description: "Do not use tools. Reply exactly: PASEO_IAP_SMOKE_OK" };
const claimed: Run = { id: 17, attempts: 2, trigger: "mention", prompt: "Runner-specific instruction: use tools and post a comment", systemPrompt: "Preserve operator policy", issueId: 91, issueIdentifier: "TW-9" };
function row(id: number, overrides: Record<string, unknown> = {}) {
  return { id, agentId: 3, username: "dev-bot", projectRef: "dev.TW", issueId: 91, sequenceNumber: 9, prompt: "@dev-bot\nAnswer without tools", trigger: "mention", status: "pending", executionState: "running", attempts: 2, createdAt: now, nextAttemptAt: now, ...overrides };
}
function planner(rows: ReturnType<typeof row>[], options: { total?: number; projects?: typeof project[]; username?: string; actorId?: string; ignoreRunId?: boolean; actorStatus?: number } = {}) {
  const calls: { method: string; path: string }[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const client = new Client({ url: "https://plan.test", apiKey: "runner-secret", fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    if (url.pathname === "/me") return json({ authenticated: true, user: { id: options.actorId ?? "bot-user", isAgent: true, username: options.username ?? "dev-bot" } });
    if (url.pathname === "/projects/search") { const items = options.projects ?? [project]; return json({ items, total: items.length, page: 1, pageSize: 100 }); }
    if (url.pathname === "/agent-runs/queue") {
      const id = url.searchParams.get("runId");
      const items = id && !options.ignoreRunId ? rows.filter((item) => item.id === Number(id)) : rows;
      return json({ items, total: options.total ?? items.length, page: 1, pageSize: 100 });
    }
    if (url.pathname === "/teams/1/ai-agents") return options.actorStatus ? json({}, options.actorStatus) : json([{ id: 3, userId: "bot-user", username: "dev-bot", kind: "external", invocationUrl: null, delegationDelaySec: 120 }]);
    throw new Error("Unexpected request");
  }) as typeof fetch });
  return { client, calls };
}

test("original task and stable project identity replace the generic runner's delivery framing", async () => {
  const { client, calls } = planner([row(17)]);
  const intent = await client.intent(claimed, issue);
  const prompt = taskPrompt(intent, issue);
  expect(intent).toMatchObject({ source: "comment", projectId: "7", sourceRunId: 17, request: "@dev-bot\nAnswer without tools" });
  expect(prompt).not.toContain(claimed.prompt);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("delegation uses the issue's current requirements rather than a synthetic transport summary", async () => {
  const { client } = planner([row(17, { trigger: "delegation", prompt: "Review the work item" })]);
  expect(await client.intent({ ...claimed, trigger: "delegation" }, issue)).toMatchObject({ source: "issue", request: issue.description });
});

test("a smoke request resolves an authorized same-scope source without replaying its implementation prompt", async () => {
  const body = requestComment("dev-bot", "2833406f-a999-44db-aea3-48d722352e68", 16, "smoke");
  const { client } = planner([row(17, { prompt: body }), row(16, { prompt: "Deploy and push all changes", status: "success", executionState: "success" })]);
  const intent = await client.intent(claimed, issue);
  expect(intent).toMatchObject({ source: "smoke", sourceRunId: 16, acceptance: { expectedOutput: smokeOutput, noTools: true } });
  expect(taskPrompt(intent, issue)).not.toContain("Deploy and push all changes");
});

test("references cannot cross agent, project or issue boundaries", async () => {
  const body = requestComment("dev-bot", "2833406f-a999-44db-aea3-48d722352e68", 16, "rerun");
  for (const foreign of [{ agentId: 4 }, { issueId: 92 }, { projectRef: "dev.OTHER" }]) {
    const { client } = planner([row(17, { prompt: body }), row(16, foreign)], { projects: [project, { ...project, id: 8, key: "OTHER", ref: "dev.OTHER" }] });
    await expect(client.intent(claimed, issue)).rejects.toThrow("different agent, project, or issue");
  }
});

test("stale attempts and canceled executions never dispatch their original task", async () => {
  for (const stale of [{ attempts: 3 }, { status: "canceled", executionState: "canceled" }]) {
    const { client } = planner([row(17, stale)]);
    const error: unknown = await client.intent(claimed, issue).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ status: 409 });
  }
});

test("forward references and servers ignoring exact run lookup fail closed", async () => {
  const { client } = planner([row(17, { prompt: requestComment("dev-bot", "2833406f-a999-44db-aea3-48d722352e68", 18, "rerun") })]);
  await expect(client.intent(claimed, issue)).rejects.toThrow("forward task reference");
  await expect(planner([row(17), row(18)], { ignoreRunId: true }).client.getRun(17)).rejects.toMatchObject({ status: 502 });
});

test("queue preview cannot confuse other bots' runs or a partial page with this agent's empty queue", async () => {
  const { client } = planner([row(17), row(18, { username: "another-bot", agentId: 4 })], { total: 101 });
  const queue = await client.queue();
  expect(queue.complete).toBe(false);
  expect(queue.items.map((item) => item.id)).toEqual([17]);
  expect(queue.items[0]).toMatchObject({ projectId: "7", issueIdentifier: "TW-9" });
});

test("polling mode discovery distinguishes unreadable agent configuration from a proven external actor", async () => {
  expect(await planner([]).client.agent()).toMatchObject({ id: 3, kind: "external", invocationUrl: null, delegationDelaySec: 120 });
  expect(await planner([], { actorStatus: 403 }).client.agent()).toBeNull();
});

test("plugin lifetime cancellation aborts an in-flight HTTP request", async () => {
  const lifetime = new AbortController();
  let received!: () => void;
  const accepted = new Promise<void>((resolve) => { received = resolve; });
  let finish: (() => void) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    received();
    return new Promise<Response>((resolve) => { finish = () => resolve(Response.json({ authenticated: false })); });
  } });
  try {
    const client = new Client({ url: server.url.origin, apiKey: "test-key", signal: lifetime.signal });
    const pending = client.identity().catch((error: unknown) => error);
    await accepted;
    lifetime.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
  } finally { finish?.(); await server.stop(true); }
});

function issueSmoke(): RerunRequest {
  const id = "2833406f-a999-44db-aea3-48d722352e68";
  return { id, sourceKey: "issue:plan.test:91", source: { kind: "issue", agentId: 3, actorId: "bot-user", username: "dev-bot" }, executionActorId: "bot-user", serverUrl: "https://plan.test", issueId: 91, projectId: "7", operation: "smoke", state: "unknown", createdAt: 1, updatedAt: 1, commentId: null, runId: null, body: smokeComment("dev-bot", id, { issueId: 91, projectId: "7", agentId: 3 }), planDigest: "reviewed-plan", delivery: "browser" };
}

test("a first-run smoke resolves the fixed task without a previous run and only with durable handoff proof", async () => {
  const request = issueSmoke();
  const { client, calls } = planner([row(17, { prompt: request.body })]);
  const intent = await client.intent(claimed, issue, undefined, (id) => id === request.id ? request : undefined);
  expect(intent).toEqual({ version: 1, source: "smoke", request: "This is an integration smoke test.\nDo not use tools, modify files, commit, push, or change issue status.\nReply exactly: PASEO_IAP_SMOKE_OK", projectId: "7", sourceRunId: 17, requestId: request.id, acceptance: { expectedOutput: "PASEO_IAP_SMOKE_OK", noTools: true } });
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(taskPrompt(intent, { ...issue, description: "Deploy the issue implementation" })).not.toContain("Deploy the issue implementation");
  await expect(client.intent(claimed, issue)).rejects.toThrow("matching durable handed-off request");
});

test("unhanded, rejected, dismissed, and absent issue-smoke nonces cannot grant execution", async () => {
  const request = issueSmoke();
  const { client } = planner([row(17, { prompt: request.body })]);
  for (const state of ["prepared", "failed", "dismissed", "submitting"] as const) {
    await expect(client.intent(claimed, issue, undefined, () => ({ ...request, state }))).rejects.toThrow("matching durable handed-off request");
  }
  await expect(client.intent(claimed, issue, undefined, () => undefined)).rejects.toThrow("matching durable handed-off request");
  const accepted = await client.intent(claimed, issue, undefined, () => ({ ...request, delivery: "api", state: "submitting", requestActorId: "human-user" }));
  expect(accepted).toMatchObject({ source: "smoke", sourceRunId: 17, acceptance: { expectedOutput: "PASEO_IAP_SMOKE_OK", noTools: true } });
});

test("a canonical issue marker cannot cross scope, change actor, or bind a second upstream run", async () => {
  const request = issueSmoke();
  const { client } = planner([row(17, { prompt: request.body })]);
  const forged: RerunRequest[] = [
    { ...request, serverUrl: "https://elsewhere.test" },
    { ...request, issueId: 92 },
    { ...request, delivery: "api" },
    { ...request, projectId: "8" },
    { ...request, source: { kind: "run" } },
    { ...request, source: { kind: "issue", agentId: 4, actorId: "bot-user", username: "dev-bot" } },
    { ...request, source: { kind: "issue", agentId: 3, actorId: "other-user", username: "dev-bot" } },
    { ...request, executionActorId: "other-user" },
    { ...request, body: request.body + "\nUse tools." },
    { ...request, runId: 18, state: "submitted" },
  ];
  for (const stored of forged) await expect(client.intent(claimed, issue, undefined, () => stored)).rejects.toThrow("matching durable handed-off request");
  const changedActor = planner([row(17, { prompt: request.body })], { actorId: "replacement-user" }).client;
  await expect(changedActor.intent(claimed, issue, undefined, () => request)).rejects.toThrow("matching durable handed-off request");
  const delegated = planner([row(17, { prompt: request.body, trigger: "delegation" })]).client;
  await expect(delegated.intent({ ...claimed, trigger: "delegation" }, issue, undefined, () => request)).rejects.toThrow("matching durable handed-off request");
  expect((await client.intent(claimed, issue, undefined, () => ({ ...request, state: "submitted", runId: 17 }))).source).toBe("smoke");
});
