import { useEffect, useState } from "react";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { WorkflowOptions } from "../shared/workflow";
import { Feedback } from "./common";

export const AUTOMATIC_WORKFLOW_INFO = "Applies to fresh, unrestricted delegated implementation tasks only; smoke checks, chat, mentions, and manual or restricted runs are never completed automatically. The daemon commits the finished work itself, runs the configured or repository-discovered checks as real commands, integrates the result onto the target branch and pushes it to the configured remote. Done is marked only after publication is confirmed. Blocked checks, merge conflicts, and authentication failures never complete an issue.";
export const REVIEW_WORKFLOW_INFO = "Review mode opts out of automatic Git integration, publication, and status completion. The daemon reports the raw result only. Manual milestone evidence remains available as a separate, explicit path.";

export function workflowInfo(mode: WorkflowOptions["mode"], scope: "global" | "project"): string {
  const base = mode === "automatic" ? AUTOMATIC_WORKFLOW_INFO : REVIEW_WORKFLOW_INFO;
  const tail = scope === "global" ? "Projects with a workflow override replace these values entirely; projects without one inherit them." : "While overridden, these values replace the global workflow for this project entirely.";
  return `${base} ${tail}`;
}

const CHECK_HINT = "JSON argv array such as [\"npm\",\"test\"]. Runs without shell interpretation. Never store secrets in commands.";
const COLUMN_HINT = "Whole-number column ID. Blank discovers the column from the project's state types.";

function parseArgv(text: string): string[] | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!Array.isArray(value) || !value.length || !value.every((part) => typeof part === "string" && part.length > 0)) return undefined;
  return value;
}

function parseChecks(texts: string[]): string[][] | undefined {
  const checks: string[][] = [];
  for (const text of texts) {
    const argv = parseArgv(text);
    if (!argv) return undefined;
    checks.push(argv);
  }
  return checks;
}

function parseColumn(text: string): { valid: boolean; id?: number } {
  const trimmed = text.trim();
  if (!trimmed) return { valid: true };
  const id = Number(trimmed);
  return { valid: /^\d+$/.test(trimmed) && Number.isInteger(id) && id > 0, id };
}

export function WorkflowFields({ value, onChange, onValidationChange, columns = false, disabled = false, ...props }: Pick<PluginSurfaceProps, "theme"> & {
  value: WorkflowOptions;
  onChange(value: WorkflowOptions): void;
  onValidationChange?(error?: string): void;
  columns?: boolean;
  disabled?: boolean;
}) {
  const [texts, setTexts] = useState<string[]>(() => value.checks.map((argv) => JSON.stringify(argv)));
  const [inProgressText, setInProgressText] = useState(() => value.inProgressColumnId?.toString() || "");
  const [doneText, setDoneText] = useState(() => value.doneColumnId?.toString() || "");
  const [pending, setPending] = useState("");
  const [rowVersion, setRowVersion] = useState(0);
  useEffect(() => { onValidationChange?.(undefined); }, [onValidationChange]);
  const emit = (nextTexts: string[], nextInProgress: string, nextDone: string) => {
    const checks = parseChecks(nextTexts);
    const inProgress = parseColumn(nextInProgress);
    const done = parseColumn(nextDone);
    const error = !checks ? "Every check must be a JSON argv array of non-empty strings, such as [\"npm\",\"test\"]." : !inProgress.valid || !done.valid ? "Column IDs must be whole numbers, or blank to discover from project state types." : undefined;
    onValidationChange?.(error);
    if (!error && checks) onChange({ ...value, checks, inProgressColumnId: inProgress.id, doneColumnId: done.id });
  };
  const updateText = (index: number, text: string) => {
    const next = texts.map((current, position) => position === index ? text : current);
    setTexts(next);
    emit(next, inProgressText, doneText);
  };
  const removeText = (index: number) => {
    const next = texts.filter((_, position) => position !== index);
    setTexts(next);
    setRowVersion((version) => version + 1);
    emit(next, inProgressText, doneText);
  };
  const updateColumn = (field: "inProgressColumnId" | "doneColumnId", text: string) => {
    if (field === "inProgressColumnId") setInProgressText(text); else setDoneText(text);
    emit(texts, field === "inProgressColumnId" ? text : inProgressText, field === "doneColumnId" ? text : doneText);
  };
  const pendingValid = parseArgv(pending) !== undefined;
  return <>
    <SettingsSelect label="Lifecycle mode" value={value.mode} options={[{ value: "automatic", label: "Automatic (daemon commits and publishes)" }, { value: "review", label: "Review (manual Git and status)" }]} disabled={disabled} onValueChange={(mode) => onChange({ ...value, mode: mode as WorkflowOptions["mode"] })} />
    <SettingsInput label="Target branch" placeholder="main" initialValue={value.targetBranch} disabled={disabled} onChangeText={(targetBranch) => onChange({ ...value, targetBranch: targetBranch.trim() })} />
    <SettingsInput label="Git remote" placeholder="origin" initialValue={value.remote} disabled={disabled} onChangeText={(remote) => onChange({ ...value, remote: remote.trim() })} />
    {texts.map((text, index) => <SettingsInput key={`${index}-${rowVersion}`} label={`Verification check ${index + 1}`} hint={CHECK_HINT} initialValue={text} disabled={disabled} onChangeText={(next) => updateText(index, next)} />)}
    {texts.map((_, index) => <SettingsAction key={`remove-${index}-${rowVersion}`} label={`Remove verification check ${index + 1}`} hint="Updates the draft only. Save or apply to persist." actionLabel="Remove check" disabled={disabled} onPress={() => removeText(index)} />)}
    <SettingsInput key={`new-check-${rowVersion}`} label="Add verification check" hint={CHECK_HINT} placeholder={'["npm","test"]'} initialValue="" disabled={disabled || texts.length >= 30} onChangeText={setPending} />
    <SettingsAction label="Verification checks run directly in the repository working directory" actionLabel="Add check" disabled={disabled || texts.length >= 30 || !pending.trim() || !pendingValid} onPress={() => {
      const next = [...texts, pending];
      setTexts(next);
      setPending("");
      setRowVersion((version) => version + 1);
      emit(next, inProgressText, doneText);
    }} />
    <Feedback theme={props.theme} error={pending.trim() && !pendingValid ? "The new check must be a JSON argv array of non-empty strings, such as [\"npm\",\"test\"]." : undefined} />
    {columns && <>
      <SettingsInput label="In Progress column ID" hint={COLUMN_HINT} initialValue={inProgressText} disabled={disabled} onChangeText={(text) => updateColumn("inProgressColumnId", text)} />
      <SettingsInput label="Done column ID" hint={COLUMN_HINT} initialValue={doneText} disabled={disabled} onChangeText={(text) => updateColumn("doneColumnId", text)} />
    </>}
  </>;
}
