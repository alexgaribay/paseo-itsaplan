import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPaseoApi, type OwnedSubscription, type PaseoAgent, type PaseoAgentCreateOptions, type PaseoAgentSendOptions, type PaseoWorkspace, type PaseoWorkspaceAgentCreateOptions, type PaseoAgentListResult, type PaseoAgentListOptions } from "@getpaseo/client";
import { DaemonClient, type FetchAgentTimelineOptions, type FetchAgentTimelinePayload, type WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { defaults, projectMappingSchema } from "../shared/config";
import { connectGateway, PaseoGateway } from "./paseo";
import { ConfigurationError } from "./errors";

const execute = promisify(execFile);
let directory: string;
let root: string;
const connections: DaemonClient[] = [];

function staticAgentList(result: PaseoAgentListResult) {
  function list(options: PaseoAgentListOptions & { subscribe: {} }): Promise<PaseoAgentListResult & { subscriptionId: string; subscription: OwnedSubscription<PaseoAgentListResult> }>;
  function list(options?: PaseoAgentListOptions): Promise<PaseoAgentListResult>;
  async function list(options?: PaseoAgentListOptions): Promise<PaseoAgentListResult> {
    if (options?.subscribe) throw new Error("This catalog fixture does not establish subscriptions");
    return result;
  }
  return list;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "itsaplan-gateway-"));
  root = await realpath(directory);
  await execute("git", ["init", "--initial-branch=main", root]);
  await execute("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial"]);
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map((client) => client.close()));
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "gateway-test", reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  connections.push(client);
  const api = createPaseoApi(client);
  const state: { agent: PaseoAgent; items: AgentTimelineItem[]; result: WaitForFinishResult; canceled: string[]; created: PaseoAgentCreateOptions[] } = {
    agent: {
      id: "agent-1", provider: "alpha", cwd: root, workspaceId: "workspace-1", model: "a-default",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastUserMessageAt: null,
      status: "idle", activeTurn: null, capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true, supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true },
      currentModeId: "review", availableModes: [], pendingPermissions: [], persistence: null, title: "Task", labels: { "itsaplan.key": "hello" },
    },
    items: [{ type: "user_message", text: "Implement the task" }, { type: "assistant_message", text: "Implemented." }],
    result: { status: "idle", final: null, error: null, lastMessage: "Implemented." }, canceled: [], created: [],
  };
  client.fetchAgent = mock(async () => ({ agent: state.agent, project: null }));
  client.fetchAgentTimeline = mock(async (): Promise<FetchAgentTimelinePayload> => ({
    requestId: "history", agentId: state.agent.id, agent: state.agent, direction: "tail", projection: "projected", epoch: "one",
    reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: state.items.length, nextSeq: state.items.length + 1 },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false,
    entries: state.items.map((item, index) => ({ provider: state.agent.provider, item, timestamp: "2026-01-01T00:00:00Z", seqStart: index, seqEnd: index, sourceSeqRanges: [], collapsed: [] })), error: null,
  }));
  client.waitForFinish = mock(async () => ({ ...state.result, final: state.result.final ?? state.agent }));
  api.providers.listAvailable = mock(async () => ({ providers: [{ provider: "alpha", available: true }, { provider: "beta", available: true }, { provider: "offline", available: false }], requestId: "available", fetchedAt: "now" }));
  api.providers.listModels = mock(async (provider: string) => ({ provider, requestId: "models", fetchedAt: "now", models: provider === "alpha"
    ? [{ provider, id: "a-default", label: "Alpha default", isDefault: true }, { provider, id: "a-project", label: "Alpha project" }, { provider, id: "a-override", label: "Alpha override" }]
    : [{ provider, id: "b-default", label: "Beta default", isDefault: true }] }));
  api.providers.listModes = mock(async (provider: string) => ({ provider, requestId: "modes", fetchedAt: "now", modes: [{ id: "review", label: "Review" }, { id: "plan", label: "Plan" }] }));
  api.agents.create = mock(async (options: PaseoAgentCreateOptions) => {
    state.created.push(options);
    state.agent = { ...state.agent, cwd: options.cwd, labels: options.labels ?? {} };
    return api.agents.ref(state.agent);
  });
  const cancel = mock(async (id: string) => { state.canceled.push(id); state.agent = { ...state.agent, status: "idle", activeTurn: null }; });
  const gateway = new PaseoGateway(api, cancel, () => api.dispose());
  const config = { ...defaults(), defaultProvider: "alpha", defaultModel: "a-default", defaultModeId: "review" };
  const project = projectMappingSchema.parse({ repository: root, worktree: false });
  const input = { key: "hello", agentId: "agent-1", title: "Do not put this issue title in a branch", project, selection: { provider: "alpha", model: "a-default", modeId: "review" }, systemPrompt: "Issue text", config, issueId: 42 };
  return { client, api, state, gateway, config, project, input };
}

describe("provider selection", () => {
  test("resolves provider, model, and mode independently in precedence order", async () => {
    const { gateway, config, project } = fixture();
    expect(await gateway.select(config, { ...project, model: "a-project", modeId: "plan" }, { model: "a-override" })).toEqual({ provider: "alpha", model: "a-override", modeId: "plan" });
    expect(await gateway.select(config, { ...project, model: "a-project" })).toEqual({ provider: "alpha", model: "a-project", modeId: "review" });
  });

  test("changes provider without inheriting another provider's model or mode", async () => {
    const { gateway, config, project } = fixture();
    expect(await gateway.select(config, { ...project, provider: "beta" })).toEqual({ provider: "beta", model: "", modeId: "" });
    expect(await gateway.select(config, { ...project, model: "a-project" }, { provider: "beta", model: "b-default", modeId: "plan" })).toEqual({ provider: "beta", model: "b-default", modeId: "plan" });
    expect(await gateway.select(config, { ...project, model: "a-project" }, { provider: "beta" })).toEqual({ provider: "beta", model: "", modeId: "" });
  });

  test("preserves native provider defaults instead of selecting a catalog entry", async () => {
    const { gateway, api, config, project } = fixture();
    const selection = { ...config, defaultModel: "" };
    expect(await gateway.select(selection, project)).toEqual({ provider: "alpha", model: "", modeId: "review" });
    api.providers.listModels = mock(async () => { throw new Error("A native default does not require model discovery"); });
    expect(await gateway.select(selection, project)).toEqual({ provider: "alpha", model: "", modeId: "review" });
  });

  test("refuses unavailable providers rather than choosing an unrelated provider", async () => {
    const { gateway, config, project } = fixture();
    await expect(gateway.select(config, project, { provider: "offline" })).rejects.toThrow("Selected Paseo provider is unavailable");
    await expect(gateway.select({ ...config, defaultProvider: "" }, project)).rejects.toThrow("Configure an explicit Paseo provider");
  });

  test("rejects unknown models and modes", async () => {
    const { gateway, config, project } = fixture();
    await expect(gateway.select(config, project, { model: "b-default" })).rejects.toThrow("Selected Paseo model is unavailable");
    await expect(gateway.select(config, project, { modeId: "approve-everything" })).rejects.toThrow("Selected Paseo mode is unavailable");
  });

  test("discovers providers and their models without creating an agent", async () => {
    const { gateway, state } = fixture();
    expect(await gateway.catalog()).toEqual([
      { id: "alpha", available: true, error: undefined, models: [{ id: "a-default", name: "Alpha default" }, { id: "a-project", name: "Alpha project" }, { id: "a-override", name: "Alpha override" }], modes: [{ id: "review", name: "Review" }, { id: "plan", name: "Plan" }] },
      { id: "beta", available: true, error: undefined, models: [{ id: "b-default", name: "Beta default" }], modes: [{ id: "review", name: "Review" }, { id: "plan", name: "Plan" }] },
      { id: "offline", available: false, error: undefined, models: [], modes: [] },
    ]);
    expect(state.created).toEqual([]);
  });
});

describe("repository and session creation", () => {
  test("rejects relative paths and nested directories, but resolves a repository symlink", async () => {
    const { gateway, config, project } = fixture();
    await mkdir(join(root, "nested"));
    await expect(gateway.select(config, { ...project, repository: "relative" })).rejects.toThrow("absolute Git checkout root");
    await expect(gateway.select(config, { ...project, repository: join(root, "nested") })).rejects.toThrow("canonical Git checkout root");
    const link = join(root, "linked-repository");
    await symlink(root, link);
    expect(await gateway.select(config, { ...project, repository: link })).toEqual({ provider: "alpha", model: "a-default", modeId: "review" });
  });

  test("creates an idempotent association without sending an initial prompt", async () => {
    const { gateway, state, input } = fixture();
    expect(await gateway.create(input)).toEqual({ id: "agent-1", workspaceId: "workspace-1", cwd: root, provider: "alpha", model: "a-default", modeId: "review", pendingPermissionCount: 0, active: false, archived: false, error: undefined });
    expect(state.created[0]).toMatchObject({ idempotencyKey: "hello", agentId: "agent-1", cwd: root, labels: { "itsaplan.key": "hello", "itsaplan.issueId": "42" }, config: { provider: "alpha/a-default", modeId: "review" } });
    expect(Object.hasOwn(state.created[0], "prompt")).toBe(false);
  });

  test("supports native worktree slug normalization without leaving the mapped repository", async () => {
    const { gateway, api, state, input } = fixture();
    const checkout = join(root, "task-worktree");
    api.agents.create = mock(async (options: PaseoAgentCreateOptions) => {
      state.created.push(options);
      const worktree = options.worktree;
      if (!worktree || worktree.mode !== "branch-off") throw new Error("Expected a native branch-off request");
      await execute("git", ["-C", root, "worktree", "add", "-b", worktree.newBranch.replaceAll("/", "-"), checkout, worktree.base ?? "HEAD"]);
      state.agent = { ...state.agent, cwd: checkout, labels: options.labels ?? {} };
      return api.agents.ref(state.agent);
    });
    expect((await gateway.create({ ...input, project: { ...input.project, worktree: true, baseBranch: "main" } })).cwd).toBe(checkout);
  });

  test("refuses missing configured workspaces before agent creation", async () => {
    const { gateway, api, state, input } = fixture();
    const workspace = api.workspaces.ref("missing-workspace");
    workspace.refresh = mock(async () => null);
    api.workspaces.ref = mock(() => workspace);
    await expect(gateway.create({ ...input, project: { ...input.project, workspaceId: "missing-workspace" } })).rejects.toThrow("Configured workspace does not match");
    expect(state.created).toEqual([]);
  });

  test("targets a validated existing workspace when worktree isolation is disabled", async () => {
    const { gateway, api, state, input } = fixture();
    const descriptor: PaseoWorkspace = {
      id: "workspace-1", projectId: "project-1", projectDisplayName: "Project", projectRootPath: root,
      workspaceDirectory: root, projectKind: "git", workspaceKind: "local_checkout", name: "Main",
      archivingAt: null, status: "done", statusEnteredAt: null, activityAt: null, scripts: [],
    };
    const workspace = api.workspaces.ref(descriptor);
    workspace.refresh = mock(async () => descriptor);
    workspace.agents.create = mock(async (options: PaseoWorkspaceAgentCreateOptions) => {
      state.created.push({ ...options, cwd: root });
      state.agent = { ...state.agent, labels: options.labels ?? {} };
      return api.agents.ref(state.agent);
    });
    api.workspaces.ref = mock(() => workspace);
    api.agents.create = mock(async () => { throw new Error("Existing workspace was not used"); });
    const result = await gateway.create({ ...input, project: { ...input.project, workspaceId: "workspace-1" } });
    expect(result.workspaceId).toBe("workspace-1");
    expect(state.created[0]).toMatchObject({ cwd: root, agentId: "agent-1", idempotencyKey: "hello" });
  });

  test("refuses an unsafe idle checkout without starting work or archiving its conversation", async () => {
    const { gateway, api, state, input } = fixture();
    const foreign = join(root, "foreign");
    await mkdir(foreign);
    await execute("git", ["init", foreign]);
    api.agents.create = mock(async () => { state.agent = { ...state.agent, cwd: foreign }; return api.agents.ref(state.agent); });
    await expect(gateway.create(input)).rejects.toThrow("Created agent checkout does not match");
    expect((await gateway.inspect("agent-1"))?.active).toBe(false);
    expect((await gateway.inspect("agent-1"))?.archived).toBe(false);
  });

  test("injects only opted-in HTTP MCP with exact preapprovals and its separate credential", async () => {
    const { gateway, api, state, input } = fixture();
    api.agents.list = staticAgentList({ requestId: "sessions", entries: [{
      agent: state.agent,
      project: { projectKey: "project", projectName: "Project", checkout: { cwd: root, isGit: true, currentBranch: "main", remoteUrl: null, worktreeRoot: root, isPaseoOwnedWorktree: false, mainRepoRoot: null } },
    }], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
    const config = { ...input.config, mcp: { enabled: true, url: "https://example.invalid/mcp", providers: ["alpha"], preapprovedTools: ["get_issue"] } };
    await gateway.create({ ...input, config, mcpToken: "separate-mcp-secret" });
    expect(state.created[0].config.mcpServers).toEqual({ itsaplan: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer separate-mcp-secret" } } });
    expect(state.created[0].config.toolPolicy).toEqual({ preapproved: [{ kind: "mcp", server: "itsaplan", tool: "get_issue" }] });
    await gateway.create({ ...input, config: { ...config, mcp: { ...config.mcp, providers: [] } }, mcpToken: "separate-mcp-secret" });
    expect(state.created[1].config.mcpServers).toBeUndefined();
  });

  test("omits optional MCP when existing provider evidence says it is unsupported", async () => {
    const { gateway, api, state, input } = fixture();
    api.agents.list = staticAgentList({
      requestId: "sessions", pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      entries: [{
        agent: { ...state.agent, capabilities: { ...state.agent.capabilities, supportsMcpServers: false } },
        project: { projectKey: "project", projectName: "Project", checkout: { cwd: root, isGit: true, currentBranch: "main", remoteUrl: null, worktreeRoot: root, isPaseoOwnedWorktree: false, mainRepoRoot: null } },
      }],
    });
    const config = { ...input.config, mcp: { enabled: true, url: "https://example.invalid/mcp", providers: ["alpha"], preapprovedTools: [] } };
    const result = await gateway.create({ ...input, config, mcpToken: "separate-secret" });
    expect(result).toMatchObject({ id: "agent-1", provider: "alpha", archived: false });
    expect(state.created[0].config.mcpServers).toBeUndefined();
  });
});

describe("turn lifecycle", () => {
  test("a send acknowledgment does not complete the active turn", async () => {
    const { gateway, client, state } = fixture();
    const sent: { id: string; text: string; messageId?: string }[] = [];
    client.sendAgentMessage = mock(async (id: string, text: string, options?: PaseoAgentSendOptions) => {
      sent.push({ id, text, messageId: options?.messageId });
      state.agent = { ...state.agent, status: "running", activeTurn: { turnId: "turn-1", startedAt: null } };
      return {};
    });
    client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => ({ status: "timeout", final: state.agent, error: null, lastMessage: null }));
    await gateway.send("agent-1", "Task prompt", "stable-message-id");
    const result = await gateway.wait("agent-1", 25, () => {}, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(sent).toEqual([{ id: "agent-1", text: "Task prompt", messageId: "stable-message-id" }]);
    expect(state.canceled).toEqual(["agent-1"]);
  });

  test("waits for completion and returns provider-independent assistant output", async () => {
    const { gateway, client, state } = fixture();
    let rounds = 0;
    client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
      rounds++;
      if (rounds === 1) {
        state.items[1] = { type: "assistant_message", text: "Imple" };
        return { status: "timeout", final: { ...state.agent, status: "running" }, error: null, lastMessage: null };
      }
      state.items[1] = { type: "assistant_message", text: "Implemented." };
      return { status: "idle", final: { ...state.agent, lastUsage: { inputTokens: 12, outputTokens: 4 } }, error: null, lastMessage: "Implemented." };
    });
    const deltas: string[] = [];
    expect(await gateway.wait("agent-1", 2000, (text) => deltas.push(text), new AbortController().signal)).toEqual({ status: "success", output: "Implemented.", evidence: { toolCallCount: 0, historyComplete: true }, usage: { inputTokens: 12, outputTokens: 4 } });
    expect(deltas).toEqual(["Imple", "mented."]);
  });

  test("does not treat a permission gate as successful completion and cancels on deadline", async () => {
    const { gateway, state } = fixture();
    state.result.status = "permission";
    state.agent.status = "running";
    state.agent.activeTurn = { turnId: "waiting-for-permission", startedAt: null };
    const result = await gateway.wait("agent-1", 25, () => {}, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", error: "Paseo execution timed out" });
    expect(await gateway.inspect("agent-1")).toMatchObject({ active: false, pendingPermissionCount: 0 });
  });

  test("aborts a pending lifecycle wait and preserves the conversation", async () => {
    const { gateway, client, state } = fixture();
    client.waitForFinish = mock(() => new Promise<WaitForFinishResult>(() => {}));
    state.agent.status = "running";
    state.agent.activeTurn = { turnId: "interrupted-turn", startedAt: null };
    const controller = new AbortController();
    const waiting = gateway.wait("agent-1", 2000, () => {}, controller.signal);
    controller.abort();
    expect(await waiting).toEqual({ status: "failed", output: "", error: "Paseo execution canceled" });
    expect(await gateway.inspect("agent-1")).toMatchObject({ active: false, pendingPermissionCount: 0 });
    expect((await gateway.inspect("agent-1"))?.archived).toBe(false);
  });

  test("reports provider errors instead of success", async () => {
    const { gateway, state } = fixture();
    state.result = { status: "error", error: "Provider stopped", final: null, lastMessage: null };
    expect(await gateway.wait("agent-1", 1000, () => {}, new AbortController().signal)).toEqual({ status: "failed", output: "Implemented.", evidence: { toolCallCount: 0, historyComplete: true }, error: "Paseo provider reported an error" });
  });

  test("inspection retains archive state and assistant history after restart", async () => {
    const { gateway, state } = fixture();
    state.agent = { ...state.agent, archivedAt: "2026-01-02T00:00:00Z" };
    expect(await gateway.inspect("agent-1")).toEqual({ id: "agent-1", workspaceId: "workspace-1", cwd: root, provider: "alpha", model: "a-default", modeId: "review", pendingPermissionCount: 0, active: false, archived: true, error: undefined, lastMessage: "Implemented." });
  });

  test("closing a borrowed API does not dispose its owner's connection", async () => {
    const { gateway, api } = fixture();
    let disposals = 0;
    api.dispose = mock(async () => { disposals++; });
    const borrowed = gateway.withApi(api);
    await borrowed.close();
    expect(disposals).toBe(0);
  });
});

test("refuses remote plaintext daemon credentials before opening the connection", async () => {
  await expect(connectGateway({ ...defaults(), paseoConnectionMode: "manual", paseoUrl: "ws://203.0.113.17:6767/ws" }, { paseoPassword: "private-password" })).rejects.toBeInstanceOf(ConfigurationError);
});

test("unknown MCP capability cannot prevent a core coding session from being created", async () => {
  const { gateway, api, state, input } = fixture();
  api.agents.list = staticAgentList({ requestId: "sessions", entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  api.agents.create = mock(async (options: PaseoAgentCreateOptions) => {
    if (options.config.mcpServers) throw new Error("Provider does not support MCP");
    state.agent = { ...state.agent, labels: options.labels ?? {} };
    return api.agents.ref(state.agent);
  });
  const config = { ...input.config, mcp: { enabled: true, url: "https://example.invalid/mcp", providers: ["alpha"], preapprovedTools: [] } };
  expect(await gateway.create({ ...input, config, mcpToken: "separate-secret" })).toMatchObject({ id: "agent-1", provider: "alpha", cwd: root, archived: false });
});

test("returns the final assistant answer separately from commentary and counts native tool calls", async () => {
  const { gateway, state } = fixture();
  state.items = [
    { type: "user_message", text: "Task", clientMessageId: "accepted-message" },
    { type: "assistant_message", text: "I will inspect the checkout." },
    { type: "tool_call", callId: "one", name: "read", detail: { type: "unknown", input: {}, output: "file" }, status: "completed", error: null },
    { type: "assistant_message", text: "READY" },
  ];
  const result = await gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "accepted-message");
  expect(result).toMatchObject({ status: "success", output: "READY", evidence: { toolCallCount: 1, historyComplete: true } });
});

test("missing turn boundary does not borrow a previous answer or assert a no-tools pass", async () => {
  const { gateway, state } = fixture();
  state.items = [{ type: "user_message", text: "Earlier", messageId: "previous" }, { type: "assistant_message", text: "OLD ANSWER" }];
  const result = await gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "new-request");
  expect(result).toMatchObject({ output: "", evidence: { toolCallCount: null, historyComplete: false } });
});

test("permission cancellation denies only requests on the canceled session and requires idle acknowledgment", async () => {
  const { gateway, client, state } = fixture();
  state.agent.pendingPermissions = [{ id: "permission-1", provider: "alpha", name: "write", kind: "tool" }];
  const denied: { agentId: string; requestId: string; response: unknown }[] = [];
  client.respondToPermission = mock(async (agentId, requestId, response) => {
    denied.push({ agentId, requestId, response });
    state.agent.pendingPermissions = [];
  });
  await gateway.cancel("agent-1");
  expect(denied).toEqual([{ agentId: "agent-1", requestId: "permission-1", response: { behavior: "deny", interrupt: true, message: "This integration execution was canceled." } }]);
  expect(await gateway.inspect("agent-1")).toMatchObject({ active: false, pendingPermissionCount: 0 });
});

test("a cancellation transport acknowledgment is not proof that the native turn stopped", async () => {
  const { api, state } = fixture();
  state.agent.status = "running";
  state.agent.activeTurn = { turnId: "still-running", startedAt: null };
  const gateway = new PaseoGateway(api, async () => {});
  await expect(gateway.cancel("agent-1")).rejects.toThrow("Native cancellation is unconfirmed");
  expect(await gateway.inspect("agent-1")).toMatchObject({ active: true });
});

test("history gaps preserve unknown tool evidence even when the requested final answer is visible", async () => {
  const { gateway, client, state } = fixture();
  const fetch = client.fetchAgentTimeline.bind(client);
  client.fetchAgentTimeline = mock(async (id: string, options?: FetchAgentTimelineOptions) => ({ ...await fetch(id, options), gap: true }));
  state.items[0] = { type: "user_message", text: "Task", clientMessageId: "requested" };
  const result = await gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested");
  expect(result).toMatchObject({ output: "Implemented.", evidence: { toolCallCount: 0, historyComplete: false } });
});

test("history pagination can establish a complete requested turn across older pages", async () => {
  const { gateway, client, state } = fixture();
  state.items = [
    { type: "user_message", text: "Task", messageId: "boundary" },
    { type: "tool_call", callId: "read-1", name: "read", detail: { type: "unknown", input: {}, output: {} }, status: "completed", error: null },
    { type: "assistant_message", text: "FINAL" },
  ];
  const fetch = client.fetchAgentTimeline.bind(client);
  client.fetchAgentTimeline = mock(async (id: string, options?: FetchAgentTimelineOptions): Promise<FetchAgentTimelinePayload> => {
    const page = await fetch(id, options);
    return options?.direction === "before"
      ? { ...page, direction: "before", entries: page.entries.slice(0, 1), hasNewer: true }
      : { ...page, entries: page.entries.slice(1), hasOlder: true, startCursor: { epoch: "one", seq: 1 } };
  });
  expect(await gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "boundary")).toMatchObject({
    output: "FINAL", evidence: { toolCallCount: 1, historyComplete: true },
  });
});

test("blank configured model uses the owning-daemon default adapter and records the native resolved selection", async () => {
  const { api, state, input } = fixture();
  const providers: string[] = [];
  const gateway = new PaseoGateway(api, async () => {}, undefined, async (options) => {
    if (!options.config) throw new Error("Native agent configuration is required");
    providers.push(options.config.provider);
    state.agent = { ...state.agent, labels: options.labels ?? {}, model: "daemon-selected-model" };
    return state.agent;
  });
  const config = { ...input.config, defaultModel: "" };
  const session = await gateway.create({ ...input, config, selection: { provider: "alpha", model: "", modeId: "review" } });
  expect(providers).toEqual(["alpha"]);
  expect(session).toMatchObject({ model: "daemon-selected-model", modeId: "review", provider: "alpha" });
});

test("pending approvals are denied before a cancellation that would otherwise reject acknowledgment", async () => {
  const { api, client, state } = fixture();
  state.agent.status = "running";
  state.agent.activeTurn = { turnId: "permission-blocked", startedAt: null };
  state.agent.pendingPermissions = [{ id: "blocked-write", provider: "alpha", name: "write", kind: "tool" }];
  client.respondToPermission = mock(async (_agentId, _requestId, response) => {
    expect(response.behavior).toBe("deny");
    state.agent.pendingPermissions = [];
  });
  const gateway = new PaseoGateway(api, async () => {
    if (state.agent.pendingPermissions.length) throw new Error("active run cancellation was not acknowledged");
    state.agent.status = "idle";
    state.agent.activeTurn = null;
  });
  await gateway.cancel("agent-1");
  expect(await gateway.inspect("agent-1")).toMatchObject({ active: false, pendingPermissionCount: 0 });
});

test("borrowed handler cancellation survives revocation of the handler API", async () => {
  const { gateway, client, state } = fixture();
  state.agent.status = "running";
  state.agent.activeTurn = { turnId: "owned-turn", startedAt: null };
  const context = createPaseoApi(client);
  context.agents.ref = () => { throw new Error("Plugin handler context revoked"); };
  const borrowed = gateway.withApi(context);
  await borrowed.cancel("agent-1");
  expect(await gateway.inspect("agent-1")).toMatchObject({ active: false, pendingPermissionCount: 0 });
  await context.dispose();
});

test("a missing native snapshot never confirms that cancellation finished", async () => {
  const { gateway, client } = fixture();
  client.fetchAgent = mock(async () => null);
  await expect(gateway.cancel("agent-1")).rejects.toThrow();
});
