import { describe, expect, it, spyOn } from "bun:test";
import { AgentIdentityError, Client, RequestError, isAuthError, isLeaseError, isTransientError } from "./protocol";
import type { AgUiEvent, Run } from "../shared/models";
import { safeError } from "./engine";

const run: Run = {
  id: 17, attempts: 2, traceEvents: true, trigger: "manual", prompt: "Implement the change",
  systemPrompt: "Follow the project rules", issueId: 91, issueIdentifier: "PLAN-9",
};
const chat = { id: 18, threadId: "chat:4:human:thread", prompt: "Continue", systemPrompt: "Rules", sessionId: null };
const project = { id: 7, key: "PLAN", name: "Production", ref: "team.PLAN" };
const issue = { id: 91, projectId: 7, identifier: "PLAN-9", title: "Fix it", description: "Details", columnId: 3 };
const event: AgUiEvent = { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Hello" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Call = { url: URL; init: RequestInit; body: unknown };
function transport(reply: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(url)), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, client: new Client({ url: "https://planner.test/api/", apiKey: "runner-secret", fetch: fetcher }) };
}

describe("agent authentication", () => {
  it("probes the agent identity without claiming work or sending MCP credentials", async () => {
    const { client, calls } = transport(() => json({ authenticated: true, user: { id: "bot-user", isAgent: true } }));
    await client.test();
    expect(calls.map(({ url, init }) => ({ url: url.href, method: init.method, headers: init.headers, redirect: init.redirect, credentials: init.credentials }))).toEqual([{
      url: "https://planner.test/api/me", method: "GET", headers: { "x-api-key": "runner-secret" }, redirect: "error", credentials: "omit",
    }]);
  });
  it("rejects an unauthenticated identity", async () => {
    const anonymous = transport(() => json({ authenticated: false })).client;
    await expect(anonymous.test()).rejects.toMatchObject({ status: 401 });
  });
  it("distinguishes a non-agent account from a server authorization denial without exposing identity data", async () => {
    const personal = transport(() => json({ authenticated: true, user: { id: "private-user-identity", isAgent: false } })).client;
    const denied = transport(() => new Response("private server diagnostics runner-secret", { status: 403 })).client;
    const identityError: unknown = await personal.test().catch((error: unknown) => error);
    const serverError: unknown = await denied.test().catch((error: unknown) => error);
    expect(identityError).toBeInstanceOf(AgentIdentityError);
    expect(serverError).toBeInstanceOf(RequestError);
    expect(serverError).not.toBeInstanceOf(AgentIdentityError);
    expect(isAuthError(identityError)).toBe(true);
    expect(isTransientError(identityError)).toBe(false);
    expect(isAuthError(serverError)).toBe(true);
    expect(safeError(identityError)).not.toContain("private-user-identity");
    expect(safeError(identityError)).not.toContain("runner-secret");
    expect(safeError(serverError)).not.toContain("private server diagnostics");
    expect(safeError(new RequestError(403, "untrusted runner-secret response"))).not.toContain("runner-secret");
  });
  it("rejects unsafe URLs and blank or header-injecting credentials", () => {
    for (const url of ["http://remote.test", "https://user:secret@planner.test", "https://planner.test?key=secret", "https://planner.test#secret", "file:///tmp/key"]) {
      expect(() => new Client({ url, apiKey: "secret" })).toThrow(RequestError);
    }
    for (const apiKey of ["", "  ", "secret\r\nx-extra: value"]) {
      expect(() => new Client({ url: "https://planner.test", apiKey })).toThrow(RequestError);
    }
    expect(new Client({ url: "http://127.0.0.1:3000", apiKey: "local-key" })).toBeInstanceOf(Client);
  });
});

describe("claims and response validation", () => {
  it("validates both claim envelopes and discards unknown wire fields", async () => {
    const { client, calls } = transport((_call, index) => json(index === 0 ? { run: { ...run, ignored: "wire-only" } } : { message: { ...chat, attempts: 3 } }));
    expect(await client.claim()).toEqual(run);
    expect(await client.claimChat()).toEqual({ ...chat, attempts: 3 });
    expect(calls.map(({ url, init, body }) => ({ path: url.pathname, method: init.method, body }))).toEqual([
      { path: "/api/agent-runs/claim", method: "POST", body: undefined },
      { path: "/api/agent-chats/claim", method: "POST", body: undefined },
    ]);
  });
  it("accepts an explicitly empty queue and rejects invalid runs", async () => {
    expect(await transport(() => json({ run: null })).client.claim()).toBeNull();
    expect(await transport(() => json({ message: null })).client.claimChat()).toBeNull();
    for (const body of [{}, { run: { ...run, attempts: 0 } }, { run: { ...run, id: "17" } }, { run: { ...run, trigger: "unknown" } }, { run: { ...run, issueId: -1 } }]) {
      await expect(transport(() => json(body)).client.claim()).rejects.toMatchObject({ status: 502, message: "Invalid response from It's a Plan" });
    }
    await expect(transport(() => json({ message: { ...chat, threadId: "" } })).client.claimChat()).rejects.toMatchObject({ status: 502 });
    await expect(transport(() => json({ message: { ...chat, sessionId: 12 } })).client.claimChat()).rejects.toMatchObject({ status: 502 });
    await expect(transport(() => json({ message: { ...chat, attempts: 0 } })).client.claimChat()).rejects.toMatchObject({ status: 502 });
  });
  it("rejects malformed JSON and cancellation acknowledgments without leaking response data", async () => {
    await expect(transport(() => new Response("private runner-secret <html>")).client.claim()).rejects.toMatchObject({ status: 502, message: "Invalid response from It's a Plan" });
    await expect(transport(() => json({ canceled: "true", secret: "runner-secret" })).client.chatHeartbeat(18)).rejects.toMatchObject({ status: 502, message: "Invalid response from It's a Plan" });
  });
});

describe("request deadlines and cancellation", () => {
  it("uses the normal deadline and the longer chat claim deadline", async () => {
    const deadlines: number[] = [];
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      return new AbortController().signal;
    });
    try {
      const { client } = transport((_call, index) => json(index === 0 ? { run: null } : { message: null }));
      expect(await client.claim()).toBeNull();
      expect(await client.claimChat()).toBeNull();
      expect(deadlines).toEqual([30_000, 35_000]);
    } finally { timeout.mockRestore(); }
  });
  it("joins caller cancellation to the request and sanitizes the abort reason", async () => {
    const controller = new AbortController();
    const { client, calls } = transport((call) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      call.init.signal!.addEventListener("abort", () => reject(call.init.signal!.reason), { once: true });
      return promise;
    });
    const pending = client.claim(controller.signal);
    controller.abort(new Error("secret runner-secret"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "It's a Plan request canceled" });
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    await expect(client.claim(controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "It's a Plan request canceled" });
    expect(calls.length).toBe(1);
  });
  it("keeps cancellation active while reading the response body", async () => {
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    const { client } = transport((call) => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        call.init.signal!.addEventListener("abort", () => stream.error(new Error("runner-secret")), { once: true });
      },
      pull() { reading.resolve(); },
    })));
    const pending = client.claim(controller.signal);
    await reading.promise;
    controller.abort("private reason");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "It's a Plan request canceled" });
  });
  it("classifies a deadline as transient without echoing its reason", async () => {
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
    try {
      const { client } = transport((call) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        call.init.signal!.addEventListener("abort", () => reject(new Error("runner-secret")), { once: true });
        return promise;
      });
      const pending = client.claim();
      deadline.abort(new Error("secret deadline"));
      const error = await pending.catch((error: unknown) => error);
      expect(error).toMatchObject({ name: "TimeoutError", message: "It's a Plan request timed out" });
      expect(isTransientError(error)).toBe(true);
    } finally { timeout.mockRestore(); }
  });
});

describe("wire results and event batches", () => {
  it("preserves run output and attempt, but never sends output on chat result", async () => {
    const { client, calls } = transport(() => new Response(null, { status: 204 }));
    await client.report(17, { status: "success", output: "Implemented", attempt: 2, usage: { inputTokens: 12, outputTokens: 5 } });
    await client.chatResult(18, { status: "success", output: "Only chat events carry this", usage: null });
    await client.heartbeat(17, 2);
    await client.heartbeat(17);
    expect(calls.map(({ url, body }) => ({ path: url.pathname, body }))).toEqual([
      { path: "/api/agent-runs/17/result", body: { status: "success", output: "Implemented", attempt: 2, usage: { inputTokens: 12, outputTokens: 5 } } },
      { path: "/api/agent-chats/18/result", body: { status: "success", usage: null } },
      { path: "/api/agent-runs/17/heartbeat", body: { attempt: 2 } },
      { path: "/api/agent-runs/17/heartbeat", body: undefined },
    ]);
    await expect(client.report(17, { status: "success", usage: { inputTokens: 1.5, outputTokens: 2 } })).rejects.toMatchObject({ status: 400 });
  });
  it("sends ordered run batches with attempt, offset and only UUID session ids", async () => {
    const { client, calls } = transport(() => json({ nextOffset: 0, truncated: false }));
    const sessionId = "e3df571a-fcac-4ca3-9f9a-ec2af9cd1fe3";
    await client.runEvents(run, 5, Array.from({ length: 201 }, () => event), sessionId);
    await client.runEvents(run, 206, [event], "paseo-non-uuid");
    expect(calls.map(({ body }) => body)).toEqual([
      { attempt: 2, offset: 5, events: Array.from({ length: 200 }, () => event), sessionId },
      { attempt: 2, offset: 205, events: [event], sessionId },
      { attempt: 2, offset: 206, events: [event] },
    ]);
    await expect(client.runEvents(run, -1, [event])).rejects.toMatchObject({ status: 400 });
    await expect(client.runEvents(run, 0, [{ ...event, delta: "x".repeat(12_001) }])).rejects.toMatchObject({ status: 400 });
  });
  it("reports chat text through events and stops further batches when canceled", async () => {
    const { client, calls } = transport(() => json({ canceled: true }));
    expect(await client.chatEvents(18, Array.from({ length: 401 }, () => event), "paseo-session")).toBe(true);
    expect(calls.map(({ url, body }) => ({ path: url.pathname, body }))).toEqual([{
      path: "/api/agent-chats/18/events", body: { events: Array.from({ length: 200 }, () => event), sessionId: "paseo-session" },
    }]);
  });
  it("reads modern cancellation and supports the older no-content acknowledgment", async () => {
    const { client } = transport((_call, index) => index === 0 ? json({ canceled: false }) : index === 1 ? json({ canceled: true }) : new Response(null, { status: 204 }));
    expect(await client.chatHeartbeat(18)).toBe(false);
    expect(await client.chatHeartbeat(18)).toBe(true);
    expect(await client.chatEvents(18, [event])).toBe(false);
  });
  it("propagates an uncertain result acknowledgment without redispatch or retry", async () => {
    const { client, calls } = transport(() => json({ error: "Run not found runner-secret" }, 404));
    await expect(client.report(17, { status: "success", output: "Completed", attempt: 2 })).rejects.toMatchObject({ status: 404, message: "It's a Plan request failed (HTTP 404)" });
    await expect(client.chatResult(18, { status: "success" })).rejects.toMatchObject({ status: 404 });
    expect(calls.map(({ url }) => url.pathname)).toEqual(["/api/agent-runs/17/result", "/api/agent-chats/18/result"]);
  });
});

describe("planner metadata", () => {
  it("reads every project page and exposes stable project ids rather than project refs", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ ...project, id: index + 1 }));
    const { client, calls } = transport((_call, index) => json({ items: index === 0 ? first : [{ ...project, id: 101 }], page: index + 1, pageSize: 100, total: 101 }));
    const projects = await client.projects();
    expect(projects).toEqual([...first, { ...project, id: 101 }].map(({ id, key, name }) => ({ id, key, name })));
    expect(calls.map(({ url }) => url.search)).toEqual(["?page=1&pageSize=100&sort=key", "?page=2&pageSize=100&sort=key"]);
  });
  it("reads only this project's connected repository metadata using its qualified ref", async () => {
    const { client, calls } = transport((_call, index) => index === 0 ? json({ items: [project], page: 1, pageSize: 100, total: 1 }) : json([{
      provider: "gitea", token: "must-not-escape", repositories: [
        { id: 4, fullName: "team/app", webUrl: "https://forge.test/team/app", status: "connected", lastError: "private diagnostic" },
        { id: 5, fullName: "team/broken", webUrl: "https://forge.test/team/broken", status: "error" },
      ],
    }]));
    expect(await client.repositories(7)).toEqual([{ id: 4, provider: "gitea", fullName: "team/app", webUrl: "https://forge.test/team/app" }]);
    expect(calls.map(({ url }) => url.pathname + url.search)).toEqual(["/api/projects/search?ids=7&page=1&pageSize=100", "/api/projects/team.PLAN/settings/git/connections"]);
  });
  it("does not expose credential-bearing repository URLs or confuse permission denial with an empty list", async () => {
    const response = { items: [project], page: 1, pageSize: 100, total: 1 };
    const invalid = transport((_call, index) => index === 0 ? json(response) : json([{ provider: "gitea", repositories: [{ id: 4, fullName: "team/app", webUrl: "https://user:secret@forge.test/team/app", status: "connected" }] }]));
    const error = await invalid.client.repositories(7).catch((error) => error);
    expect(error).toMatchObject({ status: 502 });
    expect(String(error)).not.toContain("secret");
    const forbidden = transport((_call, index) => index === 0 ? json(response) : new Response("private", { status: 403 }));
    await expect(forbidden.client.repositories(7)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects a non-progressing project page", async () => {
    await expect(transport(() => json({ items: [], page: 1, pageSize: 100, total: 1 })).client.projects()).rejects.toMatchObject({ status: 502, message: "Invalid project pagination from It's a Plan" });
  });
  it("reads projectId from the issue and preserves its API identifier", async () => {
    const { client, calls } = transport(() => json({ ...issue, sequenceNumber: 9, fields: [] }));
    expect(await client.issue(91)).toEqual(issue);
    expect(calls[0]!.url.pathname).toBe("/api/issues/91");
    await expect(transport(() => json({ ...issue, id: 92 })).client.issue(91)).rejects.toMatchObject({ status: 502 });
    await expect(transport(() => json({ ...issue, identifier: "" })).client.issue(91)).rejects.toMatchObject({ status: 502 });
    await expect(transport(() => json({ ...issue, projectId: "7" })).client.issue(91)).rejects.toMatchObject({ status: 502 });
  });
  it("resolves an exact project id to its qualified ref and adds missing search-hit project metadata", async () => {
    const { client, calls } = transport((_call, index) => index === 0 ? json({ items: [project], page: 1, pageSize: 100, total: 1 }) : json([{ id: 91, identifier: "PLAN-9", title: "Fix it", columnId: 3 }]));
    expect(await client.search(7, "  fix & test  ")).toEqual([{ id: 91, projectId: 7, identifier: "PLAN-9", title: "Fix it", columnId: 3 }]);
    expect(calls.map(({ url }) => url.pathname + url.search)).toEqual([
      "/api/projects/search?ids=7&page=1&pageSize=100", "/api/projects/team.PLAN/issues/search?limit=50&q=fix+%26+test",
    ]);
  });
  it("uses the bounded active issue listing for an empty query", async () => {
    const { client, calls } = transport((_call, index) => index === 0 ? json({ items: [project], page: 1, pageSize: 100, total: 1 }) : json([{ id: 91, identifier: "PLAN-9", title: "Fix it", columnId: 3 }]));
    expect(await client.search(7, " ")).toEqual([{ id: 91, projectId: 7, identifier: "PLAN-9", title: "Fix it", columnId: 3 }]);
    expect(calls[1]!.url.pathname + calls[1]!.url.search).toBe("/api/projects/team.PLAN/issues?limit=50");
    await expect(client.search(7, "x".repeat(301))).rejects.toMatchObject({ status: 400 });
  });
  it("rejects a cross-project search response", async () => {
    const { client } = transport((_call, index) => index === 0 ? json({ items: [project], page: 1, pageSize: 100, total: 1 }) : json([{ ...issue, projectId: 8 }]));
    await expect(client.search(7, "fix")).rejects.toMatchObject({ status: 502, message: "Invalid issue project from It's a Plan" });
  });
  it("writes milestone evidence before an explicitly requested column transition", async () => {
    const { client, calls } = transport(() => json(issue));
    await client.transition(91, 8, "Tests passed in the attached session");
    expect(calls.map(({ url, init, body }) => ({ path: url.pathname, method: init.method, body }))).toEqual([
      { path: "/api/issues/91/comments", method: "POST", body: { body: "Tests passed in the attached session" } },
      { path: "/api/issues/91", method: "PATCH", body: { columnId: 8 } },
    ]);
    await expect(client.transition(91, 8, " ")).rejects.toMatchObject({ status: 400 });
  });
});

describe("safe response errors", () => {
  it("never reads or echoes an HTTP error body", async () => {
    const { client } = transport(() => new Response("secret runner-secret backend diagnostics", { status: 403 }));
    const error = await client.claim().catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "RequestError", status: 403 });
    expect(String(error)).not.toContain("runner-secret");
    expect(String(error)).not.toContain("backend diagnostics");
    expect(isAuthError(error)).toBe(true);
    expect(isTransientError(error)).toBe(false);
    expect(isLeaseError(error)).toBe(false);
  });
  it("redacts fetch failures including redirect failures", async () => {
    const { client } = transport(() => { throw new TypeError("redirect to https://evil.test/runner-secret"); });
    const error = await client.claim().catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 0 });
    expect(String(error)).not.toContain("runner-secret");
    expect(String(error)).not.toContain("evil.test");
    expect(isTransientError(error)).toBe(true);
    expect(isAuthError(error)).toBe(false);
  });
  it("classifies HTTP authentication, lease and transient errors", () => {
    expect([401, 403, 404, 409, 429, 503].map((status) => {
      const error = new RequestError(status, "Safe message");
      return { status, auth: isAuthError(error), lease: isLeaseError(error), transient: isTransientError(error) };
    })).toEqual([
      { status: 401, auth: true, lease: false, transient: false },
      { status: 403, auth: true, lease: false, transient: false },
      { status: 404, auth: false, lease: true, transient: false },
      { status: 409, auth: false, lease: true, transient: false },
      { status: 429, auth: false, lease: false, transient: true },
      { status: 503, auth: false, lease: false, transient: true },
    ]);
  });
});
