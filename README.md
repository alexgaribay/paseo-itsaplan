# It's a Plan for Paseo

A native Paseo plugin: It's a Plan owns issues, assignments, external-agent identities and execution history; Paseo owns providers, sessions, permissions, workspaces and worktrees. The managed plugin backend coordinates them. No runner subprocess, integration daemon, container, Hermes dependency or mandatory MCP connection.

## Compatibility and verified sources

- **Paseo 0.13.x**, manifest `requirements.paseo: ">=0.13.0 <0.14.0"`; `@getpaseo/plugin`, `@getpaseo/client` and `@getpaseo/protocol` verified at **0.13.0**.
- Paseo source reviewed at [`72e3316f4f5dfe775c77dbf998968c92e2de9019`](https://github.com/getpaseo/paseo/tree/72e3316f4f5dfe775c77dbf998968c92e2de9019). References: [plugin SDK](https://paseo.sh/docs/plugins/reference), [installation](https://paseo.sh/docs/plugins), [SDK](https://paseo.sh/docs/sdk), [SDK source reference](https://github.com/getpaseo/paseo/blob/72e3316f4f5dfe775c77dbf998968c92e2de9019/public-docs/sdk/reference.md).
- It's a Plan **1.8.0**, runner **0.7.0**, reviewed at [`02235dd57a6cecffa62e0d6c054cb7b7df72e153`](https://github.com/croffasia/itsaplan/tree/02235dd57a6cecffa62e0d6c054cb7b7df72e153), including `client.ts`, `cli.ts`, `tasks.ts`, `run.ts`, `chat.ts`, `config.ts`, `listen.ts`, `agui.ts`, runner licensing and server route implementations.
- No promise of compatibility with unreviewed future server protocols. The upper Paseo bound is deliberate: unattended execution currently needs a small, isolated SDK transport adapter described below.
- Linked-repository discovery additionally verified against It's a Plan [`599af2bbb5364e55f551dbea7c1736b7c3749eae`](https://github.com/croffasia/itsaplan/tree/599af2bbb5364e55f551dbea7c1736b7c3749eae): project-scoped Git connections, repository URLs, and permission guards. No application source was copied.
- Task-intent, queue and human-rerun contracts additionally verified against It's a Plan [`79f7802af892df8a1eaba190a02d2fe182fe6785`](https://github.com/croffasia/itsaplan/tree/79f7802af892df8a1eaba190a02d2fe182fe6785). The Apache runner adaptation base remains unchanged; no AGPL application source was copied.
- Optional context, stable field selections, Git references, scheduling and forge limitations rechecked against [`ad87c568d1a872f830a526bd9ace774eafd57217`](https://github.com/croffasia/itsaplan/tree/ad87c568d1a872f830a526bd9ace774eafd57217). These are original plugin implementations against observed HTTP contracts, not copied AGPL application code.

## Install

Requires an existing Paseo daemon, a provider configured **in Paseo**, and an accessible It's a Plan server. Node 20.3+ is the backend baseline; development tests use Bun. The generated scaffold came from `paseo plugin init`; this project uses the current `index.server.ts` / `index.client.tsx` architecture.

```sh
npm ci
npm run typecheck
npm test
paseo plugin install .
```

Install from this directory or a Git checkout. This is a private source-distributed package, not an npm registry release. The manifest installs production dependencies with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`; preserve `package-lock.json` in the checkout. Enable plugins in Paseo if they are disabled. Plugins are trusted daemon code: enable only sources you trust.

Open **Settings → host → Plugins → It's a Plan** to configure the integration. The sidebar opens execution activity, with **Open It's a Plan** for issue management in the web app. The command center offers **Configure It's a Plan** and **View It's a Plan executions**. After source changes, use `paseo plugin reload itsaplan`.

The main screen shows connection/delegation status and active work. **Needs attention**, **History**, **Delegation requests** and **Runtime controls** open focused pages; individual execution pages contain session links, evidence and actions. There is no native issue browser or issue-search command.

Settings starts with **Connection**, **Projects**, **Execution** and **Advanced** categories. **Setup checks** is separate; advanced policies, optional credentials and MCP are only shown when opened. Native rows, section help and adaptive dialogs keep descriptions out of the settings list.

Configuration remains a draft until **Save changes**. Category navigation preserves that draft; the **Executions** shortcut stays disabled until changes are saved or discarded. **Apply** commits an editor's staged changes to the shared draft, not the server. Credential editors are separate: **Save credential** applies immediately, and stored plaintext is never returned. Safe configuration changes apply to future claims; connection or execution-credential changes drain already-claimed work before reconnecting. Saving is not a stop-work action.

### Connection

1. Create an **external** agent in It's a Plan. Give its bot account access to the relevant projects and permissions to read issues/projects. Grant comment/issue-edit permissions only if using milestone transitions. One team-level external-agent key can cover every authorized project; no per-project agent is required.
2. Enter **Connection → API server URL** for the backend used by Paseo, and **Web app URL** for browser issue links. The API must be reachable from the Paseo daemon; the website must be reachable from your browser/device. HTTPS is required except for loopback HTTP. URLs must not contain credentials, query strings or fragments.
3. Open **External-agent execution API key → Add** (or **Replace**) and use **Save credential**. Do **not** use a personal API key or MCP token: those may authenticate as a regular account but cannot act as the external execution identity. The execution key uses **`x-api-key`**; MCP uses a separate credential.
4. **Paseo host connection** defaults to **Automatic (this host)**. The plugin reads the running daemon's endpoint and identity from its private runtime metadata and authenticates with its private local credential. No WebSocket URL or Paseo password is needed. Open **Configure** to inspect the detected host or **Test connection** without claiming work. **Manual override** is only for another transport to the same daemon, such as a WSS proxy; it uses the separately stored Paseo password, never the local credential. Both modes verify the owning daemon's ID on connection and reconnect. Legacy custom URLs remain manual overrides; the old loopback defaults become automatic unless a mode was explicitly saved.
5. Save the settings, then open **Setup checks → Check readiness**. This non-claiming checklist verifies the external-agent identity and polling mode, owning host, saved project/provider/repository policies, and queue visibility. Resolve actions open the relevant native editor or the bot's It's a Plan settings. Separate connection tests remain available for diagnosis. These are snapshots, not reservations or proof of a future execution; unavailable queue metadata is never shown as an empty queue. Authentication failures remain distinct from connectivity failures.

| Setting | Purpose | Example |
| --- | --- | --- |
| API server URL | Requests made by Paseo: projects, issues, claims, heartbeats and results | `https://api.plan.example.com` |
| Web app URL | Issue links opened in the Paseo client's browser | `https://plan.example.com` |

The URLs can be identical when one origin serves both the API and website. A blank web app URL falls back to the API URL; set it explicitly when the website is hosted separately.

If **Test connection** says that authentication succeeded but the key belongs to a regular account, the API host is reachable and the account key is valid—the credential type is wrong for execution. Create or select an external agent in It's a Plan, grant it access to the intended projects, and save its execution key in the plugin. This is not a proxy/network 403 and does not require revoking your personal/MCP token. Connection-test feedback is displayed in the Connection section beside the test controls.

The plugin does not use the runner's invocation URL/listener mode. It polls the authoritative server queue from inside Paseo's managed plugin backend whenever automatic execution is enabled.

### Projects and execution

**Project repositories** lists authorized **It's a Plan projects**, not Paseo projects. Linked Git repositories are matched automatically against registered Git projects on the **owning Paseo host**, including projects without active workspaces. The header refresh reloads discovery. A unique match displays its local checkout; multiple independent clones require an explicit choice in **Matching checkout**. Names and issue descriptions never select paths.

Leave **Repository override** blank to use the unique match, or set an **absolute canonical Git checkout root on the daemon host** / choose an existing Paseo workspace. Explicit overrides take precedence and work without Git-metadata discovery permissions. Configure provider/worktree preferences, **Apply**, then **Save changes**. Programmatic manual starts and attachments may use a unique automatic match without a saved project configuration; unattended work still requires explicit per-project opt-in. **Bulk configure** requires explicit project selection and applies provider/model/mode defaults only to that draft; it never enables automatic execution or chooses a repository.

Discovery reads `GET /projects/:qualifiedRef/settings/git/connections`, not the settings route that exposes webhook secrets or creates missing settings. **Current It's a Plan requires `repositories: edit` to read this metadata.** If the agent's role lacks that permission, project discovery remains available, but repository discovery is marked unavailable. Prefer an explicit override if granting repository-edit access is inappropriate. A project must have a connected repository linked in It's a Plan; a team-level Git account alone is insufficient.

Matching compares full forge host, repository path and ports from structured metadata with local Git remotes. Standard HTTPS/SSH/scp forms normalize together; path case is preserved. Plain HTTP matches only HTTP. Custom ports do not imply equivalence across transports. Worktrees/symlinks sharing a Git common directory count once; separate clones remain ambiguous. Encoded/non-ASCII paths, IPv6 remote authorities and unsupported remote schemes require an explicit override. No directory scan, clone, remote fetch or project-name guess occurs. An unreadable registered checkout fails discovery closed rather than proving a match from an incomplete catalog.

Configure:

- Global provider/model/mode and project overrides, using Paseo's discovered catalog. No runtime list of provider names is hardcoded.
- Saved issue overrides by numeric issue ID. Precedence: explicit manual selection → saved issue override → opt-in custom-field option mapping → project → global. Neither an inherited model nor an inherited mode crosses a different provider. With no compatible model override, the plugin omits the model and lets Paseo resolve its provider default; it never selects a catalog entry itself. Paseo may still choose a catalog fallback when its provider has no advertised default. Execution plans show each selection's source and unresolved defaults; session details show the actual model/mode after creation. Invalid or unavailable explicit selections fail without switching providers.
- Both **global automatic execution** and **project automatic execution** must be enabled for unattended work. Disabled or unresolved projects fail explicitly after claim; they never run in a default repository. Claims are **global and unfiltered**: disabling a project does not remove its work from the external agent's queue. Readiness and queue previews surface this limitation. Discovery does not route work between different Paseo daemons.
- Maximum concurrent automatic executions: default **2**, range **1–32**. In-flight claims reserve capacity across run and chat feeds. This is not a daemon-wide limit on manual Paseo use.
- Timing controls show seconds for polling/lease safety and minutes for execution timeout; persisted settings and protocol values remain milliseconds. Defaults: poll every **3 seconds**, timeout **30 minutes**, heartbeat every **60 seconds**, local lease safety **120 seconds**. Keep the server lease safely longer than the local deadline (upstream default: **300 seconds**). Polling and lease controls are under **Advanced → Polling and leases**.
- Permission mode: discovered Paseo mode IDs, inherited from normal Paseo configuration when blank. Permission requests remain visible in Paseo; the plugin never approves them. Select an appropriate mode deliberately for unattended operation.

Representative non-secret settings excerpt (other fields retain defaults):

```json
{
  "serverUrl": "https://plan.example.com",
  "webUrl": "https://plan.example.com",
  "paseoConnectionMode": "auto",
  "automatic": true,
  "defaultProvider": "omp",
  "projects": {
    "101": {
      "repository": "",
      "provider": "omp",
      "automatic": true,
      "worktree": true,
      "baseBranch": "main",
      "statusPolicy": { "ready-for-review": 901 }
    },
    "102": {
      "repository": "/srv/projects/lumen",
      "provider": "codex",
      "automatic": true,
      "worktree": false
    }
  }
}
```

Provider names above are examples, not guaranteed installed providers. Keep credentials out of settings, issue text, repository files and prompts.

### Optional task context and field routing

In a project's repository editor, enable **Optional task context** and choose only the needed sources: checklists, direct relations/subtasks, explicitly linked public Docs, attachments and development metadata. Source switches appear only while enabled. This is off for existing installations. Private or archived Docs are omitted without fetching their bodies; the plugin does not traverse arbitrary links or related tasks' private descriptions. Scanned PDFs/images are not OCRed.

The authenticated attachment API supplies supported text/PDF extraction and PNG/JPEG/GIF/WebP bytes. Captures are bounded to 48,000 text characters, eight Docs, 30 relations, six attachments, 2 MB per asset, 6 MB aggregate assets, 8 MB response data and a 30-second operation deadline. Unsupported, denied, unavailable, redacted or truncated content produces explicit warnings. Images use native session image inputs when supported; an unsupported provider receives an explicit limitation, not fabricated image contents.

Captured text and image manifests remain private journal data. Verified image bytes live in the private `context-assets/` sidecar, addressed by SHA-256. Recovery uses those captured bytes, not a silent refetch; missing, changed, mismatched or symlinked assets fail closed. Context is still untrusted task data, never permission to execute shell commands or select repositories. Opt in deliberately: images and source documents can contain sensitive material that automatic text redaction cannot recognize.

**Retention:** Captured images are deduplicated by content hash and retained for historical recovery, including terminal and uncertain executions. There is **no automatic expiry, garbage collection or global storage quota**; the 6 MB aggregate asset limit applies per snapshot, not to the entire data directory. Interrupted captures can leave unreferenced blobs. Disabling optional context stops future collection but does not delete existing captures. Monitor storage and backups before enabling image attachments for large unattended queues. Preserve assets alongside their journal: deleting blobs breaks historical replay, and deleting the journal removes delivery/idempotency fences rather than safely freeing cache space.

Choose **Configure** under **Field-based agent selection** to map a stable **project / issue-type / select-field / option ID** to a discovered provider and model. Catalogs are read only when configuring fields or validating existing bindings. Only explicitly saved option mappings apply; arbitrary field text cannot choose a path, permission mode or command. Conflicting selections, stale fields/options and unavailable providers/models fail before dispatch. The execution plan records when its provider/model came from a field.

### Issues, sessions and status

- Browse, search, edit and delegate issues in the It's a Plan web app. The plugin's **Open It's a Plan** shortcut uses the configured web app URL; execution pages retain direct issue links.
- Typed issue lookup, manual-start and attachment RPCs remain available for programmatic integrations, without a duplicate issue-management UI. Attachment does not send a prompt. An attached session must belong to the configured checkout or a previously validated worktree for that project.
- Open **History** or **Needs attention**, then select an execution. **Open agent** uses Paseo navigation; conversation history remains in Paseo. Provider/model/mode, approvals, cancellation, output/error, plans and technical details are available inside the selected execution rather than on the landing screen. Result delivery, acceptance, and observed milestones are separate; an upstream `success` is not proof of implementation, tests, a PR, or issue completion.
- **Compare and review** compares the selected attempt with current upstream outcome, native activity/archive state, result delivery and acceptance. **Mark reviewed** requires a matching terminal attempt, the authenticated external polling agent's numeric ID, and a positively idle/archived native session. Missing agent metadata or mismatched identity/kind blocks acknowledgment; stale observations must be refreshed. It records a timestamp only: it never changes execution phase, acknowledges a lost result receipt, clears cancellation fences, or completes the issue. Reviewed discrepancies retain their evidence and display a review acknowledgment.
- A completed coding turn is **not** issue completion. Milestones are distinct: `turn-completed`, `implementation-completed`, `tests-passed`, `pull-request-created`, `ready-for-review`, `issue-completed`.
- No issue transition runs automatically. Configure destination column IDs, then explicitly submit a milestone with observed evidence from the session UI. A project policy overrides the global policy for that milestone. Blank project fields inherit global policies; blank global fields disable transitions. Use columns belonging to the issue's project.
- Milestone submission posts an evidence comment, then updates `columnId`. These are separate upstream operations, not a transaction: if updating the column fails, the comment can already exist. A retry can create another comment. A model assertion is not independent proof of tests, a PR, or review.

### Smoke checks and reruns

Use **Settings → Setup checks → Set up test**, paste an existing issue's web URL or numeric ID, then choose **Review test** to inspect the saved host/repository/worktree/provider/model/mode plan. URLs must match the configured web app origin and installation path; the plugin never fetches an arbitrary pasted URL. No project selector, issue search, previous run or native session is required, and no issue is created. Existing terminal executions also offer **Review smoke check** and **Review rerun** from their detail page. Delivery creates work in It's a Plan's authoritative queue, never an untracked local retry.

- Without a separate human API credential, **Prepare browser handoff** durably fences the request before exposing its exact text. **Copy comment** is a separate action using that already-loaded text; if clipboard access is denied, the full-width selectable text remains available. Post it **once as a human**, then **Refresh delivery**. Preparing, copying and opening the browser do not post or queue it. Bot-authored comments do not trigger agent runs.
- **Advanced → Human rerun requests** can store a separate, scoped **human account API key** for direct comment submission. The delivery channel and human identity are pinned at preview; a changed or unavailable identity requires a new reviewed preview, never an automatic channel switch. Execution and MCP credentials are rejected for this purpose and are never injected into coding sessions.
- Closing an untouched preview dismisses it, even if its project configuration later becomes unavailable. Once handed off or attempted, ambiguous delivery stays fenced across reloads. Open **Delegation requests**, select the request, then use **Recover handoff**. It first reconciles, then shows the exact stored browser comment and original nonce; it never resets, regenerates or reposts it. Recovery has no submit action. Check issue history before any manual posting; an unknown receipt is not proof of non-delivery.
- The smoke request asks for exactly `PASEO_IAP_SMOKE_OK`, no tools, file edits, commits, pushes, or issue-status changes. **No-tools is instruction-only**, not a universal provider sandbox. Exact final output and observed tool calls are assessed separately; incomplete history yields unknown tool evidence, not a pass.
- Live tracking separates request delivery, upstream run/attempt, native session/result and acceptance, refreshing every five seconds while the dialog is open. Unknown, partial and unavailable observations remain explicit.
- First-run smoke uses a strict issue-origin marker bound to the saved agent, actor, issue, project and durable handoff. A handcrafted or untouched-preview marker is not accepted for execution. Immutable existing run-origin comments remain supported. New delivery requires complete queue visibility, no active issue work, positive historical native-idle evidence, saved automatic opt-in and resumed claiming.

Run execution resolves the original structured task from the authoritative queue metadata rather than stripping the runner's framed prompt with heuristics. The full upstream system instructions remain intact, with a narrow Paseo delivery contract: the plugin reports events/results; the coding agent returns its final answer. Queue metadata read access is required for safe task-intent resolution.

**Tool use is the default for normal delegated work.** Native system instructions and each new non-smoke task prompt explicitly permit available tools for inspection, implementation and verification; tickets do not need to request tools. Explicit task restrictions, including no-tools requests, take precedence. This guidance grants no new tools or permissions, bypasses no Paseo approval, and does not require gratuitous calls for simple questions or exact-output tasks. Already-running turns are not rewritten.

### Explicit continuation

Fresh native sessions remain the default for issue executions, including repeat assignments on the same issue. **Advanced → Execution behavior → Allow reviewed continuation** permits a separate **Review continuation** action on a completed run; it does not enable automatic same-issue reuse.

Review the original task, operator instructions, requirements and attached materials, then explicitly attest that this is the same compatible unrestricted task. A 30-minute grant binds the source run/attempt, authenticated actor, native session and last user turn, original task/restrictions, requirements/context, repository and execution configuration. Activity privacy, timeout/lease policy, recorded limits and worktree association are part of that scope; changing them invalidates an old approval. The existing human-mention/browser handoff delivers that single durable request. New free-form requirements require a fresh session.

Known smoke, exact-output, no-tools, no-posting and bounded-scope tasks are blocked. So are legacy/unknown provenance, failed/canceled/uncertain sources, changed requirements or selections, busy/archived/missing sessions, pending approvals, expired grants and transferred execution attempts. Absence of a recognized phrase is never proof that reuse is safe: human attestation and immutable provenance are both required. Final admission rechecks the lease and native state; configuration or credential changes during native refresh prevent the prompt, without acquiring cancellation ownership over the source.

### Ticket reporting

Automatic issue execution and programmatic manual issue starts share a per-task reporting convention. It applies to implementation work, not questions, smoke tests or tasks requesting a different/exact response. Original requirements remain unchanged and outside the system prompt.

- Record significant findings and consequential decisions, their implications and recommended action—not routine progress. Record out-of-scope discoveries without silently expanding the task.
- Separate requirements, findings and approved decisions. Explain discrepancies and obtain human clarification or approval before materially changing scope or behavior.
- Report blockers with cause, attempted work, needed input and alternatives. Do not repeat an unchanged blocker.
- Use existing, authorized issue-comment tools when available and permitted, with normal Paseo permissions. Do not obtain credentials or create a reporting connection. If posting is unavailable, forbidden or unconfirmed, retain the findings in the conversation/final report and disclose that delivery state; do not blindly repost.
- Finish with **Outcome**, **Changes**, **Validation**, **Decisions and Discoveries**, **Remaining Work**, and **References**. Identify untested paths and unverified assumptions; include only real checks, approvals and references. Outcome labels are report text, not new execution API statuses.

The execution API stores the final answer as a run result, **not an automatic completion comment**. From a selected execution, **Review ticket report** separately verifies the original task's permission to post, previews the exact structured comment and requires explicit human attestation. Optional user-reviewed notes are not verified model/test evidence. The plugin never mines transcripts for approval, automatically posts a report, changes issue status or edits original requirements.

Report delivery uses the bot's existing REST API permissions, not agent MCP or the separate human rerun credential. A durable fence precedes every approved write. One per-run marker and exact actor/body checks reconcile lost acknowledgments; unknown delivery cannot be blindly retried. Later approved edits update only the exact known bot-owned comment, after a complete authoritative feed proves it was not changed. Partial, missing, inaccessible or ambiguous feeds preserve uncertainty. Keep source credentials and private context out of notes.

This is an instruction-level convention, not a provider-independent enforcement mechanism. New task prompts, including new turns on reused sessions, receive the current policy; already-running turns are not replayed. Chat routing/conversation state and attached sessions that receive no prompt are unchanged.

### Worktrees and Gitea

Worktrees are enabled by default per mapped project. New work uses native `PaseoApi.workspaces.create` with a worktree branch-off source, an explicit branch name and the configured base branch or native repository default. Canonical identifiers lead new names, e.g. `TW-42-itsaplan-<stable-hash>`, so It's a Plan's forge matcher recognizes them. Explicit workspace creation avoids the SDK's slug case/slash normalization. Stable agent/workspace recovery prevents duplicate creation; existing `itsaplan-<hash>` branches and worktrees are preserved rather than renamed.

Workspace/session/journal associations retain the issue and checkout. Follow-up chat uses its original session/worktree. Worktrees, commits and conversations are **never automatically deleted or archived** by this plugin. Inspect dirty state and use Paseo's existing workspace cleanup flow. Keep worktrees until review/follow-up is finished.

Gitea remotes and Git credentials belong to the mapped repository and Paseo/provider environment. There is no separate Gitea client, automatic push, protected-branch push or PR merge in this plugin. Normal agent tool access remains governed by Paseo permissions; the plugin is not a Git policy enforcement sandbox.

When a task actually calls for a PR, native task guidance recommends a **nonclosing** `Refs TW-42` reference. It never requests a PR merely for linking, uses `Fixes`/`Closes` by default, pushes, merges or infers completion from a turn. **Execution details → Task context and development** reads current issue-linked development records and distinguishes unavailable access from an empty result. Captured context is historical; links and forge state do not prove tests passed.

Upstream currently labels run session links as `codex://threads/...`, so this plugin intentionally omits run `sessionId` instead of mislabeling a Paseo agent. Native **Open agent** navigation remains provider-neutral. Gitea/Forgejo can parse GitHub-shaped check-run events, but managed hooks do not request those events; outbound PR operations are restricted upstream to GitHub/GitLab. Those gaps are tracked in [PIAP-1](https://plan.alexgaribay.com/issue/2). No upstream repository, forge hook or CI state is modified by this plugin.

### Scheduled tasks and activity privacy

It's a Plan's existing cron/state-change scheduling enqueues ordinary external-agent runs. The plugin consumes them through the same queue, capacity limits, leases and project routing; issue-less runs receive trigger/run-based native titles. Configure schedules in It's a Plan. There is no plugin scheduler or second task queue; the internal-only `run_ai_agent` action is not used for external delegation.

**Advanced → Execution behavior → Tool activity** controls normalized SDK tool events: **Off** (default), **Tool names only** (arguments withheld, results replaced with a withholding notice), or **Arguments and results**. Run traces still require upstream `traceEvents`; chat uses its existing stream. Full mode can expose code or sensitive tool data: known captured plugin credentials are redacted, but this is not general data-loss prevention. Per-execution event identities and text cursors suppress recovery replay; upstream chat's missing offset/attempt fencing still prevents an exactly-once guarantee.


### Agent chat

The current claim payload has a thread/session ID but **no project ID**. Map the exact thread ID to a mapped project in **Advanced → Chat routing**, apply the editor, and save changes before dispatch. Unmapped threads fail safely; the plugin does not guess from conversation text. The durable binding then fixes that thread's project and native agent.

Initial messages create a session; follow-ups reuse it and verify the upstream session ID. Existing native sessions are authoritative for conversation history. Unknown/archived sessions are errors, not silently replaced conversations. Restore the original journal/thread binding from backup or start a new It's a Plan thread if that binding was lost. Unchanged provider-default policies retain the existing conversation's actual model/mode. An incompatible explicit selection or changed default policy fails clearly instead of replacing or silently migrating the conversation.

Text is streamed through AG-UI-compatible text/run events; run events respect the upstream `traceEvents` flag. Chat completion, cancellation and heartbeats use the runner protocol. The upstream chat protocol lacks an attempt-fenced result and deduplicated event offsets: **run only one polling consumer per external-agent identity**. Pending chat result delivery pauses further chat claims. A reclaimed chat attempt reconstructs the durable answer that upstream cleared, without another coding turn; lost chat event acknowledgments can cause duplicate stream fragments.

## Runtime design and lifecycle

```text
It's a Plan external-agent API
  → server/protocol.ts (adapted runner client)
  → server/engine.ts (claims, leases, concurrency, delivery)
  → issue → stable project → explicit override or unique linked-repository match → provider selection
  → server/paseo.ts → native Paseo session/worktree/provider
  → events/results → It's a Plan
```

- `index.server.ts`: current contribution lifecycle, host settings, typed RPC handlers and turn-ended hook.
- `index.client.tsx`, `client/`: native plugin SDK UI, sidebar, settings, command center and host-aware session navigation. No DOM-only UI dependency.
- `shared/`: Zod-validated protocol/configuration models and RPC contracts.
- `server/storage.ts`: serialized private credentials/journal, atomic multi-record updates, durable thread bindings, single-backend lock.
- `server/service.ts`: configuration, managed startup/reconnection, interactive context reuse and teardown.
- `server/host.ts`: owning-daemon discovery, private local authentication, explicit transport overrides and connection/reconnection identity fences.
- `server/projects.ts`, `server/repository-matching.ts`, `server/git.ts`: project-scoped metadata discovery, registered-checkout matching and read-only Git validation.
- `server/task.ts`, `server/plan.ts`: structured task intent, narrow native delivery instructions, selection provenance and separate acceptance evidence.
- `server/experience.ts`, `server/rerun.ts`, `server/diagnostics.ts`: non-claiming readiness/queue/plan inspection, fenced human requests and structurally redacted diagnostics.

**Why one owned SDK connection exists:** Paseo 0.13's `PluginServerContext` has no `paseo` API at startup, its public agent handle has no cancellation method, and public `PaseoApi.agents.create` requires an explicit `provider/model` string. RPC handlers use their supplied `PaseoApi`; unattended startup, cancellation, and creation without a model override use a small in-process SDK adapter. Explicit-model creation remains on the supplied public API. Automatic execution reuses its owned connection; an interactive native-default creation opens and closes a scoped owning-daemon connection when necessary. `server/host.ts` and `server/paseo.ts` isolate these details. No second process or independently managed service is started. The SDK is pinned and the compatibility range deliberately conservative.

SDK limitation: on a synchronously rejected wrong-identity handshake, SDK 0.13 may arm one final bounded liveness timeout after transport disposal. The closed transport cannot dispatch agent work; plugin deadlines and subscriptions are removed. This SDK-owned teardown race is not patched through private timer fields.

**Runtime controls:** **Pause** persists a claim fence without changing saved automatic settings or canceling active work; existing leases and result delivery continue. **Pause and stop…** additionally requests cancellation and requires confirmation. Stop is acknowledged only after Paseo reports idle, no active turn and zero pending permissions. The plugin denies pending approvals before cancellation; it never approves them. A missing snapshot or timeout is **unconfirmed**, not proof of a stopped session.

Each claimed execution captures its configuration, credentials and timeout/lease limits. Safe settings changes affect future claims only. Connection or execution-key changes drain the current engine and pending delivery before replacement; pending configuration is visible. While the plugin remains active, unconfirmed cancellation keeps renewing a still-valid lease and retries native stop, with new claims fenced. Explicit lease rejection or the safety deadline ends renewal and requires native stop/reconciliation.

**Disable/reload policy:** stop new claims, abort pending requests, request native cancellation of active **claimed run/chat** turns, preserve sessions/worktrees, and retain/report interrupted outcomes as **`failed`** only when cancellation is confirmed. Completed outcomes awaiting delivery are not overwritten. Teardown is bounded by Paseo's shutdown deadline: disabling cannot maintain leases indefinitely or prove an unresponsive session stopped. Unconfirmed cancellation is persisted for recovery and operator review. **Manual issue-origin sessions have no external execution lease and continue in Paseo**; cancel them explicitly when needed. A hard process kill cannot guarantee synchronous cancellation; recovery validates the attempt and upstream lease before observing saved work.
 
When a manual turn-ended event was missed while the plugin was inactive, opening a status surface reconciles its association through the supplied native Paseo API. A one-minute grace window protects in-flight creation/send acknowledgments. Active native turns remain active; missing/archived sessions become explicit failures; idle sessions without an observed outcome become `uncertain`, never inferred success. A concurrently observed completion wins over an older reconciliation snapshot.

Startup initializes private storage, validates configuration, reconciles saved work, connects when automatic execution or recovery needs it, then polls. Temporary errors back off and reconnect. Claim authentication failures stop claiming until configuration/credentials change. Timers, subscriptions and owned connections are cleaned up on normal teardown. Storage failures fail closed and cancel owned execution rather than discarding state.

## Persistence and recovery

Private state defaults to `$PASEO_HOME/plugin-data/itsaplan` (otherwise `~/.paseo/plugin-data/itsaplan`). `ITSAPLAN_PASEO_DATA_DIR` can select a separate private directory for another daemon. Do not share a directory between hosts or use it as a network/distributed lock.

- Directory mode **0700**, JSON files **0600**, fsync + atomic rename; corruption is reported and preserved rather than overwritten with empty state.
- `credentials.json`: external execution API key, optional separate human request key, MCP token and Paseo password. The current plugin SDK has **no credential vault API**; these are restricted local files, **not OS-keychain encryption**. Protect the daemon account, disk and backups.
- `sessions.json`: server-scoped run/message IDs, execution attempt, deterministic agent ID, workspace, issue/project, source mapping, immutable execution limits/plan, actual model/mode, heartbeat/cancellation, pending result/events, acceptance evidence, historical review observations/timestamp, chat bindings, runtime pause and fenced requests with delivery/actor scope. The checkout is committed before native creation; restart cannot retarget prepared work. This is recovery/delivery metadata, **not a second task queue**. Only It's a Plan assigns work. Prompts, comments and output can be sensitive; protect journal/backups.
- Optional context/provenance, continuation grants and approved ticket-report fences are part of that journal, not durable lifecycle events. Public status uses an explicit allowlist: original task/system text, captured context/asset references, grants, pending event payloads and private report bodies are excluded.
- A nonce-bearing, atomically installed local owner lock rejects another live backend. Dead-owner recovery never deletes a replacement owner's lock. Use one installation/data directory per daemon.
- Closing storage rejects late mutations from a retired backend before releasing ownership; an old callback cannot overwrite a replacement backend's journal.

| Interruption | Recovery behavior |
| --- | --- |
| Same claim/attempt repeated | Existing record, active-task guard and stable native creation ID prevent another dispatch. |
| Crash before/after session creation | Persisted preparation plus native idempotency recovers the same agent; mapping is committed before sending. |
| Crash after mapping, before send | Resume the saved session; send only from a known unsent phase. |
| Repository link or checkout match changes after preparation | Reuse the execution's persisted source mapping; do not dispatch its restart into the newly discovered checkout. Existing chat bindings retain their original source. |
| Send acknowledgment or idle turn outcome ambiguous | Never blindly replay a possibly mutating prompt. Report a coordinator failure and retain the linked session for inspection. |
| Restart while native session is active | Validate/renew the execution attempt, resume observing that session and its original timeout. |
| Older attempt superseded | Stop the old native turn before reusing its session. A durable completed result, including one with an uncertain old acknowledgment, is transferred atomically to the newly claimed attempt without rerunning code. |
| Network failure during execution | Keep retrying heartbeat while within the local safety window; cancel on deadline or explicit lease rejection. |
| Result saved but network/ACK lost | Retry delivery, not execution. A stale/conflict/not-found acknowledgment is marked `uncertain`; inspect upstream history. This protocol cannot prove exactly-once delivery. |
| Missing/archived session | Report failure without creating a replacement conversation or canceling a nonexistent turn. |
| Reload/disable while active | Explicit cancellation policy above; preserve sessions/worktrees and pending outcomes for reconciliation. |
| Stop acknowledgment unavailable | Persist unconfirmed cancellation, fence new claims and retry native stop; while active, renew only a still-valid lease. Unknown native state is never treated as idle. |
| Rerun preview closed before handoff | Dismiss the untouched preview; no upstream comment or run is created. |
| Rerun comment/API acknowledgment uncertain | Keep the original nonce and reconcile authoritative queue metadata. Browser handoff recovery exposes only the exact already-handed-off text; it never reposts or upgrades the delivery channel. |
| Continuation preparation/reload | Recover the same handed-off nonce and immutable scope; never infer approval from issue identity or transfer it to a retry. Expired historical grants may be followed for a new fresh rerun, but cannot authorize another continuation. |
| Source changes during native refresh | The admission epoch and fresh native identity fence reject dispatch. A never-dispatched reused source is not canceled. |
| Captured image absent/corrupt | Fail without substituting newly fetched content or silently dropping the captured image. |
| Ticket report acknowledgment lost | Retain the exact fenced body/marker and reconcile the complete bot-authored comment feed; do not repost or infer absence from a partial feed. |
| Invalid credentials | Pause claims; replace credentials/test/save to restart. A credential replacement does not grant additional upstream project permissions. |
| Historical outcome differs from delivery evidence | Compare both sources, then optionally record a review timestamp. Preserve unknown acknowledgment and all execution/cancellation state. |

Upstream run results are only **`success` / `failed`**. Timeout, cancellation and agent error are `failed` results with explanations, not invented wire statuses. Journal phases such as `running`, `canceled`, `lease-lost` and `uncertain` are local coordination state. Run attempts are sent on heartbeat, events and result; chat uses server cancellation responses and its more limited attempt semantics. Reported failure is terminal upstream; lease expiry, not arbitrary client retry, drives server execution retries.

## Optional MCP

Core claiming, routing, leases, execution, cancellation and reporting work with MCP disabled.

To opt in, supply an It's a Plan MCP HTTP URL and a **different, scoped MCP credential**, enable MCP, and select provider IDs. MCP uses Bearer authentication; the external execution key is never injected into agents. Canonicalized execution/MCP credential equality is rejected, including concurrent updates.

Paseo 0.13 exposes `supportsMcpServers` on sessions, not the provider catalog. Injection requires positive capability evidence from an existing session for that provider and no observed negative evidence. Unknown/unsupported capabilities omit MCP without blocking execution; create/inspect an ordinary Paseo session first when enabling a newly configured provider. An existing session is not retrofitted.

The separate MCP token is intentionally delivered through native session MCP configuration and inherits Paseo/provider storage and retention. Clearing it here affects future injection, not already-created sessions; revoke or rotate it upstream when removing access.

Exact selected tool names become Paseo **preapprovals**, not a security capability filter. Unlisted tools may still be requested through ordinary Paseo permissions. Restrict reads, comments, subtasks, issue edits and dependencies with the separate MCP account's upstream role; the plugin does not invent unavailable server-side scope restrictions. No runner key is placed in prompts, environment variables or MCP headers.

## Security boundaries

- Plugins execute trusted code with daemon-user access; this is not a sandbox for malicious plugin code or a compromised daemon account.
- Issue descriptions/prompts are untrusted. They never select filesystem paths or become shell commands. Native provider tools can still read files allowed by their permissions; restrict the daemon account and provider mode accordingly. Permissions, not prompt instructions, enforce destructive-action approval.
- Repository roots are operator-configured or uniquely matched from structured linked-repository metadata to canonical, registered local Git checkouts. Native checkout/worktree identity is checked after creation. Git runs with fixed read-only argument arrays, never a provider CLI or a shell containing issue content. Discovery requires a complete readable catalog; ambiguity and metadata denial never select an arbitrary checkout.
- External HTTP requests have deadlines, validate response shapes, reject redirects, and avoid response-body/credential logging. TLS verifies normally. The backend validates the daemon address before sending its password.
- Interactive request contexts capture server settings and credentials coherently. Connection/credential changes invalidate stale contexts before human-authenticated delivery or browser-body exposure, preventing a new key from being paired with an old server URL.
- Secrets are write-only over RPC; client inputs are masked, initially blank and cleared after save attempts. Status returns presence booleans, not secrets or persisted task prompts/event buffers. Execution output still appears in normal authorized session/status views.
- No automatic merge, push, issue completion or permission approval. Retention/backup and eventual worktree cleanup are operator responsibilities.
- **Preview diagnostics** displays an allowlisted structural snapshot: no credentials, prompts, output, URLs, local paths or raw errors. **Copy diagnostics** copies the already-loaded text; denial leaves it selectable for manual copying without broader clipboard permissions. Ordinary authorized execution views still contain output; protect the private journal.

## Verification and licensing

`npm run typecheck` checks server and native UI separately, including tests under their Bun-aware configuration. `npm test` runs `bun test server client`: protocol, execution, leases, provider/project routing, cancellation, storage/restarts, chat recovery, historical review and client request/resource-state boundaries. See [VERIFICATION.md](VERIFICATION.md) for exercised live evidence and unavailable prerequisites; mocked tests are not live provider validation.

Apache-2.0: [LICENSE](LICENSE), [NOTICE](NOTICE), [THIRD_PARTY.md](THIRD_PARTY.md). Only the separately Apache-licensed It's a Plan runner was adapted; the root application's AGPL license is not assumed to apply to that runner, nor is runner licensing assumed for other upstream files. Dependencies retain their own licenses.
