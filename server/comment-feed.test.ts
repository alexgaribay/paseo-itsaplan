import { expect, test } from "bun:test";
import { Client } from "./protocol";

const json = (value: unknown) => new Response(JSON.stringify(value));
const row = { id: 1, issueId: 42, kind: "comment", actorUserId: "bot-user", body: "Verified outcome" };
function adapter(reply: (url: URL, init: RequestInit) => Response) {
  return new Client({ url: "https://planner.test/api", apiKey: "execution-key", fetch: ((url, init) => Promise.resolve(reply(new URL(String(url)), init!))) as typeof fetch });
}

test("comment feed preserves authoritative actor binding and excludes change-log lookalikes", async () => {
  const client = adapter((url, init) => {
    expect(url.pathname).toBe("/api/issues/42/feed");
    expect(url.searchParams.get("filter")).toBe("comments");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "x-api-key": "execution-key" });
    return json({ items: [row, { ...row, id: 2, kind: "activity" }, { ...row, id: 3, actorUserId: null }, { ...row, id: 4, body: null }], nextCursor: null });
  });
  expect(await client.commentFeed(42)).toEqual({ items: [{ id: 1, body: "Verified outcome", actorId: "bot-user" }], complete: true });
});

test("comment feed follows opaque keyset cursors and keeps partial results explicit", async () => {
  let page = 0;
  const client = adapter((url) => {
    page++;
    if (page > 1) expect(JSON.parse(url.searchParams.get("cursor")!)).toEqual({ ts: `2026-10-24 12:00:0${page - 1}+00`, id: page - 1 });
    return json({ items: [{ ...row, id: page }], nextCursor: { ts: `2026-10-24 12:00:0${page}+00`, id: page } });
  });
  expect(await client.commentFeed(42)).toEqual({ items: [1, 2, 3, 4, 5].map((id) => ({ id, body: "Verified outcome", actorId: "bot-user" })), complete: false });
});

test("comment feed rejects incorrect issue scope and stalled pagination", async () => {
  await expect(adapter(() => json({ items: [{ ...row, issueId: 99 }], nextCursor: null })).commentFeed(42)).rejects.toMatchObject({ status: 502 });
  let page = 0;
  await expect(adapter(() => json({ items: [{ ...row, id: ++page }], nextCursor: { ts: "same-cursor", id: 1 } })).commentFeed(42)).rejects.toMatchObject({ status: 502 });
});

test("bounded feeds reject streaming over-budget content without exposing response secrets", async () => {
  const client = adapter(() => new Response("private execution-key", { headers: { "content-length": "8000001" } }));
  await expect(client.commentFeed(42)).rejects.toMatchObject({ status: 502, message: "It's a Plan response exceeds the context budget" });
});

test("comment update validates receipt identity and uses the upstream comment edit route", async () => {
  const client = adapter((url, init) => {
    expect(url.pathname).toBe("/api/comments/8");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ body: "Approved replacement" });
    return json({ id: 8, actorUserId: "bot-user", body: "Approved replacement" });
  });
  expect(await client.updateComment(8, "Approved replacement")).toEqual({ id: 8 });
  await expect(adapter(() => json({ id: 9 })).updateComment(8, "Approved replacement")).rejects.toMatchObject({ status: 502 });
  await expect(client.updateComment(8, "x".repeat(50_001))).rejects.toMatchObject({ status: 400 });
});
