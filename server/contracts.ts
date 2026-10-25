import type { PaseoApi } from "@getpaseo/client";
import type { Config, ProjectMapping, Selection } from "../shared/config";
import type { AgUiEvent, ChatMessage, Issue, LinkedRepository, Project, Provider, Result, Run, SessionRecord } from "../shared/models";
import type { LocalRepository } from "./repository-matching";
import type { ExecutionEvidence, RerunRequest, TaskIntent } from "../shared/experience";

export interface Protocol {
  claim(signal?: AbortSignal): Promise<Run | null>;
  claimChat(signal?: AbortSignal): Promise<ChatMessage | null>;
  heartbeat(runId: number, attempt?: number, signal?: AbortSignal): Promise<void>;
  report(runId: number, result: Result & { attempt?: number }, signal?: AbortSignal): Promise<void>;
  runEvents(run: Run, offset: number, events: AgUiEvent[], sessionId?: string, signal?: AbortSignal): Promise<void>;
  chatHeartbeat(messageId: number, signal?: AbortSignal): Promise<boolean>;
  chatEvents(messageId: number, events: AgUiEvent[], sessionId?: string, signal?: AbortSignal): Promise<boolean>;
  chatResult(messageId: number, result: Result, signal?: AbortSignal): Promise<void>;
  projects(signal?: AbortSignal): Promise<Project[]>;
  repositories(projectId: number, signal?: AbortSignal): Promise<LinkedRepository[]>;
  issue(id: number, signal?: AbortSignal): Promise<Issue>;
  intent(run: Run, issue?: Issue, signal?: AbortSignal, request?: (id: string) => RerunRequest | undefined): Promise<TaskIntent>;
  search(projectId: number, query: string, signal?: AbortSignal): Promise<Issue[]>;
  transition(issueId: number, columnId: number, evidence: string, signal?: AbortSignal): Promise<void>;
  test(signal?: AbortSignal): Promise<void>;
}
export interface SessionSnapshot {
  id: string; workspaceId: string | null; cwd: string; provider: string;
  active: boolean; archived: boolean; error?: string; lastMessage?: string;
  model: string | null; modeId: string | null; pendingPermissionCount: number;
}
export interface Gateway {
  host(): Promise<{ id: string; label: string }>;
  catalog(cwd?: string): Promise<Provider[]>;
  repositories(signal?: AbortSignal): Promise<LocalRepository[]>;
  select(config: Config, project: ProjectMapping, override?: Partial<Selection>): Promise<Selection>;
  create(input: { key: string; agentId: string; title: string; project: ProjectMapping; selection: Selection; systemPrompt: string; config: Config; mcpToken?: string; issueId: number | null }): Promise<SessionSnapshot>;
  inspect(agentId: string, options?: { includeHistory?: boolean }): Promise<SessionSnapshot | null>;
  send(agentId: string, prompt: string, messageId: string): Promise<void>;
  wait(agentId: string, timeoutMs: number, onText: (text: string) => void, signal: AbortSignal, messageId?: string): Promise<Result & { evidence?: ExecutionEvidence }>;
  cancel(agentId: string): Promise<void>;
  withApi?(paseo: PaseoApi): Gateway;
  close(): Promise<void>;
}
export interface Secrets { apiKey?: string; mcpToken?: string; paseoPassword?: string; requestApiKey?: string }
export interface Journal {
  records(): SessionRecord[];
  get(key: string): SessionRecord | undefined;
  request(id: string): RerunRequest | undefined;
  put(record: SessionRecord): Promise<void>;
  putMany(records: SessionRecord[]): Promise<void>;
  update(key: string, change: (record: SessionRecord) => SessionRecord | undefined): Promise<void>;
  thread(threadId: string): { agentId: string; projectId: string } | undefined;
  bindThread(threadId: string, binding: { agentId: string; projectId: string }): Promise<void>;
}
