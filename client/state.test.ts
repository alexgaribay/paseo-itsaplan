import { describe, expect, test } from "bun:test";
import type { RerunResult } from "../shared/experience";
import { canDiscardPreview, mergeRequestResult } from "./request-state";
import { resourceState } from "./resource-state";

const handedOff: RerunResult = {
  requestId: "f44903c6-9ad6-4a13-af39-3805875aaafe", state: "unknown", commentId: null, runId: null,
  message: "Awaiting browser delivery", comment: "Original request with nonce 123. Keep exact whitespace.\n",
};

describe("durable browser handoff presentation", () => {
  test("reconciliation retains the exact loaded comment while updating delivery evidence", () => {
    const reconciled = mergeRequestResult(handedOff, { requestId: handedOff.requestId, state: "submitted", commentId: 7, runId: 8, message: "Observed upstream" });
    expect(reconciled).toEqual({ ...handedOff, state: "submitted", commentId: 7, runId: 8, message: "Observed upstream" });
  });

  test("a different request never inherits another request's nonce or body", () => {
    const next: RerunResult = { requestId: "7392eb59-f474-4822-a8cc-b62c529d216b", state: "unknown", commentId: null, runId: null, message: "Unknown" };
    expect(mergeRequestResult(handedOff, next)).toEqual(next);
    expect(mergeRequestResult(undefined, next)).toEqual(next);
  });

  test("authoritative exact text replaces any previous loaded text", () => {
    expect(mergeRequestResult(handedOff, { ...handedOff, comment: "Exact stored comment\n\n" }).comment).toBe("Exact stored comment\n\n");
  });

  test("only an untouched prepared preview may be discarded on close", () => {
    expect(canDiscardPreview(false, undefined)).toBe(true);
    expect(canDiscardPreview(false, { ...handedOff, state: "prepared" })).toBe(true);
    expect(canDiscardPreview(true, undefined)).toBe(false);
    expect(canDiscardPreview(true, { ...handedOff, state: "prepared" })).toBe(false);
    expect(canDiscardPreview(false, handedOff)).toBe(false);
    expect(canDiscardPreview(false, { ...handedOff, state: "submitted" })).toBe(false);
  });
});

describe("resource refresh lifecycle", () => {
  test("explicit refresh keeps existing rows and nested-dialog owners mounted", () => {
    const rows = [{ key: "run-11", phase: "uncertain" }];
    const refreshing = resourceState({ data: rows, loading: false }, { type: "start", preserve: true });
    expect(refreshing).toEqual({ data: [{ key: "run-11", phase: "uncertain" }], loading: true });
    expect(refreshing.data).toBe(rows);
    expect(resourceState(refreshing, { type: "failed", error: "Offline" })).toEqual({ data: rows, loading: false, error: "Offline" });
  });

  test("changing the resource scope drops data from the previous scope", () => {
    expect(resourceState({ data: ["private issue in previous project"], error: "Old failure", loading: false }, { type: "start", preserve: false })).toEqual({ loading: true });
  });

  test("success replaces cached rows and clears the previous error", () => {
    const refreshing = resourceState({ data: ["old"], error: "Offline", loading: false }, { type: "start", preserve: true });
    expect(refreshing.error).toBe("Offline");
    expect(resourceState(refreshing, { type: "loaded", data: ["new"] })).toEqual({ data: ["new"], loading: false });
  });
});
