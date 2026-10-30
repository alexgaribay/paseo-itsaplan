# Verification

## Source/API verification
Paseo 0.14.0 upgrade: both TypeScript configurations passed and `npm test` passed 673 tests across 28 files (2,326 assertions) against the 0.14.0 packages. The installed protocol's compatibility check accepted 0.14.0 and 0.14.1 and rejected 0.13.2 and 0.15.0 with the updated manifest. No live 0.14 daemon or provider session was exercised.

After the session-open integration, `npm test` passed 675 tests across 28 files (2,337 assertions), and both TypeScript configurations passed. The engine check covers persisting launch identity before delegated and manual agent creation without journaling the token. A disposable local registry smoke exercised the actual session-open resolver with a journaled agent and private credential: the matching open received MCP, while a cleared credential and a different agent did not. No live 0.14 provider session was exercised.


The original implementation was reviewed against the then-installed 0.13.0 SDK. Versions/revisions and exact adapted files are in [README.md](README.md) and [THIRD_PARTY.md](THIRD_PARTY.md). The initial scaffold was generated with `paseo plugin init`. The review covered lifecycle, settings/RPC, provider catalogs, workspace/agent creation, navigation and session-scoped MCP configuration. No language server was configured in that workspace; installed declarations and runtime calls supplied the signature evidence.

Specific protocol checks against current runner **and server** source:

- `x-api-key`, run/chat claim/heartbeat/events/result routes, run attempt fencing, success/failed results, 30/35-second HTTP deadlines, 60-second heartbeat interval.
- Server chat claims include `attempts`, despite the runner client's narrower type. Chat results/events do not have the same attempt/offset fencing as run requests.
- Bot-account project/issue REST access, paginated project search, qualified project references, stable `issueId → projectId` lookup and numeric issue web permalink.
- Run heartbeat rejection vs explicit chat cancellation; terminal reported failures vs server retries on expired leases.
- Paseo 0.13 lacks startup `paseo` context and public agent-handle cancellation; the pinned in-process transport adapter is necessary, not a separately managed service.
- Native worktree branch normalization was observed live. New workspaces now use Paseo's explicit workspace creation API with a slash-free canonical issue-identifier prefix and native idempotency key; existing worktrees retain their recorded names. SDK-boundary and disposable Git checkout regressions cover branch/checkout mismatches. This is not a new live worktree/provider acceptance run.

## Automated checks

Executed on macOS arm64 with Node **26.12.1**, Bun **1.4.2**, Paseo/SDK **0.13.0**:

```sh
npm run typecheck
npm test
```

Latest observed after the combined multi-bot, named-profile and default-enabled project changes: **both TypeScript configurations passed; 604 tests passed, 0 failed, 1982 assertions across 25 files**. `npm test` includes server and native client-state tests.

| Area | Behavioral coverage |
| --- | --- |
| `server/protocol.test.ts` | API-key authentication, validated run/chat claims, attempts, result/event formats, response errors, connection/auth classification, cancellation and HTTP deadlines, projects/issues and non-claiming authentication probe. Distinguishes a locally detected non-agent identity from remote HTTP 403 while keeping identity/credential/response details private. |
| `server/paseo.test.ts` | Provider/model/mode discovery and precedence, no unavailable-provider fallback, configured repository/workspace identity, native worktree options and returned checkout validation, send/turn lifecycle ordering, usage/text, permission/timeout/error behavior, optional MCP capability and credential boundaries. |
| `server/engine.test.ts` | End-to-end mocked claim/routing/creation/prompt/heartbeat/completion/report/persist flow; multi-project selection; reservations/concurrency; network/auth failure; duplicate claims; timeout/cancellation; stale lease; shutdown during send/result; restart windows; unavailable/missing/archived sessions; lost ACK; attempt transfer after uncertain report; chat initial/follow-up/reclaim; atomic recovery; explicit per-project milestone transitions only. |
| `server/storage.test.ts` | Durable reload, corruption preservation, restricted files, concurrent credential merges/equality checks, live/dead owner locks and stale-PID replacement contention, serialized journal updates and atomic batch recovery. |
| `server/service.test.ts` | Manual-session reconciliation after missed lifecycle events: active/idle/missing/archived native state, send-acknowledgment grace, temporary lookup failure, and an observed completion winning a stale snapshot. Also verifies that an authenticated non-agent account produces an authentication error before automatic execution starts, without exposing credentials or identity details. |
| `server/bots.test.ts` | Legacy default storage, per-bot keys/journals/pause state, shared credentials/configuration, independent authenticated pollers, duplicate-account rejection, teardown and retired-bot delivery/restart recovery. |
| `server/repository-matching.test.ts` | Real disposable Git checkouts, canonical roots, registered-only discovery, safe remote normalization, HTTP/custom ports, credential stripping, independent clones vs shared worktrees, stale/malformed catalogs and cancellation. |
| `server/projects.test.ts` | Per-project permission failures, complete-catalog failure, explicit overrides without discovery privileges and cancellation propagation. |
| `server/host.test.ts` | Private runtime metadata, home/transport resolution, readiness/staleness, target-bound credentials, manual endpoint migration boundaries, initial/reconnect identity fences, deadlines and transport/subscription cleanup. |
| `server/task.test.ts` | Exact-output boundaries, incomplete tool evidence, canonical request parsing and preservation of upstream system instructions. |
| `server/task-protocol.test.ts` | Authoritative original task resolution, project/actor/attempt checks, referenced requests and bounded chains; real loopback HTTP cancellation through the client lifetime signal. |
| `server/plan.test.ts` | Provider-compatible inheritance and selection provenance, including manual, issue, project, global and unresolved native defaults. |
| `server/experience.test.ts` | Readiness, queue completeness/unavailability, provider/project routing, structurally redacted diagnostics and durable human-request preparation/submission/reconciliation/duplicate fences. |
| `server/review.test.ts` | Independent upstream/native/delivery observations; read-only comparison; durable review without changing execution evidence; stale fingerprints, concurrent local changes, wrong scope/attempt, missing/active native state, pending permissions and cancellation fences. |
| `client/state.test.ts` | Exact handoff text retained across reconciliation, request isolation, safe preview closing, refresh retention and clearing data when resource scope changes. |

The SDK and HTTP mocks exercise integration contracts, not real provider binaries. New tests assert consumer-visible state, outcomes, boundaries and transitions; they do not assert source text or copy-forward wiring.

## Initial live acceptance

Used an **actual local It's a Plan API checkout at the recorded revision**, its migrations on an isolated database in an existing PostgreSQL 16 instance, and the existing **Paseo 0.13.0 daemon**. No Docker container, runner process, integration daemon or replacement execution service was used. Disposable owner/bot credentials and two empty Git repositories were confined to acceptance fixtures.

Observed results:

1. Installed and reloaded the native plugin through Paseo; backend reached running state.
2. Non-claiming connection test succeeded with a real external-agent API key. Its single agent identity had access to two projects.
3. Mention assignments produced real server queue entries. The plugin claimed both, resolved their distinct project IDs and executed through Paseo's **OMP** provider using its advertised **`kimi-code/k3`** model.
4. Both final runs reported **success** upstream with `PASEO_ACCEPTANCE_OK`; usage was **538 input / 31 output tokens per run**. Project A used a native isolated worktree; project B used its explicitly mapped existing checkout. The issue columns remained unchanged.
5. Issue project listing, search and details worked through the real bot-account REST API and plugin RPC.
6. Initial chat and a follow-up streamed text upstream, completed successfully and retained the same native agent/workspace. A plugin reload preserved all associations without duplicate sessions.
7. Manual issue attachment and a new issue-origin session succeeded through native plugin RPC.
8. Server-side chat cancellation stopped the native turn. The Paseo session became idle with no active turn and remained unarchived; conversation/worktree were preserved.
9. Explicit **Codex** and **Claude** overrides were rejected with `Selected Paseo provider is unavailable`, without creating coding sessions or falling back to OMP. During initial development, an acceptance script changed configuration while a claim was active and triggered the then-current configuration-interruption policy. The final provider checks saved overrides before enqueueing work. Safe settings saves now leave existing work running; see the experience/reliability pass below.
10. Loaded the **actual installed Paseo web assets and native plugin UI** in Chromium. Verified project selection, issue search/detail rendering, connection-test feedback, empty/masked stored-secret inputs, project policy editing/clearing and successful configuration save. Captured visual proof at desktop and 390-pixel compact width; no document horizontal overflow at compact width. This is a native SDK web rendering check, not an iOS/Android app test.
11. Exercised manual reconciliation against the actual archived native session, not a mocked SDK. Its stale running association became a persisted failure without another prompt or a replacement session. Reloaded the final plugin and verified its updated native policy UI and empty unconfigured session view.

For browser acceptance only, a temporary same-origin local WebSocket relay served the installed application assets because the daemon correctly rejected the test page's foreign Origin. It did not change daemon security settings and is not part of this plugin or its installation/runtime architecture.

## Not verified live / prerequisites

- **Codex execution:** provider discovered but unavailable on this daemon. Configure/install/authenticate it through Paseo before running the live success path.
- **Claude Code execution:** not in this daemon's available provider catalog. Configure it in Paseo before running the live success path. No provider-specific support claim is inferred from mocked tests.
- **Optional MCP:** disabled during live execution. Injection/capability/secret behavior has automated coverage, but actual scoped It's a Plan MCP tools across OMP/Codex/Claude were not exercised.
- **Hard daemon crash/restart:** not forced on the user's shared running daemon. Crash/restart boundaries and stale/missing-session handling have deterministic automated coverage; actual clean plugin reload was exercised.
- **Live long-duration lease expiry, result-ACK loss and network partition:** covered by deterministic mocked scenarios, not a deliberately disrupted shared environment. The fast live OMP turns do not constitute a 60-second heartbeat soak test.
- **Live forge push/PR/merge:** initial acceptance did not automate this. The automatic Git lifecycle added below is verified against disposable local bare remotes, not live forge authentication, protected-branch policy or PR APIs. PR creation/merge remains outside the plugin.
- **Native iOS/Android and other host OSes:** not run. React Native plugin SDK components/typechecking and desktop/compact web rendering were checked on macOS.

## Repeating live acceptance

Use a dedicated external agent, least-privilege bot role, two scratch projects and Git checkouts. Save mappings/provider overrides before enqueueing assignments and run **Check readiness**. Claims capture their policy; later safe settings changes affect future claims, while connection changes drain existing work. Assign or mention the external agent on one issue per project with an instruction such as `Respond PASEO_ACCEPTANCE_OK; do not use tools or modify files`. Observe server history and the associated real Paseo session; check output, workspace checkout and unchanged issue columns.

Create a chat thread, map its returned ID in plugin settings, and submit an initial message/follow-up. Check the same native session ID, then cancel a deliberately active chat and confirm idle/unarchived session state. Reload the plugin between completed messages and check associations. Repeat real successful execution separately for each provider actually available on the daemon; an unavailable-provider error is not a successful provider acceptance test.

The development acceptance scripts and credentials are throwaway material, not shipped tests or a runtime service. Restore host settings, remove disposable credentials and owned fixtures, stop temporary services and drop only the isolated acceptance database after validation. Preserve any unexpectedly dirty worktree rather than deleting it.

## Environment after acceptance

At the end of the initial acceptance run, the installed plugin was **enabled but unconfigured**, with automatic delegation **off**, no stored integration credentials and no fixture session associations. Original host settings were restored and checked through native RPC. The disposable native sessions/workspaces were archived through Paseo; fixture worktrees were removed through its native cleanup API. Temporary API/browser services were stopped and the isolated PostgreSQL database was dropped. The user's existing Paseo daemon was not restarted or replaced.

A separate native API confirmation enumerated the complete paginated workspace catalog with background workspaces included and checked all six acceptance workspace IDs. **All six were absent**. This confirmation checked record IDs independently of directory metadata; the earlier cleanup script's `No workspace directory` entries were not treated as proof of archival.

## Settings clarity follow-up

`npm run typecheck` passed after the API/web labels and direct project setup changes. Verified the actual native plugin UI using installed Paseo assets and isolated, browser-only settings/project fixtures: two named projects with direct repository setup; editing/removing one project's draft without affecting the other; distinct API/web URL examples; actionable first-run and empty-account states; desktop and 390-pixel compact layout without horizontal document overflow. No saved settings or credentials were written. These UI fixtures do not constitute another live It's a Plan API acceptance run.

## External-agent credential guidance

The required field is labeled **External-agent execution API key**, with setup instructions explicitly excluding personal account keys and MCP tokens. Verified the actual installed native UI and live connection test: an authenticated regular account produces actionable credential-type feedback rather than a generic 403, the feedback appears after the connection-test control and before credentials, and secret inputs remain blank. Saved settings matched their pre-verification fingerprint; credential presence was unchanged and no credentials were written. Screenshot capture timed out in the headless harness, so UI evidence used rendered DOM and viewport bounds rather than a screenshot. The temporary browser/server and verification files were removed.

## Native settings cleanup

Compared current Paseo source at `72e3316f4f5dfe775c77dbf998968c92e2de9019`: native `SettingsSection`/`SettingsInfoTip`, grouped settings controls, provider settings, and the SDK settings example. The plugin now uses the public SDK's section `info`/`trailing` slots, icons, loading state, toast feedback, and responsive `Modal`/`Modal.Content`; no private app components were imported.

Both TypeScript configurations passed. Exercised the actual installed Paseo web assets and reloaded plugin through a loopback-only verification relay. Checked the real saved configuration read-only first, then isolated all configuration/credential writes in in-memory UI fixtures:

- Native project help tooltip replaces the former description-only row; desktop screenshot confirms the compact project list and header refresh action.
- Project editor cancellation preserves the main draft; applying updates only the draft, and native save acknowledgment returns it to the clean state. Disabling worktrees hides the base-branch input and persists the false flag in the fixture. The explicit-path requirement from this earlier pass is superseded by automatic matching below.
- Provider dropdown uses the discovered catalog; selecting and discarding restores the saved selection.
- Five-second polling saves as `5000` milliseconds; a half-minute timeout saves as `30000` milliseconds.
- Write-only credential fields are masked and initially blank. A nested MCP credential save updates only its isolated presence state, while canceling MCP configuration leaves the enable switch off.
- Host connection, chat routing, issue overrides, milestone columns, optional MCP, and execution history remain accessible through their focused editors.
- Native browser screenshots and DOM measurements verified desktop layout and a **390×844** compact bottom sheet, with no horizontal document overflow. No console errors were reported. The initial headless capture timed out; the native Paseo browser supplied the visual evidence.

Two configuration saves and one credential save affected only the in-memory fixtures. The real settings fingerprint and credential-presence flags were unchanged; automatic execution remained off and no task was claimed or coding agent started. This UI pass does not establish execution readiness or repeat the live It's a Plan/provider acceptance.

Closed both verification browser tabs and stopped the relay; removed its script and the temporary Paseo reference checkout. The native plugin was left reloaded, with the user's saved configuration and credentials unchanged.

## Automatic repository and owning-host matching

Reviewed current Paseo source at `72e3316f4f5dfe775c77dbf998968c92e2de9019` and It's a Plan Git connection routes at `599af2bbb5364e55f551dbea7c1736b7c3749eae`. The latter project-scoped GET filters linked repositories and currently requires **`repositories: edit`**. The secret-bearing `/settings/git` route is not used.

- The final full suite passed **205 tests**; both TypeScript configurations passed. Added execution-level coverage for unique matching, ambiguity, explicit overrides without metadata access, per-project opt-in, preparation/restart pinning, and chat follow-ups after repository discovery changes.
- Live automatic discovery found **Nova**, `srv_f-KYg2DdGkzm`, at `ws://100.125.212.68:6767/ws`. Automatic local authentication, the native `integration.host` RPC, and the settings host-connection test succeeded without claiming work.
- The live native catalog contained **11** canonical registered Git repositories. A synthetic linked-repository URL derived from that real catalog produced a unique match. This proves the native catalog/normalization/matcher path, not upstream repository-read authorization.
- The real external-agent key could list six It's a Plan projects, but every project-filtered Git connections request returned **403**. Repository matches are therefore unavailable on this installation until the external agent has the required upstream permission, or explicit overrides are configured. No permission changes were made.
- Exercised the actual installed native app/plugin UI through a temporary loopback verification relay, with project/provider/settings writes isolated in memory: automatic host summary and detected identity; live saved-host connection test; conditional manual URL/password fields; named match/ambiguity/unavailable summaries; empty repository override accepted for a unique match; per-project opt-in applied and saved; ambiguity blocks automatic opt-in; native matching-checkout selector fills the chosen explicit override.
- Desktop bounds at **1440×1000** and compact document bounds at **390×844** had no horizontal overflow. Compact sheet content was present in the DOM, but its visual rendering was not established. Native screenshot capture reported an unpainted tab; headless Chromium screenshot capture timed out. No screenshot-based visual acceptance is claimed for this pass.

An initial raw RPC fingerprint assertion across the schema reload was inconclusive: newly added defaults change the read response shape. The isolated preview checked schema-normalized values **and persisted revision**, plus credential-presence flags; these remained unchanged. One save affected only its in-memory fixture. Automatic delegation stayed off, no external execution was active, and no task was claimed or coding agent started. These checks do not repeat live coding-provider acceptance.

Both isolated previews exited cleanly and confirmed unchanged normalized settings, persisted revision, and credential-presence flags. Closed the native and headless verification tabs, stopped both relays, and removed the throwaway scripts and temporary upstream checkouts. The local plugin remains reloaded with automatic delegation off. The strengthened host error-redaction regression also passed in its focused 55-test suite.

## Native model-default correction

The installed public SDK 0.13 requires `provider/model` in `PaseoApi.agents.create`; it cannot represent an omitted model. The plugin previously selected the first catalog entry when all model settings were blank. It now preserves that blank through selection and uses the existing owning-daemon SDK adapter to create without a model override. Explicit models retain public API creation and validation; both automatic and interactive paths support the corrected default.

The full server suite passed **206 tests**. After the final provider-reference correction, both TypeScript configurations and the focused **23-test** gateway suite passed. The new regression verifies that native default selection neither picks the first catalog model nor depends on model-catalog discovery.

Live activation configured only Token Watch, after checking dev-bot's six project feeds and finding only TW-1 pending. The initial explicitly selected K3 run was claimed and created a real isolated worktree/session. On the user's request to stop using K3, the override was cleared and automatic delegation paused. Normal cancellation was not acknowledged while an OMP tool-approval question was pending. That exact request was denied, then native cancellation succeeded; the session was observed **idle**, with no active turn and zero pending permissions. No tool was approved. It's a Plan recorded the interrupted run as **failed**; the local delivery acknowledgment remains `uncertain`, with no automatic replay.

A separate **no-prompt** native-default creation omitted the model and still resolved to `kimi-code/k3` through this Paseo installation. The verification agent never ran a coding turn and was archived. Delegation was kept **off** until the user selected a non-K3 policy. The corrected plugin was reloaded with the blank model preserved, and the temporary Paseo source checkout was removed. This was not a successful smoke-turn result.

The user then explicitly selected **OMP / GPT-6.1-Sol**. All six project feeds were checked again and contained no pending dev-bot runs. Token Watch now has an explicit `openai-codex/gpt-6.1-sol` override, approval mode `ask`, and isolated worktrees enabled. Global and Token Watch delegation are persisted **on**, and the backend was observed **connected** to the external-agent feeds. Other projects were not enabled. The stopped K3 session was archived to prevent its reuse; its conversation/worktree were retained. TW-1's failed execution was not re-delegated or replayed. This verifies configuration and feed connectivity, not a completed GPT-6.1-Sol coding turn.

## Experience and reliability pass — 2026-10-25 UTC

Rechecked current Paseo source at `72e3316f4f5dfe775c77dbf998968c92e2de9019` and It's a Plan at `79f7802af892df8a1eaba190a02d2fe182fe6785`. Verified original queue task metadata, external polling identities, human-only comment triggers and the absence of a supported public rerun mutation. The Apache adaptation base remains unchanged.

Final commands: both TypeScript configurations passed; **285 tests passed, 0 failed, 778 assertions across 12 files**. New regressions include unchanged defaults preserving an existing chat, lease renewal during unconfirmed cancellation, late closed-owner storage writes, untouched-preview dismissal, request delivery uncertainty and structured task intent. The chat, lease and late-write regressions were observed failing before their fixes and passing afterward.

Reloaded the actual installed plugin on **Nova** (`srv_f-KYg2DdGkzm`) from this checkout. Read-only readiness identified Token Watch as configured and the other five projects as disabled/unresolved, with the global unfiltered-claim warning. Plan inspection resolved project `7` to the configured Token Watch checkout, isolated worktrees, **OMP / `openai-codex/gpt-6.1-sol` / `ask`**, all from project policy. Diagnostics parsed as JSON and excluded the API URL, local paths and smoke output.

For one isolated live smoke, runtime claims were paused without changing saved configuration. A reviewed browser handoff was persisted before exposure; a single human-authored canonical mention was posted to **TW-1** as comment **7**. Reconciliation observed authoritative queued run **3**, then claiming was resumed:

- It’s a Plan run **3**, attempt **1**, reached **success**; the persisted native result was exactly `PASEO_IAP_SMOKE_OK`.
- Native agent **`cf46edd1-9d0e-5d9f-af0b-a21622d1a5b9`**, workspace **`wks_29cefbcaeb8b4e13`**, actual **OMP / `openai-codex/gpt-6.1-sol` / `ask`**.
- A successful initial heartbeat was recorded. The roughly six-second turn does **not** prove a 60-second heartbeat soak.
- Acceptance **passed**: exact final answer, **0 observed tool calls**, complete turn history. Tools were not disabled; this is observed behavior, not a sandbox guarantee.
- `git status --porcelain=v1` in the new native smoke worktree returned empty. TW-1’s requirements and Backlog column **31** were unchanged.
- The linked native conversation/worktree and upstream audit comment/run were retained. No merge, push, issue-status transition or coding-agent MCP access was used.

Exercised actual installed Paseo assets and the native plugin bundle through a temporary loopback-only verification relay, without mocked settings or API responses. Checked readiness and project actions, explicit API/web labels, bulk selection gating, execution delivery versus acceptance, model/mode provenance, smoke review and untouched-preview dismissal. Captured rendered desktop visual proof in an isolated browser after the shared/native screenshot surfaces failed. The browser denied clipboard writing; the UI displayed the actual SDK rejection instead of reporting success. Redaction was verified through the deployed diagnostics RPC; successful browser clipboard delivery is not claimed.

The final clean plugin reload preserved run 3’s finished result, native agent/workspace IDs and all three session associations; no new upstream run or association appeared. The untouched UI smoke preview was durably **dismissed**. Saved normalized settings, the original persisted revision and all four credential-presence flags were unchanged. The backend returned **connected**, **claiming enabled**, **paused false**, **0 active**, with a complete queue showing **0 queued / 0 running**. An in-flight long-poll reservation is not an active execution.

**Pre-existing attention record:** TW-1 run **1** still has local phase `uncertain`, delivery unknown and acceptance not assessed; upstream lists it as failed. It remains visible under **Sessions needing attention** for delivery review. The successful new smoke run and empty active queue do not resolve that historical acknowledgment uncertainty, and this pass did not erase or relabel it.

After reload, the actual native checklist displayed **Ready with warnings** consistently. Desktop **1440×1000** and fresh compact **390×844** document bounds had no horizontal overflow; the saved settings draft remained clean. Compact bounds are DOM evidence, not an additional compact screenshot.

Closed all owned verification tabs, stopped the temporary UI relay and isolated Chrome, and removed their scripts, profiles, screenshot and upstream reference checkouts. The existing Paseo daemon and shared browser infrastructure were not restarted or replaced. The plugin remains enabled and reloaded with the user’s original saved execution policy; the new smoke conversation/worktree and upstream history are retained.

## Five follow-ups — 2026-10-25 UTC

The standard command now runs both backend and client-state regressions: `npm run typecheck` and `npm test` (`bun test server client`). Observed **342 passing tests, 0 failures, 1002 assertions across 14 files**. Added no-history issue-origin smoke, forged/stale marker and actor/channel fences, credential snapshot races, paused-during-delivery checks, recovery without another POST, historical review and explicit-refresh retention. Test sources are checked in the Bun-aware configuration rather than weakening native app types.

Verified the installed `itsaplan` source path is this checkout on **Nova**, then exercised the deployed contracts:

- Run 1 comparison independently reported **upstream failed / native archived / 0 pending permissions / delivery unknown / acceptance not assessed**. The real native **Mark reviewed** action wrote `reviewedAt: 1792942025585` and its observation. This was an intentional private-journal acknowledgment during UI verification, not a read-only fixture. Phase, result, cancellation, delivery and acceptance were not rewritten; the unknown receipt remains visible. The acknowledgment survived reload.
- Browser clipboard permission was explicitly denied in an isolated browser. The actual SDK copy rejection appeared; loaded diagnostics stayed present, redacted and exactly selectable. The native text element had `user-select: text`. Full-width text replaces the former narrow settings-value column; no clipboard privilege or mocked success was introduced.
- The native **Test delegation** setup discovered projects, selected existing Token Watch/TW-1 and produced an issue-origin plan without requiring a source run. Guidance was not rendered as error alerts. A separate browser handoff was confirmed through the deployed RPC with the same reviewed request ID.
- Reloaded the browser before posting and recovered request **`3cbe9396-765f-4d69-946b-76dc2abdd5a2`**. The displayed comment matched the exact persisted text, with no submit control and no native session associated yet. Recovery did not create a new nonce or post a comment.

One controlled issue-origin live smoke then exercised the new canonical v2 path. After an empty complete queue and zero active/reserved work were observed, a single human-authored comment **10** was posted to **TW-1**. Reconciliation observed queued run **4**, and the original claim-enabled runtime was restored:

- Run **4**, attempt **1**, reached **success** upstream and returned exactly `PASEO_IAP_SMOKE_OK` locally.
- Actual **OMP / `openai-codex/gpt-6.1-sol` / `ask`**, native agent **`fb205e61-4d8e-5ccf-a624-576cbd43c4c7`**, workspace **`wks_f60a79b1773336de`**.
- Acceptance **passed** with **0 observed tool calls** and complete turn history. An initial heartbeat was recorded; the roughly eight-second turn is not a 60-second heartbeat soak or provider-enforced no-tools isolation.
- The actual native tracker separately displayed upstream success, delivered native result and passed acceptance. `git status --porcelain=v1` in the new smoke worktree was empty. TW-1's body and Backlog column **31** were unchanged.
- The live issue-origin path did not reference an earlier run; existing history was retained. A physically empty session journal is covered by automated integration tests, not falsely claimed as a fresh live installation.

Live reload exposed a startup status race: the status handler constructed a native gateway before settings loaded. It now returns legitimate initialization state until configuration exists. Subsequent immediate post-reload status calls reconnected successfully. The final persistence check retained all four run associations, run 4's agent/workspace/result, the historical review timestamp and the exact recovered handoff body; saved normalized settings, original revision and credential-presence flags were unchanged.

The source/licensing pins remain those recorded above; no new upstream application code was copied. Codex/Claude successful execution, native iOS/Android, optional agent MCP, hard daemon crashes and long-duration lease/failure scenarios remain subject to the existing live-verification limits.

Final native rendering checks used actual installed assets and the plugin bundle, not mocked UI responses. Desktop recovery showed the exact comment at **468px within a 520px modal**, a visible already-observed-run/do-not-repost warning and no submit control. Denied clipboard writing left that exact comment selectable with persistent manual-copy guidance. The reviewed-history badge remained visible.

Fresh **390×844** web settings had no horizontal overflow or dirty draft. The native compact diagnostics sheet rendered selectable text at **340px**, entirely inside the viewport; desktop and compact visual proof were inspected. SDK compact bottom sheets group controls under an adjustable accessibility container, so the browser AX snapshot did not enumerate nested actions; rendered-text interaction and DOM bounds were used instead. This is not full assistive-technology or native iOS/Android acceptance.

Final code checks again passed **342 tests / 1002 assertions / 14 files** and both TypeScript configurations. Closed the owned browser, stopped the temporary guarded UI relay and isolated Chrome, and removed their script, profile and screenshots. Shared browser infrastructure and the user's Paseo daemon were untouched. A direct SDK check after cleanup still showed **connected / claiming enabled / paused false / 0 active**, an empty complete upstream queue, unchanged saved revision/normalized settings and unchanged credential-presence flags. Run 4, comment 10, the new native conversation/worktree and run 1's review acknowledgment are deliberately retained; historical delivery uncertainty is not erased.

## Historical-review identity correction — 2026-10-25 UTC

Post-review found that matching the upstream username, issue and project did not prove the run belonged to the authenticated external agent. Added four behavioral regressions for a same-username/different numeric agent ID, an internal agent, unavailable agent metadata and a push-configured agent. All four failed before the fix because acknowledgment was incorrectly enabled; all four now pass (**16 assertions**). Historical comparison now requires authoritative `protocol.agent()` metadata for the matching external polling agent and compares its numeric ID to `run.agentId`. Missing or inconsistent metadata leaves upstream attribution unverified and blocks acknowledgment.

Both TypeScript configurations and the complete suite passed again: **346 tests, 0 failures, 1018 assertions across 14 files**.

Guarded the installed plugin reload with zero active work and a complete empty upstream queue, then exercised the corrected comparison through the live Paseo plugin RPC. It reconnected with claiming enabled, paused false and zero active executions. Run 1 still compared as upstream failed/native archived with delivery unknown; its existing review timestamp **1792942025585** and comparison fingerprint were unchanged. No new acknowledgment, handoff, comment, execution or session was created. Run 4 retained upstream success, exact `PASEO_IAP_SMOKE_OK` output, passed acceptance and zero observed tool calls. Saved settings/revision and credential-presence flags were unchanged; TW-1 remained in column 31.

## Ticket-reporting convention — 2026-10-25 UTC

Added a per-task implementation reporting convention, shared by automatic issue execution and manual issue starts. Existing authoritative task-intent resolution, result payloads and issue-transition policies are unchanged. Manual prompting now uses the same issue-context builder without fabricating an upstream run ID. Known smoke intents omit both the implementation description and reporting convention; task-specific no-tools/no-posting/exact-output restrictions take precedence for other issue requests. Chat prompts and already-running turns are not rewritten.

Read-only upstream verification at revision [`ad87c568d1a872f830a526bd9ace774eafd57217`](https://github.com/croffasia/itsaplan/blob/ad87c568d1a872f830a526bd9ace774eafd57217/apps/api/src/modules/agents/runner/service.ts#L309-L344) confirmed `finishRun` persists execution output (currently capped at 10,000 characters) and records run completion; it does not post the answer as an issue comment. No upstream application code was copied. Reporting therefore uses permitted, already-available issue tools for meaningful interim comments and the existing result path for the final report; it does not promise comment delivery when tooling is absent or duplicate final delivery.

`npm run typecheck` and `npm test` passed: **347 tests / 1023 assertions / 14 files**. A new permanent engine regression supplies a structured report claiming completion, passed tests and review readiness while milestone destinations are configured. It verifies the turn finishes without granting acceptance, transitioning the issue or canceling the session: report prose is not independent evidence or authorization. A finite compiled prompt-generation smoke separately exercised manual issue input, comment follow-up, explicit smoke and issue-less task scopes. It observed preserved original requirements, reporting on issue implementation prompts, omitted implementation/policy text for known smoke intents, no reporting policy on issue-less tasks, and no issue data in the system prompt. These are prompt-generation checks, not evidence that a live model followed the policy; no permanent wording/snapshot test was added.

The attempted live model check stopped **before sending any prompt** because the native OMP default for the verification checkout resolved to **`kimi-code/k3`**, which the user had excluded. It created one verification-only native session, **`92d09c27-0234-40e5-a7c0-4eab64ced057`**, without an issue association or worktree. That exact owned session was located by its unique label, positively observed idle with zero pending permissions, passed through native cancellation confirmation and archived at **`2026-10-25T17:11:24.620Z`**; archival and zero permissions were verified. No second live session or model override was attempted. Live model compliance and actual MCP comment posting remain **unverified**; no tool-call acceptance or provider pass is claimed for this attempt.

Reloaded the installed plugin only after verifying zero active work and a complete empty upstream queue. The live SDK check returned connected, claiming enabled, paused false and zero active executions. Saved settings/revision and credential-presence flags were unchanged. Historical run 1 retained its review timestamp/fingerprint and unknown delivery; existing run 4 retained upstream success and its earlier `PASEO_IAP_SMOKE_OK` acceptance. No new It's a Plan request, comment or status transition was made by this verification.

## Explicit tool-use default — 2026-10-25 UTC

Replaced the conservative “use tools only when the task needs and permits them” wording with explicit default tool use for delegated inspection, implementation and verification. Tickets need not explicitly request tools. Shared guidance appears in native system instructions and new non-smoke task prompts so new turns on reused execution sessions receive it. Removed the generic-runner sentence that could be read as discouraging tool use. Explicit restrictions, ordinary permission approvals, no automatic destructive actions and the canonical no-tools smoke task remain intact.

Both TypeScript configurations and the complete suite passed: **347 tests / 1023 assertions / 14 files**. A finite compiled prompt smoke observed the positive default in system and issue/comment/task prompts, preserved upstream operator text and an explicit no-tools request, and confirmed the canonical smoke body was unchanged and did not receive the positive per-task default. These checks validate generated instructions, not live model compliance; no agent execution or new verification session was attempted.

The installed plugin was reloaded only after a complete empty queue and zero active executions were observed. A fresh pre-reload settings snapshot matched the post-reload revision/normalized values, pause state and credential-presence flags. The plugin reconnected with claiming enabled, paused false and zero active executions; the complete final upstream queue had zero queued/running runs. No provider/model configuration, credential, issue comment or issue-status setting was changed.

## Execution-focused navigation — 2026-10-25 UTC

Reviewed Paseo's native settings/navigation/provider screens at revision [`d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed`](https://github.com/getpaseo/paseo/tree/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed). The plugin uses only public 0.13.0 UI/extension APIs and original lightweight row/back-link compositions; no app-private components, router or copied Paseo implementation. The native issue browser/search command was removed in favor of the configured website. The earlier `/surface/issues` entry URL now opens execution activity, with one canonical screen and no redirect/alias; the sidebar uses its existing `main` contribution ID. This does not claim a tested user-preference migration.

Exercised the actual installed Paseo web assets and reloaded plugin against its owning daemon through a temporary loopback-only WebSocket relay. The relay supplied the private local credential server-side and restricted browser RPCs to read-only methods; it did not mock UI or API responses. No execution key or local credential was injected into browser code. Inspected screenshots at desktop **1440×1000, light** and compact **390×844, dark**; the compact document width remained 390px without horizontal overflow.

- The landing screen contained connection/delegation status, active count and short navigation rows, not issue search, historical session cards or technical controls.
- History opened an individual run/attempt page. Reload preserved that page's URL and actual result/delivery/acceptance; browser Back returned to history. Existing entry links also opened the new activity content after the final reload, with no observed page exceptions.
- Runtime controls were separate from the landing page. Compact diagnostics opened a native adaptive bottom sheet with structurally redacted, selectable content. No pause, stop, cancellation, review acknowledgment, milestone or clipboard write was invoked.
- Settings opened as a category index. A local concurrent-executions draft changed **2 → 3**, survived category/back navigation and re-entry, and disabled the Executions shortcut. **Discard** restored **2** and re-enabled navigation. No configuration save occurred.
- Setup checks and advanced options were nested. Test setup accepted a configured-origin issue URL and enabled Review test; a foreign-origin URL produced a validation error with Review test disabled. No preview, request or handoff was created.
- The real web shortcut opened the configured It's a Plan website and reached its login page in the isolated browser. No credentials were entered; the popup was closed. Request delivery history and a selected request's reconciliation/recovery controls remained accessible in a compact detail sheet, without invoking those actions.

Both TypeScript configurations and **353 tests / 1049 assertions / 15 files** passed after the final client changes. Six new issue-reference tests cover copied comment links, canonical/safe numeric IDs, origin/scheme/port isolation, installation-prefix boundaries, credential-bearing/encoded/non-issue paths and malformed/oversized input. No permanent UI wording, navigation-wiring or snapshot tests were added.

This was UI/navigation verification, not a new model execution or provider acceptance run. Native iOS/Android apps were not exercised.

Final installed-build check opened History, then clicked the native It's a Plan sidebar item and returned to the canonical activity URL with no observed page exceptions. The final read-only SDK health check found the plugin connected, claiming enabled, paused false, zero active/reserved executions and no pending configuration. Saved revision/normalized values and credential-presence flags were unchanged. Existing run 4 retained its earlier successful smoke acceptance and zero observed tool calls; historical run 1 retained its uncertain phase, unknown delivery and prior review acknowledgment. The issue column and existing request journal were unchanged; no new task, session, preview, comment or status transition was created by this UI verification.

Closed the owned verification browsers and observed both owned process IDs absent, stopped the temporary relay, and removed its script, browser profile and screenshot files. The user's Paseo daemon and plugin remain running.

A subsequent copy-only review correction replaced the first-run assignment prompt with “No executions recorded yet,” avoiding a suggestion to delegate again when a delivery request can already exist. Both TypeScript configurations passed; a guarded reload again observed unchanged settings/credential presence, connected and resumed claiming, zero active executions and a complete empty upstream queue. No new UI fixture, native model execution or wording test was added for this text-only change.

## Opt-in workflow integrations — 2026-10-25 UTC

Rechecked It's a Plan at [`ad87c568d1a872f830a526bd9ace774eafd57217`](https://github.com/croffasia/itsaplan/tree/ad87c568d1a872f830a526bd9ace774eafd57217), including runner 0.7.0, structured tasks, AG-UI events, fields, resources, comments, scheduled requests and development integrations. Paseo source review used [`d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed`](https://github.com/getpaseo/paseo/tree/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed); installed SDK/client/protocol 0.13.0 declarations and both TypeScript configurations remain the compatibility evidence. Runner adaptations retain their original Apache-2.0 notices and revision attribution. No It's a Plan application source was copied.

### Automated behavioral checks

- Both TypeScript configurations and the full suite passed: **573 tests, 0 failures, 1866 assertions, 24 files**.
- Context tests cover bounded checklists, direct relations/subtasks, public linked Docs, text/PDF extraction, supported images, denied/private/archived content, deadlines and explicit partial/unavailable warnings. Asset-cache tests cover private permissions, atomic publication, hash/size/MIME checks, symlinks, reload and missing/changed captured bytes.
- Routing tests cover exact project/issue-type/field/option scope, stale/conflicting bindings, provider-compatible precedence and unavailable models/providers. SDK-boundary tests cover explicit native workspace creation, canonical branch naming and preserved legacy associations.
- Lifecycle tests cover normalized tool events, off/metadata/full privacy, known-credential redaction, reconnect cursors, later-human-turn ownership, cancellation, lease loss and post-refresh configuration/credential admission.
- Continuation tests cover original requirements/context, restricted and unknown tasks, actor/run/attempt identity, expiry, source/native drift, retries and immutable source scope. Four focused regressions first failed against the old digest: changed activity privacy, timeout, lease safety, and recorded limits/worktree association could retain an old approval. All four pass with the policy/source fingerprint fix.
- Report tests cover exact approval, permission/restriction checks, actor/body/comment ownership, durable write fencing, lost acknowledgments, incomplete authoritative feeds, explicit reconciliation and approved updates. Public-contract tests keep raw tasks, context assets, continuation grants and private delivery payloads out of routine status/request projections.

### HTTP/engine smoke

Ran the production `Client`, `Engine` and `PrivateStorage` against a real loopback HTTP fixture, a disposable Git checkout and mocked native gateway interfaces. No live coding provider or real execution queue was used.

Observed **seven claim calls, four completed turns and three mock native sessions**. An issue selected Codex through its configured field binding; an issue-less scheduled request selected OMP and received `It's a Plan schedule run 2`. Checklist, linked document, extracted PDF text and an image reached the native input path. Seven heartbeats were observed while work was active; the fixture used a 25 ms interval, not a live 60-second lease soak. Metadata activity withheld tool arguments and known credentials.

The explicitly approved continuation reused its source session; a subsequent ordinary assignment on the same issue created a fresh session. An accepted comment write with a lost acknowledgment remained unknown, reconciled through the complete authoritative feed, and then updated the same comment: **one create and one update**, not a duplicate create. Reopening private storage rehydrated the exact verified image without base64 in the JSON journal. Run results omitted the provider-specific upstream `sessionId` field.

### Native UI checks and visual limits

Used the actual installed Paseo web assets and final installed plugin client bundle with an isolated loopback-only fake daemon. Plugin RPC responses were static fixtures validated against the current contracts; the fixture did not forward to the live host or It's a Plan.

- The landing screen retained connection/delegation status and short activity navigation, without an issue browser or large historical cards.
- Advanced execution behavior exposed native privacy choices and reviewed-continuation opt-in. Closing a changed privacy editor without Apply restored its previous value.
- Selected execution context opened in a native detail dialog, distinguishing an absent historical snapshot from current Gitea development links.
- Report posting was disabled before original-task attestation and enabled afterward. Editing and reviewing a new exact preview cleared attestation and disabled posting again. No post was clicked.
- Continuation delivery was disabled before original-scope attestation and enabled afterward. No Prepare/submit action was clicked; closing discarded the untouched fixture preview.
- Inspected desktop **1360×1000** and compact **390×844** rendering. The compact report used Paseo's native bottom sheet, preserved original-requirement line breaks, and the document width remained **390 px** without horizontal overflow.

The final project-editor disclosure change—hide source switches while disabled and reveal field controls through Configure—passed TypeScript checks but **was not visually re-exercised**. No desktop/mobile interaction claim is made for that specific change. No permanent wording, navigation-wiring or snapshot tests were added.

Fixture evidence recorded context/report/continuation previews and one discard, with **no submit/settings-save calls, blocked messages or schema errors**. The owned browser and fixture services were stopped; temporary fixture scripts, assets, browser profiles, source clones, patch, backup and this pass's captured screenshots were removed.

### Live installation and upstream boundary

Automatic claims were paused during final validation without canceling active work. Reloaded the final plugin while paused and idle; saved configuration/revision, credential-presence flags and session associations were unchanged. After isolated checks and cleanup, restored the original **paused false** state. The final read-only health check observed **connected, claiming true, zero active executions, no pending configuration** and an available complete empty upstream queue. One in-flight poll reservation was present; it was not a coding session.

Existing run 4 retained `PASEO_IAP_SMOKE_OK`, successful delivery, passed acceptance and zero observed tools. Historical run 1 retained its uncertain phase, failed upstream result, archived native state, unknown delivery and prior review timestamp. The issue column and six existing human-request records were unchanged. No new live execution, report comment, continuation handoff or status transition was created for this verification.

Created the explicitly requested, unassigned [PIAP-1 upstream follow-up](https://plan.alexgaribay.com/issue/2) for provider-neutral session URLs and Gitea CI/outbound PR API parity. No upstream code, bot permissions or delegation settings were changed. This pass did not perform new live OMP/Pi, Codex, Claude Code, forge webhook/CI or native iOS/Android acceptance tests; earlier live smoke evidence is historical, not proof of the new optional paths.

### Captured-image retention clarification

Follow-up source review confirmed that asset publication deduplicates by SHA-256 and enforces per-snapshot limits, while storage drains in-flight operations on close. Neither layer performs historical asset eviction or enforces a global disk quota. Documented this retention tradeoff explicitly, including interrupted-capture leftovers, unchanged data after opt-out, and the risk of deleting recovery inputs or delivery fences. This follow-up changes documentation only; the last source validation remains both TypeScript configurations and **573 passing tests**. No additional runtime action or live configuration change was made.

## Multiple bots and named Paseo profiles — 2026-10-27

- Final combined source check: both TypeScript configurations passed; the complete server/client suite passed **604 tests, 0 failures, 1982 assertions across 25 files**.
- Added behavior coverage for named-profile authority over shared/manual/field settings, missing/invalid profiles, captured bundles surviving profile or binding edits, thinking/features in explicit-model and provider-default creation, and changed/unverifiable chat or continuation settings.
- Two engines dispatched the same upstream task identity against one native gateway fixture and produced separate bot-scoped idempotency keys and native agent IDs. The default bot's legacy key shape remains unchanged.
- Launched the actual installed **Paseo 0.13.2** daemon with an isolated canonical temporary home, the current plugin source and two named local profile definitions. Through native SDK/plugin RPCs, saved two bot registrations and separate disposable execution keys, discovered both profiles, observed distinct private storage paths, paused one bot without pausing the other, and confirmed unknown-bot and duplicate-key rejection. Confirmed the native client bundle contained the new bot/profile surface.
- The actual native execution page rendered the selected-bot control and both registered bot choices. Browser menu interaction failed with off-viewport bounds; screenshot capture timed out. **Bot switching and the profile editor are not visually/interactively verified.** No screenshot-based UI acceptance is claimed.
- No real upstream assignment, queue consumption, model turn or live native profile-based session creation was performed in this pass. Creation/application behavior is covered by the SDK-boundary tests, not a live provider run. The disposable keys were not upstream credentials.
- Stopped the owned daemon, closed the owned browser and removed the temporary home, scripts and disposable keys. The user's existing Paseo daemon, settings and credentials were not changed.

## Default-enabled project routing — 2026-10-27

Projects without saved overrides now participate automatically when shared automatic delegation and the selected bot are enabled. An explicit project `automatic: false` remains an opt-out. Repository resolution still requires a configured checkout or an unambiguous registered-repository match; unavailable or unresolved metadata never selects a fallback repository.

The final suite includes absent/inherited project execution, explicit opt-outs, unresolved repositories, unsaved-project smoke delivery and continuation, and pinned chat routing. Removed the incidental whole-object default assertion while retaining duplicate-binding rejection; the structural diagnostics fixture now explicitly configures its disabled project. Removed exact-copy assertions rather than pinning new wording.

The implementation owner's loopback HTTP smoke reported successful default-enabled unsaved-project execution, explicit-off rejection and unresolved-repository rejection. This was an isolated native gateway fixture, not a live provider execution. The default-on project editor and chat picker were not visually re-exercised. No live daemon reload, local settings write or upstream task creation was performed for the commit/push checks.

The package dry run reported `paseo-itsaplan@0.0.1` and included all 87 release files. No package archive was created by the dry run.

## External-agent-first setup — 2026-10-28

Both TypeScript configurations passed. The existing server/client suite passed **604 tests, 0 failures, 1982 assertions across 25 files**; no permanent UI-copy or forwarding tests were added.

Ran the actual **Paseo 0.13.2** web UI and current plugin in a private disposable daemon home, bound to loopback with relay/MCP disabled. All configuration writes and disposable execution keys in this check belonged to that isolated host, not the user's running host or It's a Plan.

- Clicked the plugin sidebar entry, then **Manage agents**. It opened the native external-agent settings screen directly, without selecting a bot or navigating through Connection.
- Clicked **Add agent**, named the new connection, attached the discovered **UI Designer** profile, and saved. The new card appeared first; its credential action became available only after registration.
- Kept a second connection on **Use shared execution settings**, saved different disposable keys through each card's own editor, and enabled the additional agent. The editors named their owning connections; saving one changed only that card's key-presence state.
- Confirmed both cross-agent key substitutions were rejected. Reloaded the isolated plugin and observed unchanged saved values/revision, both key-presence flags, the attached profile and the independent unset profile. Both connections had zero sessions/active executions and were not claiming.
- Inspected desktop **1440×1000, light** and compact **390×844, dark** screenshots. The compact document width remained **390 px**. Reopened and closed the compact native credential sheet; its new-key input was empty and password-typed. No browser page exceptions were observed.

This verifies native UI registration, per-agent settings/credential routing and reload persistence using disposable keys. It does **not** verify live authentication for two It's a Plan accounts, queue consumption, provider/model execution, or native iOS/Android applications. No real external agent, assignment, comment, session or issue-status transition was created.

Stopped the owned daemon gracefully, closed the owned browser tab, and removed the temporary home, disposable credentials and screenshots; all owned artifact paths were absent afterward.

Reloaded the installed local plugin only after pausing new claims and verifying no active/reserved work, no pending configuration and a complete empty upstream queue. Saved settings/revision, credential-presence flags, all seven session associations and request history were unchanged. Restored the original runtime pause state. The final live check observed **connected, claiming true, paused false, zero active executions**, a complete empty queue, and the new **Manage agents**, **External agents** and optional-profile controls in the served client bundle. No additional real external-agent connection was registered by this verification.

## Registered Paseo project selector — 2026-10-28

The plugin-only project selector and compact-editor context fix are merged into `main`. The repository-API protocol cutover and companion It's a Plan server change remain in their isolated worktrees; this merge adds no new server requirement.

The combined main source passed both TypeScript configurations and **604 tests, 0 failures, 1982 assertions across 25 files**.

Before merge, the actual Paseo 0.13.2 UI was exercised on an isolated loopback daemon with two registered Git projects and one non-Git project, all without workspaces. The dropdown listed all three. Git selection populated the repository override, Apply/Save survived browser reload, non-Git selection blocked Apply, and automatic matching cleared the checkout/workspace override in the draft. Desktop and 390×844 compact screenshots were inspected; compact Configure was reproduced failing before the selected-bot context fix and working afterward.

No live plugin reload, installation command, task claim or production settings/credential write was performed for this merge. Existing external-agent setup edits were preserved outside the selector commits.

## Local activation and publication

Activated the updated plugin through its existing directory registration with `paseo plugin reload itsaplan`; no duplicate installation was created. Paused both agents and verified no active/reserved work or pending configuration before reloading. Saved settings, credential bytes and presence flags, session associations and request history were unchanged, including all 18 existing Dev bot sessions.

Restored both agents' original unpaused states. Non-claiming authentication checks succeeded for **Dev bot** and **UI Bot**; both reported connected and accepting delegated work. The served client bundle contained the new project-selector controls. No dependency-ordering or companion server changes were installed.

Final publication checks passed both TypeScript configurations and **604 tests, 0 failures, 1982 assertions across 25 files**.

## Plugin-scoped automatic delegation lifecycle — 2026-10-28

Implemented on isolated branch `feat/automatic-delegation-lifecycle`, not the live plugin checkout. The policy affects only eligible It's a Plan delegated implementations; ordinary Paseo sessions, other plugins, manual issue starts, chats, smoke/restricted tasks and scheduled runs are not enrolled. No upstream server change or dependency scheduler was added.

- Both TypeScript configurations passed. The final complete suite passed **673 tests, 0 failures, 2326 assertions across 28 files**.
- Real Git regressions cover task/integration checks, retained task commits, local-main synchronization, concurrency, conflicts, dirty state, hooks, publication failure/recovery, remote/configuration changes, whitespace-significant local destinations, target-only publication and already-published recovery after another task advances main. Swift package validation runs the installed toolchain; no live Xcode app build is claimed.
- Protocol coverage verifies project-column discovery through the existing board route, scoped column receipts, external-agent identity, complete owned-comment reconciliation, ambiguous/mutated markers and creation fences.
- Engine scenarios verify In Progress before prompt dispatch, completed-outcome admission, failed checks and partial outcomes preserving work, changed-delegate rejection, denied Done updates, review/restricted-task exclusion, interrupted finalization across attempts, pinned remotes and lost Done acknowledgments.

### Actual native workspace / HTTP / Git smoke

Launched Paseo **0.13.2** in a disposable loopback-only home with relay/MCP disabled and no upstream credentials. Ran the real Engine and authenticated HTTP Client against an isolated stateful API fixture, creating real workspaces through Paseo's native API and real commits/pushes against private bare repositories:

| Scenario | Observed issue transitions | Upstream result | Durable lifecycle | Publication |
| --- | --- | --- | --- | --- |
| Successful implementation | In Progress → Done | success | completed | Task and integration checks passed; remote and local main matched the integrated commit |
| Failing verification command | In Progress only | failed | blocked | Remote main unchanged; task work preserved |
| Done applied but HTTP acknowledgment lost | In Progress → Done, one update each | success | completed | Existing Done reconciled without another write |

Each successful scenario recorded two commit-bound verification receipts. Coding turns were **scripted fixtures**, not real model-provider runs; native workspace creation, HTTP behavior, check commands, Git integration and publication were real. No production issue, remote or coding session was modified.

### UI and deployment limits

The actual plugin UI rendered Automatic mode with main/origin defaults and accepted a JSON argv check into its draft on the isolated host. Browser reload/save persistence was not established; project overrides and selected-execution receipt presentation were not interactively verified. No full visual/mobile acceptance or live provider/forge run is claimed.

At the end of isolated verification, the feature had not been merged or installed. That pass changed no live settings, credentials, bot registration or global Paseo defaults; the later user-requested activation is recorded below.

The `0.0.1` package dry run passed with **94 files**, including the new workflow modules. Closed the owned browser, stopped the isolated daemon gracefully, removed its entire temporary home/repositories and deleted the throwaway smoke program. Removal of the temporary home was confirmed. No package archive was created by the dry run.

### Main merge and live plugin activation

On the user's request, committed the verified feature as `fbad7ae` and fast-forwarded local `main`. The existing directory installation points at `/Users/alex/Development/paseo-itsaplan`, so reloaded only `itsaplan` rather than installing a duplicate or restarting Paseo.

Paused both bots' new claims and confirmed **zero active executions, zero reservations and no pending configuration** before reload. After reload, the served native client bundle contained the automatic lifecycle controls, both external-agent authentication checks succeeded, and session/request associations were unchanged: **Dev bot 21 sessions / 6 requests; UI Bot 1 session / 0 requests**. Saved settings and credential-file hashes matched byte-for-byte.

Restored both bots' original unpaused states. Final native RPC checks observed **connected, claiming true, paused false, zero active executions and no pending configuration** for each bot; each had one ordinary in-flight poll reservation. No live task was submitted as a test. No global Paseo agent defaults, other plugins or provider configuration were changed. This activation did not repeat the earlier 673-test suite or isolated lifecycle smoke; the fast-forward installed that exact verified implementation.
