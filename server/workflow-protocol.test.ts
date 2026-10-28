import { describe, expect, it } from "bun:test";
import { Client, RequestError, isAuthError } from "./protocol";
import { ConfigurationError } from "./errors";

const project = { id: 7, key: "PLAN", name: "Production", ref: "team.PLAN" };
const identity = { authenticated: true, user: { id: "bot-user", isAgent: true } };
const marker = "<!-- paseo-workflow:9f2c1ab4:completed -->";
const notice = `Implementation integrated for PLAN-9.\n\n${marker}`;
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
const searchPage = (items: unknown[] = [project]) => json({ items, page: 1, pageSize: 100, total: items.length });
const feedRow = (id: number, body: string, actorUserId: string | null = "bot-user") => ({ id, issueId: 91, kind: "comment", actorUserId, body });
const feedPage = (items: unknown[], nextCursor: unknown = null) => json({ items, nextCursor });
const column = (id: number, name: string, stateType: string, position: number) => ({
  id, projectId: 7, name, stateType, color: "#3b82f6", position, wipLimit: null, wipMode: "soft", autoAssignUserId: null,
});
const board = (columns: unknown[], id = 7) => json({ project: { id, key: "PLAN", name: "Production" }, columns, issueTypes: [], labels: [], labelGroups: [], assignees: [], customFields: [], issueTemplates: [], viewer: { role: "member", teamRole: null, via: "project" }, permissions: {}, secrets: "must-not-be-validated" });

describe("workflow columns", () => {
  it("reads columns through the project view keyed by the qualified ref, not a columns route", async () => {
    const { client, calls } = transport((call, index) => index === 0 ? searchPage() : board([
      column(3, "In progress", "started", 2),
      { ...column(4, "Done", "completed", 3), wipLimit: 5, wipMode: "hard", autoAssignUserId: "member-1" },
    ]));
    expect(await client.columns(7)).toEqual([
      { id: 3, projectId: 7, name: "In progress", stateType: "started", position: 2 },
      { id: 4, projectId: 7, name: "Done", stateType: "completed", position: 3 },
    ]);
    expect(calls.map(({ url, init }) => ({ path: url.pathname + url.search, method: init.method }))).toEqual([
      { path: "/api/projects/search?ids=7&page=1&pageSize=100", method: "GET" },
      { path: "/api/projects/team.PLAN", method: "GET" },
    ]);
  });
  it("refuses a board scoped to another project or columns claiming another project", async () => {
    await expect(transport((_call, index) => index === 0 ? searchPage() : board([column(3, "In progress", "started", 0)], 8)).client.columns(7))
      .rejects.toMatchObject({ status: 502, message: "Invalid project scope from It's a Plan" });
    await expect(transport((_call, index) => index === 0 ? searchPage() : board([{ ...column(3, "In progress", "started", 0), projectId: 8 }])).client.columns(7))
      .rejects.toMatchObject({ status: 502, message: "Invalid column project from It's a Plan" });
  });
  it("rejects malformed column state types and unknown projects", async () => {
    await expect(transport((_call, index) => index === 0 ? searchPage() : board([column(3, "In progress", "active", 0)])).client.columns(7))
      .rejects.toMatchObject({ status: 502, message: "Invalid response from It's a Plan" });
    const missing = transport(() => searchPage([]));
    const error: unknown = await missing.client.columns(7).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ status: 404, message: "It's a Plan project is unavailable" });
  });
  it("surfaces a project permission denial rather than an empty list", async () => {
    const { client, calls } = transport((_call, index) => index === 0 ? searchPage() : new Response("private board diagnostics", { status: 403 }));
    const error: unknown = await client.columns(7).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 403 });
    expect(isAuthError(error)).toBe(true);
    expect(String(error)).not.toContain("private board diagnostics");
    expect(calls.length).toBe(2);
  });
});

describe("workflow column moves", () => {
  it("moves the issue with a bare PATCH and posts no comment of its own", async () => {
    const { client, calls } = transport(() => json({ id: 91, projectId: 7, identifier: "PLAN-9", title: "Fix it", columnId: 8 }));
    await client.setColumn(91, 8);
    expect(calls.map(({ url, init, body }) => ({ path: url.pathname, method: init.method, body }))).toEqual([
      { path: "/api/issues/91", method: "PATCH", body: { columnId: 8 } },
    ]);
  });
  it("keeps the milestone transition's evidence comment ahead of its own column patch", async () => {
    const { client, calls } = transport(() => json({ id: 91, columnId: 8 }));
    await client.transition(91, 8, "Checks passed");
    expect(calls.map(({ url, init, body }) => ({ path: url.pathname, method: init.method, body }))).toEqual([
      { path: "/api/issues/91/comments", method: "POST", body: { body: "Checks passed" } },
      { path: "/api/issues/91", method: "PATCH", body: { columnId: 8 } },
    ]);
  });
  it("rejects a receipt that does not confirm the move", async () => {
    await expect(transport(() => json({ id: 92, columnId: 8 })).client.setColumn(91, 8))
      .rejects.toMatchObject({ status: 502, message: "Invalid column move receipt from It's a Plan" });
    await expect(transport(() => json({ id: 91, columnId: 3 })).client.setColumn(91, 8))
      .rejects.toMatchObject({ status: 502, message: "Invalid column move receipt from It's a Plan" });
    await expect(transport(() => json({ id: 91, columnId: null })).client.setColumn(91, 8))
      .rejects.toMatchObject({ status: 502, message: "Invalid response from It's a Plan" });
  });
  it("propagates upstream refusals without posting a fallback comment", async () => {
    for (const [status, expected] of [[400, "Column must belong to this project"], [409, "WIP limit reached"], [403, "denied"]] as const) {
      const { client, calls } = transport(() => new Response(expected, { status }));
      const error: unknown = await client.setColumn(91, 8).catch((error: unknown) => error);
      expect(error).toMatchObject({ status });
      expect(String(error)).not.toContain(expected);
      expect(calls.map(({ init }) => init.method)).toEqual(["PATCH"]);
    }
  });
  it("validates both ids before any request", async () => {
    const { client, calls } = transport(() => json({ id: 91, columnId: 8 }));
    for (const [issueId, columnId] of [[0, 8], [91, 0], [-1, 8], [91, 2.5]] as const) {
      await expect(client.setColumn(issueId, columnId)).rejects.toMatchObject({ status: 400 });
    }
    expect(calls.length).toBe(0);
  });
});

describe("workflow notice comments", () => {
  it("reuses the exact owning comment from a complete feed without posting it again", async () => {
    const { client, calls } = transport((call) => {
      if (call.url.pathname === "/api/me") return json(identity);
      return feedPage([
        { ...feedRow(76, notice), kind: "activity" },
        feedRow(75, "Earlier status update"),
        feedRow(77, notice),
      ]);
    });
    expect(await client.workflowComment(91, marker, notice, false)).toEqual({ id: 77 });
    expect(calls.map(({ url, init }) => ({ path: url.pathname, method: init.method }))).toEqual([
      { path: "/api/me", method: "GET" },
      { path: "/api/issues/91/feed", method: "GET" },
    ]);
  });
  it("reconciles an ambiguous first-dispatch acknowledgment from the feed and never duplicates it", async () => {
    for (const allowCreate of [true, false]) {
      const { client, calls } = transport((call) => call.url.pathname === "/api/me" ? json(identity) : feedPage([feedRow(77, notice)]));
      expect(await client.workflowComment(91, marker, notice, allowCreate)).toEqual({ id: 77 });
      expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
    }
  });
  it("returns null without posting when a complete feed has no match and creation is fenced off", async () => {
    const { client, calls } = transport((call) => call.url.pathname === "/api/me" ? json(identity) : feedPage([feedRow(70, "Unrelated comment")]));
    expect(await client.workflowComment(91, marker, notice, false)).toBeNull();
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
  });
  it("finds the marker on a later page of a complete feed instead of re-posting", async () => {
    let page = 0;
    const { client, calls } = transport((call) => {
      if (call.url.pathname === "/api/me") return json(identity);
      page++;
      if (page === 1) return feedPage([feedRow(70, "Older comment")], { ts: "2026-10-28 12:00:00+00", id: 70 });
      return feedPage([feedRow(77, notice)]);
    });
    expect(await client.workflowComment(91, marker, notice, false)).toEqual({ id: 77 });
    expect(page).toBe(2);
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
  });
  it("fails closed on an incomplete feed even when creation is allowed", async () => {
    let page = 0;
    const { client, calls } = transport((call) => {
      if (call.url.pathname === "/api/me") return json(identity);
      page++;
      return feedPage([feedRow(70 + page, `Older comment ${page}`)], { ts: `2026-10-28 12:00:0${page}+00`, id: 70 + page });
    });
    const error: unknown = await client.workflowComment(91, marker, notice, true).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(page).toBe(5);
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
  });
  it("fails closed when the marker collides across comments", async () => {
    const { client, calls } = transport((call) => call.url.pathname === "/api/me" ? json(identity) : feedPage([feedRow(77, notice), feedRow(78, `${notice}\nA second copy.`)]));
    const error: unknown = await client.workflowComment(91, marker, notice, true).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).toContain("several comments");
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
  });
  it("fails closed when the marker comment's body was mutated", async () => {
    const { client, calls } = transport((call) => call.url.pathname === "/api/me" ? json(identity) : feedPage([feedRow(77, `${notice}\nRewritten after the fence.`)]));
    const error: unknown = await client.workflowComment(91, marker, notice, false).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).toContain("no longer matches");
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
  });
  it("fails closed when the marker comment belongs to another account", async () => {
    const { client, calls } = transport((call) => call.url.pathname === "/api/me" ? json(identity) : feedPage([feedRow(77, notice, "member-2")]));
    const error: unknown = await client.workflowComment(91, marker, notice, true).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).toContain("another account");
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(0);
  });
  it("rejects a notice body that does not carry exactly one marker before any request", async () => {
    const { client, calls } = transport((call) => call.url.pathname === "/api/me" ? json(identity) : feedPage([]));
    for (const body of ["No marker here", `${notice}${marker}`]) {
      const error: unknown = await client.workflowComment(91, marker, body, true).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain("exactly one marker");
    }
    expect(calls.length).toBe(0);
  });
  it("propagates an authentication denial before reading the feed or posting", async () => {
    const { client, calls } = transport(() => json({ authenticated: false }));
    const error: unknown = await client.workflowComment(91, marker, notice, true).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 401 });
    expect(isAuthError(error)).toBe(true);
    expect(calls.map(({ url }) => url.pathname)).toEqual(["/api/me"]);
  });
  it("refuses to reconcile or post notices under a non-agent account", async () => {
    const { client, calls } = transport((call) => {
      if (call.url.pathname === "/api/me") return json({ authenticated: true, user: { id: "member-2", isAgent: false } });
      return feedPage([feedRow(77, notice, "member-2")]);
    });
    const error: unknown = await client.workflowComment(91, marker, notice, true).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ status: 403 });
    expect(isAuthError(error)).toBe(true);
    expect(calls.map(({ url }) => url.pathname)).toEqual(["/api/me"]);
  });
  it("propagates an upstream posting denial without leaking its body", async () => {
    const { client, calls } = transport((call) => {
      if (call.url.pathname === "/api/me") return json(identity);
      if (call.init.method === "POST") return new Response("private runner-secret diagnostics", { status: 403 });
      return feedPage([]);
    });
    const error: unknown = await client.workflowComment(91, marker, notice, true).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 403 });
    expect(String(error)).not.toContain("runner-secret");
    expect(calls.filter(({ init }) => init.method === "POST").length).toBe(1);
  });
});
