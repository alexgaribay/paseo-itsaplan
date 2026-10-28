import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPaseoApi, type OwnedSubscription, type PaseoApi, type PaseoAgent, type PaseoAgentCreateOptions, type PaseoAgentSendOptions, type PaseoWorkspace, type PaseoWorkspaceHandle, type PaseoWorkspaceAgentCreateOptions, type PaseoWorkspaceCreateOptions, type PaseoAgentListResult, type PaseoAgentListOptions } from "@getpaseo/client";
import { DaemonClient, type FetchAgentTimelineOptions, type FetchAgentTimelinePayload, type WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { MutableDaemonConfigSchema, type AgentProfile } from "@getpaseo/protocol/messages";
import { defaults, projectMappingSchema } from "../shared/config";
import type { Config, ProjectMapping } from "../shared/config";
import type { AgUiEvent } from "../shared/models";
import type { TaskContextSnapshot } from "../shared/task-context";
import { connectGateway, PaseoGateway } from "./paseo";
import { ConfigurationError } from "./errors";
import type { Gateway } from "./contracts";

const execute = promisify(execFile);
let directory: string;
let root: string;
const connections: DaemonClient[] = [];

type TimelineListener = Parameters<DaemonClient["subscribeAgentTimeline"]>[1];
interface FixtureState {
  agent: PaseoAgent; exists: boolean; items: AgentTimelineItem[]; epoch: string; ready: Promise<void>;
  released: number; result: WaitForFinishResult; canceled: string[]; created: PaseoAgentCreateOptions[];
}
interface GatewayFixture {
  client: DaemonClient; api: PaseoApi; state: FixtureState; gateway: PaseoGateway; config: Config; project: ProjectMapping;
  input: Parameters<Gateway["create"]>[0]; listeners: Set<TimelineListener>;
  emit(message: Parameters<TimelineListener>[0]): void;
}

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

function fixture(existing = true): GatewayFixture {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "gateway-test", reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  connections.push(client);
  const api = createPaseoApi(client);
  const listeners = new Set<TimelineListener>();
  const state: FixtureState = {
    agent: {
      id: "agent-1", provider: "alpha", cwd: root, workspaceId: "workspace-1", model: "a-default",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastUserMessageAt: null,
      status: "idle", activeTurn: null, capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true, supportsMcpServers: true, supportsReasoningStream: true, supportsToolInvocations: true },
      currentModeId: "review", availableModes: [], pendingPermissions: [], persistence: null, title: "Task", labels: { "itsaplan.key": "hello" },
    },
    items: [{ type: "user_message", text: "Implement the task" }, { type: "assistant_message", text: "Implemented." }],
    exists: existing, epoch: "one", ready: Promise.resolve(), released: 0,
    result: { status: "idle", final: null, error: null, lastMessage: "Implemented." }, canceled: [], created: [],
  };
  client.fetchAgent = mock(async () => state.exists ? { agent: state.agent, project: null } : null);
  client.fetchAgentTimeline = mock(async (_id: string, options?: FetchAgentTimelineOptions): Promise<FetchAgentTimelinePayload> => {
    const entries = state.items.map((item, index) => ({ provider: state.agent.provider, item, timestamp: "2026-01-01T00:00:00Z", seqStart: index, seqEnd: index, sourceSeqRanges: [], collapsed: [] }));
    const selected = entries.filter((entry) => options?.cursor && options.direction === "before" ? entry.seqEnd < options.cursor.seq :
      options?.cursor && options.direction === "after" ? entry.seqStart > options.cursor.seq : true);
    const page = options?.direction === "after" ? selected.slice(0, options.limit ?? 100) : selected.slice(-(options?.limit ?? 100));
    return {
      requestId: "history", agentId: state.agent.id, agent: state.agent, direction: options?.direction ?? "tail", projection: "projected", epoch: state.epoch,
      reset: false, staleCursor: !!options?.cursor && options.cursor.epoch !== state.epoch, gap: false, window: { minSeq: 0, maxSeq: entries.length - 1, nextSeq: entries.length },
      startCursor: page.length ? { epoch: state.epoch, seq: page[0].seqStart } : null,
      endCursor: page.length ? { epoch: state.epoch, seq: page.at(-1)!.seqEnd } : null,
      hasOlder: !!page.length && page[0].seqStart > 0, hasNewer: !!page.length && page.at(-1)!.seqEnd < entries.length - 1,
      entries: page, error: null,
    };
  });
  client.subscribeAgentTimeline = mock((_id, handler) => {
    listeners.add(handler);
    let released = false;
    const release = async () => {
      if (!released) { state.released++; listeners.delete(handler); released = true; }
    };
    return Object.assign(() => { void release(); }, { ready: state.ready, release, subscriptionId: "timeline-subscription" });
  });
  client.sendAgentMessage = mock(async (_id, text, options) => {
    state.items = [{ type: "user_message", text, clientMessageId: options?.messageId }, { type: "assistant_message", text: "Implemented." }];
    return {};
  });
  client.waitForFinish = mock(async () => ({ ...state.result, final: state.result.final ?? state.agent }));
  api.providers.listAvailable = mock(async () => ({ providers: [{ provider: "alpha", available: true }, { provider: "beta", available: true }, { provider: "offline", available: false }], requestId: "available", fetchedAt: "now" }));
  api.providers.listModels = mock(async (provider: string) => ({ provider, requestId: "models", fetchedAt: "now", models: provider === "alpha"
    ? [{ provider, id: "a-default", label: "Alpha default", isDefault: true }, { provider, id: "a-project", label: "Alpha project" }, { provider, id: "a-override", label: "Alpha override" }]
    : [{ provider, id: "b-default", label: "Beta default", isDefault: true }] }));
  api.providers.listModes = mock(async (provider: string) => ({ provider, requestId: "modes", fetchedAt: "now", modes: [{ id: "review", label: "Review" }, { id: "plan", label: "Plan" }] }));
  api.agents.create = mock(async (options: PaseoAgentCreateOptions) => {
    state.created.push(options);
    state.exists = true;
    state.agent = { ...state.agent, cwd: options.cwd, labels: options.labels ?? {} };
    return api.agents.ref(state.agent);
  });
  const cancel = mock(async (id: string) => { state.canceled.push(id); state.agent = { ...state.agent, status: "idle", activeTurn: null }; });
  const gateway = new PaseoGateway(api, cancel, () => api.dispose());
  const config = { ...defaults(), defaultProvider: "alpha", defaultModel: "a-default", defaultModeId: "review" };
  const project = projectMappingSchema.parse({ repository: root, worktree: false });
  const input = { key: "hello", agentId: "agent-1", title: "Do not put this issue title in a branch", project, selection: { provider: "alpha", model: "a-default", modeId: "review" }, systemPrompt: "Issue text", config, issueId: 42 };
  const emit = (message: Parameters<Parameters<DaemonClient["subscribeAgentTimeline"]>[1]>[0]) => {
    for (const listener of listeners) listener(message);
  };
  return { client, api, state, gateway, config, project, input, emit, listeners };
}

function profileConfig(api: PaseoApi, profiles: AgentProfile[]) {
  api.config.get = mock(async () => ({
    requestId: "profiles",
    config: MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false }, providers: { alpha: { apiKey: "do-not-expose" } },
      agentProfiles: profiles,
    }),
  }));
}

describe("named local Paseo profiles", () => {
  test("uses the entire named bundle instead of shared or request overrides and exposes only safe profile data", async () => {
    const { gateway, api, config, project } = fixture();
    profileConfig(api, [{ id: "worker", name: "Careful worker", provider: "alpha", model: "a-default", modeId: "review", thinkingOptionId: "deep", featureValues: { sandbox: true }, notes: "Private profile notes" }]);
    const selected = await gateway.select({ ...config, profileId: "worker", defaultProvider: "beta" }, { ...project, model: "a-project" }, { provider: "beta", model: "b-default", modeId: "plan" });
    expect(selected).toEqual({ profileId: "worker", profileName: "Careful worker", provider: "alpha", model: "a-default", modeId: "review", thinkingOptionId: "deep", featureValues: { sandbox: true } });
    expect(await gateway.profiles()).toEqual([{ profileId: "worker", profileName: "Careful worker", provider: "alpha", model: "a-default", modeId: "review", thinkingOptionId: "deep", featureValues: { sandbox: true } }]);
  });

  test("rejects a missing or invalid profile without falling back to legacy defaults", async () => {
    const { gateway, api, config, project } = fixture();
    profileConfig(api, []);
    await expect(gateway.select({ ...config, profileId: "deleted" }, project)).rejects.toThrow("missing or was deleted");
    profileConfig(api, [{ id: "broken", name: "Broken profile", provider: "alpha/a-default" }]);
    await expect(gateway.select({ ...config, profileId: "broken" }, project)).rejects.toThrow("profile configuration is invalid");
    profileConfig(api, [{ id: "worker", name: "Worker", provider: "alpha" }]);
    expect(await gateway.select({ ...config, profileId: "worker" }, project)).toEqual({ profileId: "worker", profileName: "Worker", provider: "alpha", model: "", modeId: "" });
  });

  test("creates the captured explicit-model bundle even when the profile or bot binding has changed", async () => {
    const { gateway, api, config, project, state, input } = fixture(false);
    profileConfig(api, [{ id: "worker", name: "Worker", provider: "alpha", model: "a-default", modeId: "review", thinkingOptionId: "deep", featureValues: { sandbox: true } }]);
    const runtime = { ...config, profileId: "worker" };
    const selection = await gateway.select(runtime, project);
    profileConfig(api, [{ id: "worker", name: "Changed worker", provider: "beta", model: "b-default", modeId: "plan" }]);
    expect(await gateway.create({ ...input, config: { ...runtime, profileId: "replacement" }, selection })).toMatchObject({ provider: "alpha", model: "a-default", modeId: "review" });
    expect(state.created[0]?.config).toMatchObject({ provider: "alpha/a-default", modeId: "review", thinkingOptionId: "deep", featureValues: { sandbox: true } });
  });

  test("passes captured thinking and feature settings through provider-default creation", async () => {
    const { api, config, project, state, input } = fixture(false);
    profileConfig(api, [{ id: "worker", name: "Default-model worker", provider: "alpha", thinkingOptionId: "deep", featureValues: { sandbox: false } }]);
    let created: unknown;
    const gateway = new PaseoGateway(api, async () => {}, undefined, async (options) => {
      created = options.config;
      state.exists = true;
      state.agent = { ...state.agent, labels: options.labels ?? {}, model: "daemon-selected-model" };
      return state.agent;
    });
    const runtime = { ...config, profileId: "worker" };
    const selection = await gateway.select(runtime, project);
    profileConfig(api, []);
    expect(await gateway.create({ ...input, config: runtime, selection })).toMatchObject({ provider: "alpha", model: "daemon-selected-model" });
    expect(created).toMatchObject({ provider: "alpha", thinkingOptionId: "deep", featureValues: { sandbox: false } });
  });

  test("does not reuse an idempotent native session with unverified or changed profile settings", async () => {
    const { gateway, state, input } = fixture();
    const selection = { ...input.selection, profileId: "worker", profileName: "Worker", thinkingOptionId: "deep", featureValues: { sandbox: true } };
    const bound = { ...input, config: { ...input.config, profileId: "worker" }, selection };
    await expect(gateway.create(bound)).rejects.toThrow("cannot be verified");
    state.agent.thinkingOptionId = "deep";
    state.agent.features = [{ id: "sandbox", type: "toggle", label: "Sandbox", value: true }];
    expect(await gateway.create(bound)).toMatchObject({ thinkingOptionId: "deep", featureValues: { sandbox: true } });
    state.agent.features[0]!.value = false;
    await expect(gateway.create(bound)).rejects.toThrow("Start a fresh thread");
  });
});

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
    const { gateway, state, input } = fixture(false);
    expect(await gateway.create(input)).toEqual({ id: "agent-1", workspaceId: "workspace-1", cwd: root, provider: "alpha", model: "a-default", modeId: "review", pendingPermissionCount: 0, lastUserMessageAt: null, active: false, archived: false, error: undefined });
    expect(state.created[0]).toMatchObject({ idempotencyKey: "hello", agentId: "agent-1", cwd: root, labels: { "itsaplan.key": "hello", "itsaplan.issueId": "42" }, config: { provider: "alpha/a-default", modeId: "review" } });
    expect(Object.hasOwn(state.created[0], "prompt")).toBe(false);
  });

  test("supports native worktree slug normalization without leaving the mapped repository", async () => {
    const { gateway, api, state, input } = fixture(false);
    const checkout = join(root, "task-worktree");
    api.agents.create = mock(async (options: PaseoAgentCreateOptions) => {
      state.created.push(options);
      state.exists = true;
      const worktree = options.worktree;
      if (!worktree || worktree.mode !== "branch-off") throw new Error("Expected a native branch-off request");
      await execute("git", ["-C", root, "worktree", "add", "-b", worktree.newBranch.replaceAll("/", "-"), checkout, worktree.base ?? "HEAD"]);
      state.agent = { ...state.agent, cwd: checkout, labels: options.labels ?? {} };
      return api.agents.ref(state.agent);
    });
    expect((await gateway.create({ ...input, project: { ...input.project, worktree: true, baseBranch: "main" } })).cwd).toBe(checkout);
    expect((await execute("git", ["-C", checkout, "branch", "--show-current"])).stdout.trim()).toBe("itsaplan-2cf24dba5fb0a30e26e83b2a");
  });

  test("refuses missing configured workspaces before agent creation", async () => {
    const { gateway, api, state, input } = fixture(false);
    const workspace = api.workspaces.ref("missing-workspace");
    workspace.refresh = mock(async () => null);
    api.workspaces.ref = mock(() => workspace);
    await expect(gateway.create({ ...input, project: { ...input.project, workspaceId: "missing-workspace" } })).rejects.toThrow("Configured workspace does not match");
    expect(state.created).toEqual([]);
  });

  test("targets a validated existing workspace when worktree isolation is disabled", async () => {
    const { gateway, api, state, input } = fixture(false);
    const descriptor: PaseoWorkspace = {
      id: "workspace-1", projectId: "project-1", projectDisplayName: "Project", projectRootPath: root,
      workspaceDirectory: root, projectKind: "git", workspaceKind: "local_checkout", name: "Main",
      archivingAt: null, status: "done", statusEnteredAt: null, activityAt: null, scripts: [],
    };
    const workspace = api.workspaces.ref(descriptor);
    workspace.refresh = mock(async () => descriptor);
    workspace.agents.create = mock(async (options: PaseoWorkspaceAgentCreateOptions) => {
      state.created.push({ ...options, cwd: root });
      state.exists = true;
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
    const { gateway, api, state, input } = fixture(false);
    const foreign = join(root, "foreign");
    await mkdir(foreign);
    await execute("git", ["init", foreign]);
    api.agents.create = mock(async () => { state.exists = true; state.agent = { ...state.agent, cwd: foreign }; return api.agents.ref(state.agent); });
    await expect(gateway.create(input)).rejects.toThrow("Created agent checkout does not match");
    expect((await gateway.inspect("agent-1"))?.active).toBe(false);
    expect((await gateway.inspect("agent-1"))?.archived).toBe(false);
  });

  test("injects only opted-in HTTP MCP with exact preapprovals and its separate credential", async () => {
    const { gateway, api, state, input } = fixture(false);
    api.agents.list = staticAgentList({ requestId: "sessions", entries: [{
      agent: state.agent,
      project: { projectKey: "project", projectName: "Project", checkout: { cwd: root, isGit: true, currentBranch: "main", remoteUrl: null, worktreeRoot: root, isPaseoOwnedWorktree: false, mainRepoRoot: null } },
    }], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
    const config = { ...input.config, mcp: { enabled: true, url: "https://example.invalid/mcp", providers: ["alpha"], preapprovedTools: ["get_issue"] } };
    await gateway.create({ ...input, config, mcpToken: "separate-mcp-secret" });
    expect(state.created[0].config.mcpServers).toEqual({ itsaplan: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer separate-mcp-secret" } } });
    expect(state.created[0].config.toolPolicy).toEqual({ preapproved: [{ kind: "mcp", server: "itsaplan", tool: "get_issue" }] });
    state.exists = false;
    await gateway.create({ ...input, config: { ...config, mcp: { ...config.mcp, providers: [] } }, mcpToken: "separate-mcp-secret" });
    expect(state.created[1].config.mcpServers).toBeUndefined();
  });

  test("omits optional MCP when existing provider evidence says it is unsupported", async () => {
    const { gateway, api, state, input } = fixture(false);
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
      state.items = [{ type: "user_message", text, clientMessageId: options?.messageId }];
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
    await gateway.send("agent-1", "Task", "permission-turn");
    state.result.status = "permission";
    state.agent.status = "running";
    state.agent.activeTurn = { turnId: "waiting-for-permission", startedAt: null };
    const result = await gateway.wait("agent-1", 25, () => {}, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", error: "Paseo execution timed out" });
    expect(await gateway.inspect("agent-1")).toMatchObject({ active: false, pendingPermissionCount: 0 });
  });

  test("aborts a pending lifecycle wait and preserves the conversation", async () => {
    const { gateway, client, state } = fixture();
    await gateway.send("agent-1", "Task", "aborted-turn");
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
    expect(await gateway.inspect("agent-1")).toEqual({ id: "agent-1", workspaceId: "workspace-1", cwd: root, provider: "alpha", model: "a-default", modeId: "review", pendingPermissionCount: 0, lastUserMessageAt: null, active: false, archived: true, error: undefined, lastMessage: "Implemented." });
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
  const { gateway, api, state, input } = fixture(false);
  api.agents.list = staticAgentList({ requestId: "sessions", entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  api.agents.create = mock(async (options: PaseoAgentCreateOptions) => {
    if (options.config.mcpServers) throw new Error("Provider does not support MCP");
    state.exists = true;
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
  const { api, state, input } = fixture(false);
  const providers: string[] = [];
  const gateway = new PaseoGateway(api, async () => {}, undefined, async (options) => {
    if (!options.config) throw new Error("Native agent configuration is required");
    providers.push(options.config.provider);
    state.exists = true;
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

function nativeWorktree(value: GatewayFixture) {
  const requests: PaseoWorkspaceCreateOptions[] = [];
  const checkout = join(root, "explicit-worktree");
  let workspace: PaseoWorkspaceHandle | undefined;
  value.api.workspaces.create = mock(async (options) => {
    requests.push(options);
    if (workspace) return workspace;
    if (options.source.kind !== "worktree" || !options.source.branchName) throw new Error("Expected an explicit native branch");
    await execute("git", ["-C", root, "worktree", "add", "-b", options.source.branchName, checkout, options.source.baseBranch ?? "HEAD"]);
    const descriptor: PaseoWorkspace = {
      id: "explicit-workspace", projectId: "project-1", projectDisplayName: "Project", projectRootPath: root,
      workspaceDirectory: checkout, projectKind: "git", workspaceKind: "worktree", name: "Task",
      archivingAt: null, status: "done", statusEnteredAt: null, activityAt: null, scripts: [],
    };
    workspace = value.api.workspaces.ref(descriptor);
    workspace.refresh = mock(async () => descriptor);
    workspace.agents.create = mock(async (agentOptions) => {
      value.state.created.push({ ...agentOptions, cwd: checkout });
      value.state.exists = true;
      value.state.agent = { ...value.state.agent, cwd: checkout, workspaceId: descriptor.id, labels: agentOptions.labels ?? {} };
      return value.api.agents.ref(value.state.agent);
    });
    return workspace;
  });
  return { requests, checkout };
}

describe("explicit task branches", () => {
  test("preserves the exact canonical issue branch through the native workspace API", async () => {
    const value = fixture(false);
    const { requests, checkout } = nativeWorktree(value);
    const session = await value.gateway.create({ ...value.input, branchName: "TW-42-itsaplan-a1b2c3", project: { ...value.project, worktree: true, baseBranch: "main" } });
    expect(session).toMatchObject({ id: "agent-1", cwd: checkout, workspaceId: "explicit-workspace" });
    expect((await execute("git", ["-C", checkout, "branch", "--show-current"])).stdout.trim()).toBe("TW-42-itsaplan-a1b2c3");
    expect(requests).toEqual([{
      idempotencyKey: "hello:workspace",
      source: { kind: "worktree", cwd: root, action: "branch-off", branchName: "TW-42-itsaplan-a1b2c3", worktreeSlug: "tw-42-itsaplan-a1b2c3", baseBranch: "main" },
    }]);
    expect(value.state.created[0]).toMatchObject({ idempotencyKey: "hello", agentId: "agent-1", cwd: checkout });
    expect(value.state.created[0].worktree).toBeUndefined();
  });

  test("reconciles a legacy checkout before new branch validation or provider catalog lookup", async () => {
    const value = fixture();
    const checkout = join(root, "legacy-worktree");
    await execute("git", ["-C", root, "worktree", "add", "-b", "itsaplan-legacy-hash", checkout, "main"]);
    value.state.agent.cwd = checkout;
    value.api.providers.listAvailable = mock(async () => { throw new Error("Do not reselect an existing native agent"); });
    value.api.workspaces.create = mock(async () => { throw new Error("Do not replace an existing native checkout"); });
    const input = { ...value.input, branchName: "invalid..new-name", project: { ...value.project, worktree: true, baseBranch: "invalid..base" } };
    expect(await value.gateway.create(input)).toMatchObject({ id: "agent-1", cwd: checkout, provider: "alpha" });
    expect(await value.gateway.create({ ...input, title: "New display title" })).toMatchObject({ id: "agent-1", cwd: checkout });
    expect((await execute("git", ["-C", checkout, "branch", "--show-current"])).stdout.trim()).toBe("itsaplan-legacy-hash");
    expect(value.state.created).toEqual([]);
    expect(value.state.canceled).toEqual([]);
  });

  test("reconciles a newly created exact branch without another native workspace", async () => {
    const value = fixture(false);
    const { checkout, requests } = nativeWorktree(value);
    const input = { ...value.input, branchName: "KEY-9-itsaplan-123456", project: { ...value.project, worktree: true } };
    await value.gateway.create(input);
    expect(await value.gateway.create(input)).toMatchObject({ cwd: checkout, workspaceId: "explicit-workspace" });
    expect(requests.map((request) => request.idempotencyKey)).toEqual(["hello:workspace"]);
    expect(value.state.created.map((request) => request.agentId)).toEqual(["agent-1"]);
  });

  test("recovers an idempotent workspace after agent registration failed", async () => {
    const value = fixture(false);
    const { checkout, requests } = nativeWorktree(value);
    const createWorkspace = value.api.workspaces.create;
    let fail = true;
    value.api.workspaces.create = mock(async (options) => {
      const workspace = await createWorkspace(options);
      const create = workspace.agents.create;
      if (fail) workspace.agents.create = async () => { workspace.agents.create = create; fail = false; throw new Error("Registration rejected"); };
      return workspace;
    });
    const input = { ...value.input, branchName: "TW-42-itsaplan-recover", project: { ...value.project, worktree: true } };
    await expect(value.gateway.create(input)).rejects.toThrow("Registration rejected");
    expect(await value.gateway.create(input)).toMatchObject({ cwd: checkout, id: "agent-1" });
    expect(requests.map((request) => request.idempotencyKey)).toEqual(["hello:workspace", "hello:workspace"]);
    expect((await execute("git", ["-C", checkout, "branch", "--show-current"])).stdout.trim()).toBe("TW-42-itsaplan-recover");
  });

  for (const branchName of ["bad..branch", "-unsafe", "refs/heads/../main", "itsaplan/KEY-1.lock", "@{-1}", "line\nbreak"]) {
    test(`rejects an invalid requested branch without changing the source checkout ${JSON.stringify(branchName)}`, async () => {
      const value = fixture(false);
      const { requests } = nativeWorktree(value);
      await expect(value.gateway.create({ ...value.input, branchName, project: { ...value.project, worktree: true } })).rejects.toThrow("Task branch is invalid");
      expect((await execute("git", ["-C", root, "branch", "--show-current"])).stdout.trim()).toBe("main");
      expect(requests).toEqual([]);
      expect(value.state.created).toEqual([]);
    });
  }

  test("does not interrupt a native agent with a stale or foreign task association", async () => {
    const value = fixture();
    value.state.agent = { ...value.state.agent, labels: { "itsaplan.key": "someone-else" }, status: "running", activeTurn: { turnId: "human-turn", startedAt: null } };
    await expect(value.gateway.create({ ...value.input, branchName: "TW-42-itsaplan-new" })).rejects.toThrow("conflicting task association");
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ id: "agent-1", active: true, archived: false });
    expect(value.state.canceled).toEqual([]);
    expect(value.state.created).toEqual([]);
  });

  test("refuses a normalized alias when the workspace did not preserve the requested ref", async () => {
    const value = fixture(false);
    const { checkout } = nativeWorktree(value);
    const createWorkspace = value.api.workspaces.create;
    value.api.workspaces.create = mock(async (options) => {
      const workspace = await createWorkspace(options);
      await execute("git", ["-C", checkout, "branch", "-m", "native-normalization-staging"]);
      await execute("git", ["-C", checkout, "branch", "-m", "tw-42-itsaplan-normalized"]);
      return workspace;
    });
    await expect(value.gateway.create({ ...value.input, branchName: "TW-42-itsaplan-normalized", project: { ...value.project, worktree: true } })).rejects.toBeInstanceOf(ConfigurationError);
    expect((await execute("git", ["-C", checkout, "branch", "--show-current"])).stdout.trim()).toBe("tw-42-itsaplan-normalized");
    expect(value.state.created).toEqual([]);
    expect(value.state.canceled).toEqual([]);
  });
});

function stream(value: GatewayFixture, item: AgentTimelineItem, seq: number, turnId = "requested-turn", agentId = "agent-1") {
  value.emit({
    type: "agent_stream",
    payload: { agentId, timestamp: "2026-01-01T00:00:00Z", epoch: value.state.epoch, seq, event: { type: "timeline", provider: value.state.agent.provider, item, turnId } },
  });
}

describe("normalized native tool activity", () => {
  const examples: { provider: string; tool: Extract<AgentTimelineItem, { type: "tool_call" }>; args: string; result: string }[] = [
    { provider: "omp", tool: { type: "tool_call", callId: "native-tool", name: "read", status: "completed", error: null, detail: { type: "unknown", input: { path: "README.md" }, output: { content: [{ type: "text", text: "file" }] } } }, args: '{"path":"README.md"}', result: '{"content":[{"type":"text","text":"file"}]}' },
    { provider: "codex", tool: { type: "tool_call", callId: "native-tool", name: "exec_command", status: "completed", error: null, detail: { type: "shell", command: "pwd", cwd: "/repo", output: "/repo\n", exitCode: 0 } }, args: '{"command":"pwd","cwd":"/repo"}', result: "/repo\n" },
    { provider: "claude", tool: { type: "tool_call", callId: "native-tool", name: "Read", status: "completed", error: null, detail: { type: "read", filePath: "README.md", offset: 1, limit: 2, content: "hello" } }, args: '{"filePath":"README.md","offset":1,"limit":2}', result: "hello" },
  ];
  for (const example of examples) {
    test(`normalizes ${example.provider} SDK tool snapshots without parsing a provider envelope`, async () => {
      const value = fixture();
      value.state.agent.provider = example.provider;
      const boundary: AgentTimelineItem = { type: "user_message", text: "Task", clientMessageId: "requested" };
      const assistant: AgentTimelineItem = { type: "assistant_message", text: "Checking.", messageId: "assistant-1" };
      value.state.items = [boundary, assistant, example.tool, { type: "assistant_message", text: "DONE" }];
      value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
        stream(value, boundary, 0);
        stream(value, assistant, 1);
        stream(value, { ...example.tool, status: "running", error: null }, 2);
        stream(value, example.tool, 3);
        stream(value, example.tool, 3);
        return { ...value.state.result, final: value.state.agent };
      });
      const events: AgUiEvent[] = [];
      const result = await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested", (event) => events.push(event));
      expect(result).toMatchObject({ status: "success", output: "DONE", evidence: { toolCallCount: 1, historyComplete: true } });
      expect(events).toEqual([
        { type: "TOOL_CALL_START", toolCallId: "native-tool", toolCallName: example.tool.name, parentMessageId: "assistant-1" },
        { type: "TOOL_CALL_ARGS", toolCallId: "native-tool", delta: example.args },
        { type: "TOOL_CALL_END", toolCallId: "native-tool" },
        { type: "TOOL_CALL_RESULT", toolCallId: "native-tool", messageId: "native-tool", content: example.result, role: "tool" },
      ]);
      expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 0, releases: 1 });
    });
  }

  test("captures a completed tool before send acknowledgment and deduplicates its recovered history", async () => {
    const value = fixture();
    const boundary: AgentTimelineItem = { type: "user_message", text: "Task", clientMessageId: "requested" };
    const tool: Extract<AgentTimelineItem, { type: "tool_call" }> = { type: "tool_call", callId: "early-tool", name: "read", status: "completed", error: null, detail: { type: "unknown", input: { path: "file" }, output: "real content" } };
    value.client.sendAgentMessage = mock(async () => {
      stream(value, boundary, 0);
      stream(value, { ...tool, status: "running", error: null }, 1);
      stream(value, tool, 2);
      value.state.items = [boundary, tool, { type: "assistant_message", text: "EARLY" }];
      return {};
    });
    const release = await value.gateway.observe("agent-1", "requested", new AbortController().signal);
    await value.gateway.send("agent-1", "Task", "requested");
    const events: AgUiEvent[] = [];
    expect(await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ status: "success", output: "EARLY" });
    await release();
    await release();
    expect(events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "early-tool", toolCallName: "read" },
      { type: "TOOL_CALL_ARGS", toolCallId: "early-tool", delta: '{"path":"file"}' },
      { type: "TOOL_CALL_END", toolCallId: "early-tool" },
      { type: "TOOL_CALL_RESULT", toolCallId: "early-tool", messageId: "early-tool", content: "real content", role: "tool" },
    ]);
    expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 0, releases: 1 });
  });

  test("emits settled whole arguments and does not manufacture a result for missing or canceled output", async () => {
    const value = fixture();
    const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
    const events: AgUiEvent[] = [];
    value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
      stream(value, boundary, 0);
      stream(value, { type: "tool_call", callId: "partial", name: "mcp", status: "running", error: null, detail: { type: "unknown", input: { token: "sec" }, output: null } }, 1);
      expect(events).toEqual([{ type: "TOOL_CALL_START", toolCallId: "partial", toolCallName: "mcp" }]);
      stream(value, { type: "tool_call", callId: "partial", name: "mcp", status: "canceled", error: null, detail: { type: "unknown", input: { token: "secret-complete" }, output: null } }, 2);
      value.state.items = [boundary, { type: "assistant_message", text: "Stopped by the provider." }];
      return { ...value.state.result, final: value.state.agent };
    });
    expect(await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "Stopped by the provider." });
    expect(events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "partial", toolCallName: "mcp" },
      { type: "TOOL_CALL_ARGS", toolCallId: "partial", delta: '{"token":"secret-complete"}' },
      { type: "TOOL_CALL_END", toolCallId: "partial" },
    ]);
  });

  test("filters unrelated tool events and refuses a success claim after a later human turn", async () => {
    const value = fixture();
    const tool = (callId: string): Extract<AgentTimelineItem, { type: "tool_call" }> => ({ type: "tool_call", callId, name: "read", status: "completed", error: null, detail: { type: "unknown", input: {}, output: callId } });
    const boundary: AgentTimelineItem = { type: "user_message", text: "Task", clientMessageId: "requested" };
    value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
      stream(value, tool("before-boundary"), 0, "previous");
      stream(value, boundary, 1);
      stream(value, tool("other-agent"), 2, "requested-turn", "foreign-agent");
      stream(value, tool("wrong-turn"), 2, "different-turn");
      stream(value, tool("own-tool"), 3);
      stream(value, { type: "user_message", text: "Human follow-up", messageId: "later" }, 4, "later-turn");
      stream(value, tool("later-live"), 5, "later-turn");
      value.state.items = [
        { type: "user_message", text: "Earlier", messageId: "previous" }, tool("previous-history"),
        boundary, tool("own-tool"), { type: "assistant_message", text: "OWN ANSWER" },
        { type: "user_message", text: "Human follow-up", messageId: "later" }, tool("later-history"), { type: "assistant_message", text: "OTHER ANSWER" },
      ];
      return { ...value.state.result, final: value.state.agent };
    });
    const events: AgUiEvent[] = [];
    const result = await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested", (event) => events.push(event));
    expect(result).toMatchObject({ status: "failed", output: "OWN ANSWER", evidence: { toolCallCount: 1, historyComplete: false } });
    expect(events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "own-tool", toolCallName: "read" },
      { type: "TOOL_CALL_ARGS", toolCallId: "own-tool", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "own-tool" },
      { type: "TOOL_CALL_RESULT", toolCallId: "own-tool", messageId: "own-tool", content: "own-tool", role: "tool" },
    ]);
  });

  test("recovers reconnect cursor gaps and emits each native lifecycle only once", async () => {
    const value = fixture();
    const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
    const running: Extract<AgentTimelineItem, { type: "tool_call" }> = { type: "tool_call", callId: "recovered", name: "read", status: "running", error: null, detail: { type: "read", filePath: "file" } };
    const completed: AgentTimelineItem = { ...running, status: "completed", detail: { type: "read", filePath: "file", content: "recovered content" } };
    value.state.items = [boundary, running];
    let round = 0;
    const cursors: FetchAgentTimelineOptions[] = [];
    const fetch = value.client.fetchAgentTimeline.bind(value.client);
    value.client.fetchAgentTimeline = mock(async (id, options) => {
      if (options?.direction === "after") cursors.push(options);
      return fetch(id, options);
    });
    value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
      if (++round === 1) return { ...value.state.result, status: "timeout", final: { ...value.state.agent, status: "running" } };
      value.emit({ type: "agent.timeline.subscription_restored", payload: { agentId: "agent-1", subscriptionId: "restored" } });
      value.state.items = [boundary, running, completed, { type: "assistant_message", text: "RECOVERED" }];
      return { ...value.state.result, final: value.state.agent };
    });
    const events: AgUiEvent[] = [];
    expect(await value.gateway.wait("agent-1", 2000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "RECOVERED", evidence: { toolCallCount: 1, historyComplete: true } });
    expect(cursors).toEqual([{ direction: "after", cursor: { epoch: "one", seq: 1 }, projection: "projected", limit: 100 }]);
    expect(events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "recovered", toolCallName: "read" },
      { type: "TOOL_CALL_ARGS", toolCallId: "recovered", delta: '{"filePath":"file"}' },
      { type: "TOOL_CALL_END", toolCallId: "recovered" },
      { type: "TOOL_CALL_RESULT", toolCallId: "recovered", messageId: "recovered", content: "recovered content", role: "tool" },
    ]);
    expect(value.state.released).toBe(1);
  });

  test("recovers stale cursor epochs without repeating already emitted calls", async () => {
    const value = fixture();
    const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
    const tool: AgentTimelineItem = { type: "tool_call", callId: "stable-call", name: "read", status: "completed", error: null, detail: { type: "unknown", input: {}, output: "stable output" } };
    value.state.items = [boundary, tool];
    let round = 0;
    let staleReads = 0;
    const fetch = value.client.fetchAgentTimeline.bind(value.client);
    value.client.fetchAgentTimeline = mock(async (id, options) => {
      const page = await fetch(id, options);
      if (options?.direction === "after") { staleReads++; return { ...page, staleCursor: true }; }
      return page;
    });
    value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
      if (++round === 1) return { ...value.state.result, status: "timeout", final: { ...value.state.agent, status: "running" } };
      value.state.epoch = "two";
      value.emit({ type: "agent.timeline.subscription_restored", payload: { agentId: "agent-1", subscriptionId: "new-epoch" } });
      value.state.items = [boundary, tool, { type: "assistant_message", text: "NEW EPOCH" }];
      return { ...value.state.result, final: value.state.agent };
    });
    const events: AgUiEvent[] = [];
    expect(await value.gateway.wait("agent-1", 2000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "NEW EPOCH" });
    expect({ staleReads, eventTypes: events.map((event) => event.type), releases: value.state.released }).toEqual({ staleReads: 1, eventTypes: ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"], releases: 1 });
  });

  test("discards mixed-epoch pagination before exposing tool payloads", async () => {
    const value = fixture();
    const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
    const tool: AgentTimelineItem = { type: "tool_call", callId: "new-call", name: "read", status: "completed", error: null, detail: { type: "unknown", input: {}, output: "new payload" } };
    value.state.items = [boundary, tool, { type: "assistant_message", text: "CURRENT" }];
    const fetch = value.client.fetchAgentTimeline.bind(value.client);
    let tail = 0;
    value.client.fetchAgentTimeline = mock(async (id, options) => {
      const page = await fetch(id, options);
      if (options?.direction === "tail" && tail++ === 0) return { ...page, entries: [{ ...page.entries[1], item: { ...tool, callId: "stale-call" } }], hasOlder: true, startCursor: { epoch: "one", seq: 1 } };
      value.state.epoch = "two";
      return { ...page, epoch: "two", startCursor: { epoch: "two", seq: 0 }, endCursor: { epoch: "two", seq: 2 } };
    });
    const events: AgUiEvent[] = [];
    expect(await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "CURRENT" });
    expect(events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "new-call", toolCallName: "read" },
      { type: "TOOL_CALL_ARGS", toolCallId: "new-call", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "new-call" },
      { type: "TOOL_CALL_RESULT", toolCallId: "new-call", messageId: "new-call", content: "new payload", role: "tool" },
    ]);
  });

  test("keeps provider-looking assistant text as text when tool activity is not requested", async () => {
    const value = fixture();
    value.state.items = [{ type: "user_message", text: "Task", messageId: "requested" }, { type: "assistant_message", text: '{"type":"tool_call","name":"not-a-tool"}' }];
    const text: string[] = [];
    const release = await value.gateway.observe("agent-1", "requested", new AbortController().signal);
    expect(await value.gateway.wait("agent-1", 1000, (delta) => text.push(delta), new AbortController().signal, "requested")).toMatchObject({ output: '{"type":"tool_call","name":"not-a-tool"}', evidence: { toolCallCount: 0, historyComplete: true } });
    await release();
    expect(text).toEqual(['{"type":"tool_call","name":"not-a-tool"}']);
    expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 0, releases: 1 });
  });
});

describe("native observer ownership and teardown", () => {
  test("establishes the SDK subscription before the caller sends a task", async () => {
    const value = fixture();
    const established = Promise.withResolvers<void>();
    value.state.ready = established.promise;
    const observe = value.gateway.observe("agent-1", "requested", new AbortController().signal);
    const sent: string[] = [];
    value.client.sendAgentMessage = mock(async (_id, text) => { sent.push(text); return {}; });
    const sending = (async () => {
      const release = await observe;
      try { await value.gateway.send("agent-1", "Observed task", "requested"); }
      finally { await release(); }
    })();
    expect({ listeners: value.listeners.size, sent }).toEqual({ listeners: 1, sent: [] });
    established.resolve();
    await sending;
    expect({ listeners: value.listeners.size, sent, releases: value.state.released }).toEqual({ listeners: 0, sent: ["Observed task"], releases: 1 });
  });

  test("releases a failed subscription before any task is sent", async () => {
    const value = fixture();
    value.state.ready = Promise.reject(new Error("Subscription rejected"));
    await expect(value.gateway.observe("agent-1", "requested", new AbortController().signal)).rejects.toThrow("Subscription rejected");
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ id: "agent-1", active: false, archived: false });
    expect({ listeners: value.listeners.size, releases: value.state.released, canceled: value.state.canceled }).toEqual({ listeners: 0, releases: 1, canceled: [] });
  });

  test("aborts pending subscription establishment and releases its local abort listener", async () => {
    const value = fixture();
    value.state.ready = Promise.withResolvers<void>().promise;
    const controller = new AbortController();
    const observing = value.gateway.observe("agent-1", "requested", controller.signal);
    controller.abort();
    await expect(observing).rejects.toThrow("Paseo execution canceled");
    expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 0, releases: 1 });
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ active: false, archived: false });
  });

  test("times out during subscription establishment without retaining an observer", async () => {
    const value = fixture();
    value.state.ready = Promise.withResolvers<void>().promise;
    const result = await value.gateway.wait("agent-1", 10, () => {}, new AbortController().signal, "requested", () => {});
    expect(result).toEqual({ status: "failed", output: "", error: "Paseo execution timed out" });
    expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 0, releases: 1 });
    value.state.ready = Promise.resolve();
    const release = await value.gateway.observe("agent-1", "next-request", new AbortController().signal);
    await release();
    expect(value.state.released).toBe(2);
  });

  test("does not cancel a running native turn that this gateway only observed", async () => {
    const value = fixture();
    value.state.agent = { ...value.state.agent, status: "running", activeTurn: { turnId: "human-turn", startedAt: null } };
    value.client.waitForFinish = mock(() => Promise.withResolvers<WaitForFinishResult>().promise);
    const controller = new AbortController();
    const release = await value.gateway.observe("agent-1", "observed-message", controller.signal);
    const waiting = value.gateway.wait("agent-1", 1000, () => {}, controller.signal, "observed-message", () => {});
    controller.abort();
    expect(await waiting).toEqual({ status: "failed", output: "", error: "Paseo execution canceled" });
    await release();
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ active: true, archived: false });
    expect({ canceled: value.state.canceled, releases: value.state.released, listeners: value.listeners.size }).toEqual({ canceled: [], releases: 1, listeners: 0 });
  });

  test("cancels only its owned send and stops delivering activity after abort", async () => {
    const value = fixture();
    const controller = new AbortController();
    const release = await value.gateway.observe("agent-1", "owned-message", controller.signal);
    await value.gateway.send("agent-1", "Owned task", "owned-message");
    value.state.agent = { ...value.state.agent, status: "running", activeTurn: { turnId: "owned-turn", startedAt: null } };
    const started = Promise.withResolvers<void>();
    value.client.waitForFinish = mock(() => { started.resolve(); return Promise.withResolvers<WaitForFinishResult>().promise; });
    const events: AgUiEvent[] = [];
    const waiting = value.gateway.wait("agent-1", 1000, () => {}, controller.signal, "owned-message", (event) => events.push(event));
    await started.promise;
    controller.abort();
    expect(await waiting).toEqual({ status: "failed", output: "", error: "Paseo execution canceled" });
    stream(value, { type: "user_message", text: "Owned task", messageId: "owned-message" }, 0);
    stream(value, { type: "tool_call", callId: "after-abort", name: "write", status: "completed", error: null, detail: { type: "unknown", input: {}, output: "must not emit" } }, 1);
    await release();
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ active: false, archived: false });
    expect({ canceled: value.state.canceled, releases: value.state.released, listeners: value.listeners.size, events }).toEqual({ canceled: ["agent-1"], releases: 1, listeners: 0, events: [] });
  });

  test("does not interrupt a newer human turn after its earlier owned send", async () => {
    const value = fixture();
    await value.gateway.send("agent-1", "Owned task", "owned-message");
    value.state.items.push({ type: "user_message", text: "Human work", messageId: "human-message" });
    value.state.agent = { ...value.state.agent, status: "running", activeTurn: { turnId: "human-turn", startedAt: null }, lastUserMessageAt: "2026-01-01T00:01:00Z" };
    value.client.waitForFinish = mock(() => Promise.withResolvers<WaitForFinishResult>().promise);
    const controller = new AbortController();
    const waiting = value.gateway.wait("agent-1", 1000, () => {}, controller.signal, "owned-message");
    controller.abort();
    await expect(waiting).rejects.toThrow("native cancellation is unconfirmed");
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ active: true, lastUserMessageAt: "2026-01-01T00:01:00Z" });
    expect(value.state.canceled).toEqual([]);
  });

  test("closes a pre-send observation when the gateway is disposed", async () => {
    const value = fixture();
    const release = await value.gateway.observe("agent-1", "not-sent", new AbortController().signal);
    await value.gateway.close();
    await release();
    expect({ releases: value.state.released, listeners: value.listeners.size, canceled: value.state.canceled }).toEqual({ releases: 1, listeners: 0, canceled: [] });
    expect(value.state.agent.status).toBe("idle");
  });
});

describe("hydrated native image delivery", () => {
  test("attaches immutable context image bytes through SDK images without metadata or public URLs", async () => {
    const value = fixture();
    const sent: { id: string; text: string; options?: PaseoAgentSendOptions }[] = [];
    value.client.sendAgentMessage = mock(async (id, text, options) => { sent.push({ id, text, options }); return {}; });
    const context: TaskContextSnapshot = {
      version: 1, issueId: 42, projectId: 1, capturedAt: 1, digest: "a".repeat(64), text: "Approved context",
      warnings: [], development: [], assets: [
        { id: "00000000-0000-4000-8000-000000000001", filename: "context.png", mimeType: "image/png", data: "aW1hZ2U=", digest: "b".repeat(64) },
        { id: "00000000-0000-4000-8000-000000000002", filename: "context.webp", mimeType: "image/webp", data: "d2VicA==", digest: "c".repeat(64) },
      ],
    };
    await value.gateway.send("agent-1", "Task with approved context", "image-message", context);
    expect(sent).toEqual([{
      id: "agent-1", text: "Task with approved context", options: {
        messageId: "image-message", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }, { data: "d2VicA==", mimeType: "image/webp" }],
      },
    }]);
    await value.gateway.send("agent-1", "Task without images", "text-message");
    expect(sent[1]).toEqual({ id: "agent-1", text: "Task without images", options: { messageId: "text-message" } });
    expect(context.assets[0]).toEqual({ id: "00000000-0000-4000-8000-000000000001", filename: "context.png", mimeType: "image/png", data: "aW1hZ2U=", digest: "b".repeat(64) });
  });

  test("refuses a stale busy native session without replacing or canceling its turn", async () => {
    const value = fixture();
    value.state.agent = { ...value.state.agent, status: "running", activeTurn: { turnId: "someone-else", startedAt: null } };
    await expect(value.gateway.send("agent-1", "Stale task", "stale-message")).rejects.toThrow("no longer idle");
    const controller = new AbortController();
    controller.abort();
    expect(await value.gateway.wait("agent-1", 1000, () => {}, controller.signal, "stale-message")).toMatchObject({ status: "failed", error: "Paseo execution canceled" });
    expect(await value.gateway.inspect("agent-1", { includeHistory: false })).toMatchObject({ active: true, archived: false });
    expect(value.state.canceled).toEqual([]);
  });
});

test("preserves whole names for engine redaction and keeps oversized native identities stable", async () => {
  const value = fixture();
  value.state.items = [
    { type: "user_message", text: "Task", messageId: "requested" },
    { type: "assistant_message", text: "Checking.", messageId: "y".repeat(201) },
    { type: "tool_call", callId: "x".repeat(201), name: "r".repeat(220), status: "completed", error: null, detail: { type: "unknown", input: {}, output: "payload" } },
    { type: "assistant_message", text: "BOUNDED" },
  ];
  const events: AgUiEvent[] = [];
  expect(await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "BOUNDED" });
  const id = "native-84a0678c90937f5dcf9994d5866668da6b995109c8ad845410559b48a4ecafed";
  expect(events).toEqual([
    { type: "TOOL_CALL_START", toolCallId: id, toolCallName: "r".repeat(220), parentMessageId: "native-9646bc459c4ca614b3d9115269d5ef004ece0e016830ef15e60b46b1fb6f7089" },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: id },
    { type: "TOOL_CALL_RESULT", toolCallId: id, messageId: id, content: "payload", role: "tool" },
  ]);
});

test("recovers a native replacement epoch without duplicating previously delivered lifecycle events", async () => {
  const value = fixture();
  const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
  const oldTool: AgentTimelineItem = { type: "tool_call", callId: "old-tool", name: "read", status: "completed", error: null, detail: { type: "unknown", input: {}, output: "old payload" } };
  const newTool: AgentTimelineItem = { type: "tool_call", callId: "new-tool", name: "write", status: "completed", error: null, detail: { type: "write", filePath: "file", content: "new bytes" } };
  value.state.items = [boundary, oldTool];
  let round = 0;
  value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
    if (++round === 1) return { ...value.state.result, status: "timeout", final: { ...value.state.agent, status: "running" } };
    value.state.epoch = "replacement";
    value.emit({ type: "agent.timeline.replacement", payload: { agentId: "agent-1", epoch: "replacement" } });
    value.state.items = [boundary, oldTool, newTool, { type: "assistant_message", text: "REPLACED" }];
    return { ...value.state.result, final: value.state.agent };
  });
  const events: AgUiEvent[] = [];
  expect(await value.gateway.wait("agent-1", 2000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "REPLACED", evidence: { toolCallCount: 2, historyComplete: true } });
  expect(events).toEqual([
    { type: "TOOL_CALL_START", toolCallId: "old-tool", toolCallName: "read" },
    { type: "TOOL_CALL_ARGS", toolCallId: "old-tool", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "old-tool" },
    { type: "TOOL_CALL_RESULT", toolCallId: "old-tool", messageId: "old-tool", content: "old payload", role: "tool" },
    { type: "TOOL_CALL_START", toolCallId: "new-tool", toolCallName: "write" },
    { type: "TOOL_CALL_ARGS", toolCallId: "new-tool", delta: '{"filePath":"file","content":"new bytes"}' },
    { type: "TOOL_CALL_END", toolCallId: "new-tool" },
  ]);
  expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 0, releases: 1 });
});

test("uses the last verified cursor when live sequence numbers reveal a missing range", async () => {
  const value = fixture();
  const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
  const running: Extract<AgentTimelineItem, { type: "tool_call" }> = { type: "tool_call", callId: "gap-call", name: "read", status: "running", error: null, detail: { type: "read", filePath: "file" } };
  const completed: AgentTimelineItem = { ...running, status: "completed", detail: { type: "read", filePath: "file", content: "missing range" } };
  value.state.items = [boundary, running];
  let round = 0;
  const after: FetchAgentTimelineOptions[] = [];
  const fetch = value.client.fetchAgentTimeline.bind(value.client);
  value.client.fetchAgentTimeline = mock(async (id, options) => {
    if (options?.direction === "after") after.push(options);
    return fetch(id, options);
  });
  value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
    if (++round === 1) return { ...value.state.result, status: "timeout", final: { ...value.state.agent, status: "running" } };
    stream(value, completed, 4);
    value.state.items = [boundary, running, completed, { type: "assistant_message", text: "GAP RECOVERED" }];
    return { ...value.state.result, final: value.state.agent };
  });
  const events: AgUiEvent[] = [];
  expect(await value.gateway.wait("agent-1", 2000, () => {}, new AbortController().signal, "requested", (event) => events.push(event))).toMatchObject({ output: "GAP RECOVERED" });
  expect(after).toEqual([{ direction: "after", cursor: { epoch: "one", seq: 1 }, projection: "projected", limit: 100 }]);
  expect(events).toEqual([
    { type: "TOOL_CALL_START", toolCallId: "gap-call", toolCallName: "read" },
    { type: "TOOL_CALL_ARGS", toolCallId: "gap-call", delta: '{"filePath":"file"}' },
    { type: "TOOL_CALL_END", toolCallId: "gap-call" },
    { type: "TOOL_CALL_RESULT", toolCallId: "gap-call", messageId: "gap-call", content: "missing range", role: "tool" },
  ]);
});

test("does not reopen a superseded turn when an older history request resolves late", async () => {
  const value = fixture();
  const boundary: AgentTimelineItem = { type: "user_message", text: "Task", messageId: "requested" };
  value.state.items = [
    boundary,
    { type: "tool_call", callId: "owned-call", name: "read", status: "completed", error: null, detail: { type: "unknown", input: {}, output: "owned payload" } },
    { type: "assistant_message", text: "OWNED ANSWER" },
  ];
  const fetching = Promise.withResolvers<void>();
  const history = Promise.withResolvers<void>();
  const fetch = value.client.fetchAgentTimeline.bind(value.client);
  let reads = 0;
  value.client.fetchAgentTimeline = mock(async (id, options) => {
    const page = await fetch(id, options);
    if (++reads === 1) {
      fetching.resolve();
      await history.promise;
    }
    return page;
  });
  let round = 0;
  value.client.waitForFinish = mock(async (): Promise<WaitForFinishResult> => {
    if (++round === 1) {
      stream(value, boundary, 0);
      return { ...value.state.result, status: "timeout", final: { ...value.state.agent, status: "running" } };
    }
    value.emit({
      type: "agent_stream",
      payload: {
        agentId: "agent-1", timestamp: "2026-01-01T00:00:01Z", epoch: "one", seq: 3,
        event: { type: "timeline", provider: "alpha", item: { type: "tool_call", callId: "human-call", name: "read", status: "completed", error: null, detail: { type: "unknown", input: {}, output: "private human payload" } } },
      },
    });
    return { ...value.state.result, final: value.state.agent };
  });
  const events: AgUiEvent[] = [];
  const waiting = value.gateway.wait("agent-1", 2000, () => {}, new AbortController().signal, "requested", (event) => events.push(event));
  await fetching.promise;
  stream(value, { type: "user_message", text: "Human task", messageId: "human-message" }, 1, "human-turn");
  history.resolve();
  expect(await waiting).toMatchObject({ output: "OWNED ANSWER" });
  expect(events).toEqual([
    { type: "TOOL_CALL_START", toolCallId: "owned-call", toolCallName: "read" },
    { type: "TOOL_CALL_ARGS", toolCallId: "owned-call", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "owned-call" },
    { type: "TOOL_CALL_RESULT", toolCallId: "owned-call", messageId: "owned-call", content: "owned payload", role: "tool" },
  ]);
});

test("a mismatched wait does not release another turn's established observer", async () => {
  const value = fixture();
  const release = await value.gateway.observe("agent-1", "owned-message", new AbortController().signal);
  expect(await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "unrelated-message", () => {})).toEqual({
    status: "failed", output: "", error: "Paseo observer belongs to another turn",
  });
  expect({ listeners: value.listeners.size, releases: value.state.released }).toEqual({ listeners: 1, releases: 0 });
  value.state.items = [
    { type: "user_message", text: "Task", messageId: "owned-message" },
    { type: "tool_call", callId: "owned-call", name: "read", status: "completed", error: null, detail: { type: "read", filePath: "file", content: "owned payload" } },
    { type: "assistant_message", text: "OWNER" },
  ];
  const events: AgUiEvent[] = [];
  expect(await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "owned-message", (event) => events.push(event))).toMatchObject({ output: "OWNER" });
  await release();
  expect(events).toEqual([
    { type: "TOOL_CALL_START", toolCallId: "owned-call", toolCallName: "read" },
    { type: "TOOL_CALL_ARGS", toolCallId: "owned-call", delta: '{"filePath":"file"}' },
    { type: "TOOL_CALL_END", toolCallId: "owned-call" },
    { type: "TOOL_CALL_RESULT", toolCallId: "owned-call", messageId: "owned-call", content: "owned payload", role: "tool" },
  ]);
  expect({ listeners: value.listeners.size, releases: value.state.released, canceled: value.state.canceled }).toEqual({ listeners: 0, releases: 1, canceled: [] });
});

describe("native prompt admission", () => {
  test.each(["provider", "model", "mode", "thinking", "features", "repository", "workspace", "history", "active", "archived"])("rejects %s changes without acquiring cancellation ownership", async (change) => {
    const value = fixture();
    const expected = (await value.gateway.inspect("agent-1", { includeHistory: false }))!;
    let admitted = 0;
    if (change === "provider") value.state.agent.provider = "beta";
    if (change === "model") value.state.agent.model = "changed";
    if (change === "mode") value.state.agent.currentModeId = "plan";
    if (change === "thinking") value.state.agent.thinkingOptionId = "deep";
    if (change === "features") value.state.agent.features = [{ id: "sandbox", type: "toggle", label: "Sandbox", value: true }];
    if (change === "repository") value.state.agent.cwd = "/changed/repository";
    if (change === "workspace") value.state.agent.workspaceId = "changed-workspace";
    if (change === "history") value.state.agent.lastUserMessageAt = "2026-10-25T12:00:00Z";
    if (change === "active") value.state.agent.status = "running";
    if (change === "archived") value.state.agent.archivedAt = "2026-10-25T12:00:00Z";
    await expect(value.gateway.send("agent-1", "Continue the verified task", "continuation-message", undefined, { expected, signal: new AbortController().signal, onDispatch() { admitted++; } })).rejects.toThrow();
    expect(value.state.items[0]).toEqual({ type: "user_message", text: "Implement the task" });
    expect(admitted).toBe(0);
    expect(value.state.canceled).toEqual([]);
  });

  test("rechecks cancellation after the asynchronous native refresh before dispatch", async () => {
    const value = fixture();
    const expected = (await value.gateway.inspect("agent-1", { includeHistory: false }))!;
    const stop = new AbortController();
    let admitted = 0;
    value.client.fetchAgent = mock(async () => { stop.abort(); return { agent: value.state.agent, project: null }; });
    await expect(value.gateway.send("agent-1", "Continue the verified task", "continuation-message", undefined, { expected, signal: stop.signal, onDispatch() { admitted++; } })).rejects.toThrow();
    expect(admitted).toBe(0);
    expect(value.state.items[0]).toEqual({ type: "user_message", text: "Implement the task" });
    expect(value.state.canceled).toEqual([]);
  });

  test("acquires ownership only after the verified native refresh and immediately before dispatch", async () => {
    const value = fixture();
    const expected = (await value.gateway.inspect("agent-1", { includeHistory: false }))!;
    let admitted = false;
    value.client.sendAgentMessage = mock(async (_id, text, options) => {
      expect(admitted).toBe(true);
      value.state.items = [{ type: "user_message", text, clientMessageId: options?.messageId }];
      return {};
    });
    await value.gateway.send("agent-1", "Continue the verified task", "continuation-message", undefined, { expected, signal: new AbortController().signal, onDispatch() { admitted = true; } });
    expect(value.state.items).toEqual([{ type: "user_message", text: "Continue the verified task", clientMessageId: "continuation-message" }]);
  });
});

test("a later completed human turn cannot become reusable provenance for an earlier execution", async () => {
  const value = fixture();
  value.state.items = [
    { type: "user_message", text: "Owned task", messageId: "owned-message" },
    { type: "assistant_message", text: "Original answer" },
    { type: "user_message", text: "Different human task", messageId: "human-message" },
    { type: "assistant_message", text: "Human answer" },
  ];
  value.state.agent.lastUserMessageAt = "2026-10-25T12:00:00Z";
  const outcome = await value.gateway.wait("agent-1", 1000, () => {}, new AbortController().signal, "owned-message");
  expect(outcome).toMatchObject({ status: "failed", output: "Original answer", evidence: { historyComplete: false }, error: "The native session advanced beyond this execution; the later turn was not interrupted" });
  expect(value.state.canceled).toEqual([]);
});
