import type { RerunResult } from "../shared/experience";

export function mergeRequestResult(previous: RerunResult | undefined, next: RerunResult): RerunResult {
  if (previous?.requestId !== next.requestId || next.comment !== undefined || previous.comment === undefined) return next;
  return { ...next, comment: previous.comment };
}

export function canDiscardPreview(attempted: boolean, result: RerunResult | undefined): boolean {
  return !attempted && (!result || result.state === "prepared");
}
