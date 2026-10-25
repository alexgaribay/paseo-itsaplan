import { expect, test } from "bun:test";
import { projectMappingSchema } from "../shared/config";
import { persistedTaskContextSchema, taskContextSnapshotSchema } from "../shared/task-context";
import { Client } from "./protocol";
import { taskContextDigest } from "./task-context";

const issue = { id: 42, projectId: 7, identifier: "TW-42", title: "Optional context" };
const json = (value: unknown) => new Response(JSON.stringify(value));

test("context transport never returns configured execution credentials in captured checklist text", async () => {
  const client = new Client({ url: "https://planner.test/api", apiKey: "opaque-execution-credential", fetch: Object.assign(async () => json({
    ...issue, checklists: [{ id: 1, title: "Checklist", items: [{ id: 1, content: "Never expose opaque-execution-credential", done: false }] }],
  }), { preconnect: fetch.preconnect }) });
  const snapshot = await client.context(issue, projectMappingSchema.parse({ taskContext: { enabled: true, checklists: true } }));
  expect(snapshot.text).toContain("Never expose");
  expect(JSON.stringify(snapshot)).not.toContain("opaque-execution-credential");
  expect(taskContextSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(taskContextDigest(snapshot)).toBe(snapshot.digest);
});

test("disabled context performs no authenticated reads and remains a valid durable snapshot", async () => {
  const client = new Client({ url: "https://planner.test/api", apiKey: "opaque-execution-credential", fetch: Object.assign(async () => { throw new Error("Disabled context must not read"); }, { preconnect: fetch.preconnect }) });
  const snapshot = await client.context(issue, projectMappingSchema.parse({}));
  expect(snapshot).toMatchObject({ version: 1, issueId: 42, projectId: 7, text: "", assets: [], development: [] });
  expect(persistedTaskContextSchema.safeParse(snapshot).success).toBe(true);
});

