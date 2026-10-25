import { expect, test } from "bun:test";
import { parseIssueReference } from "./issue-reference";

const web = "https://plan.example.com";

test("a copied issue permalink keeps its numeric issue when it links to a comment", () => {
  expect(parseIssueReference("  https://PLAN.example.com:443/issue/42?comment=8#activity-8  ", web)).toBe(42);
});

test("numeric references accept only canonical positive safe issue IDs", () => {
  expect(parseIssueReference("1", web)).toBe(1);
  expect(parseIssueReference(String(Number.MAX_SAFE_INTEGER), web)).toBe(Number.MAX_SAFE_INTEGER);
  for (const input of ["0", "01", "-1", "1.5", "1e2", "42 extra", "9007199254740992"]) expect(parseIssueReference(input, web)).toBeNull();
});

test("a foreign server, scheme or port cannot silently select a local issue with the same ID", () => {
  expect(parseIssueReference("https://other.example.com/issue/42", web)).toBeNull();
  expect(parseIssueReference("http://plan.example.com/issue/42", web)).toBeNull();
  expect(parseIssueReference("https://plan.example.com:8443/issue/42", web)).toBeNull();
});

test("configured installation prefixes are matched exactly", () => {
  expect(parseIssueReference("https://plan.example.com/team/issue/42/", web + "/team/")).toBe(42);
  expect(parseIssueReference("https://plan.example.com/issue/42", web + "/team")).toBeNull();
  expect(parseIssueReference("https://plan.example.com/team-other/issue/42", web + "/team")).toBeNull();
});

test("credentials, ambiguous paths and non-issue URLs are rejected", () => {
  expect(parseIssueReference("https://user:secret@plan.example.com/issue/42", web)).toBeNull();
  expect(parseIssueReference("https://plan.example.com/issue/42/subtask", web)).toBeNull();
  expect(parseIssueReference("https://plan.example.com/issue/%34%32", web)).toBeNull();
  expect(parseIssueReference("https://plan.example.com/project/42", web)).toBeNull();
  expect(parseIssueReference("javascript:alert(42)", web)).toBeNull();
});

test("invalid and missing references fail without a network-dependent fallback", () => {
  expect(parseIssueReference("", web)).toBeNull();
  expect(parseIssueReference("TW-42", web)).toBeNull();
  expect(parseIssueReference("/issue/42", web)).toBeNull();
  expect(parseIssueReference(web + "/issue/42", "not a URL")).toBeNull();
  expect(parseIssueReference("9".repeat(4097), web)).toBeNull();
});
