# Third-party source and licensing

## It's a Plan runner

Upstream repository: https://github.com/croffasia/itsaplan  
Verified revision: [`02235dd57a6cecffa62e0d6c054cb7b7df72e153`](https://github.com/croffasia/itsaplan/tree/02235dd57a6cecffa62e0d6c054cb7b7df72e153)  
Runner package version: **0.7.0**; application version: **1.8.0**.  
Runner license: **Apache-2.0**, copyright **2026 Andrii Poluosmak**.

The full upstream runner license, including its copyright boilerplate, is preserved in [LICENSE](LICENSE). Modified adaptation files also carry copyright/license/change headers. No upstream `NOTICE` was present in the reviewed checkout; [NOTICE](NOTICE) supplies this distribution's attribution and modification notice.

| Plugin file | Upstream sources at the verified revision | Changes |
| --- | --- | --- |
| `server/protocol.ts` | [`packages/runner/src/client.ts`](https://github.com/croffasia/itsaplan/blob/02235dd57a6cecffa62e0d6c054cb7b7df72e153/packages/runner/src/client.ts) | Retains external run/chat endpoints, `x-api-key`, 30-second requests / 35-second long claims, attempt fields, events and success/failed semantics. Adds Zod response validation, caller cancellation, no redirects, sanitized errors and narrowly scoped project/issue REST operations verified against the server. No response bodies are exposed in errors. |
| `server/engine.ts` | [`cli.ts`](https://github.com/croffasia/itsaplan/blob/02235dd57a6cecffa62e0d6c054cb7b7df72e153/packages/runner/src/cli.ts), [`tasks.ts`](https://github.com/croffasia/itsaplan/blob/02235dd57a6cecffa62e0d6c054cb7b7df72e153/packages/runner/src/tasks.ts), [`chat.ts`](https://github.com/croffasia/itsaplan/blob/02235dd57a6cecffa62e0d6c054cb7b7df72e153/packages/runner/src/chat.ts) | Adapts the polling, shared concurrency, lease heartbeat and chat/session behavior, not the CLI process architecture. Replaces subprocess/provider-specific execution with Paseo SDK calls; adds capacity reservations, a local lease-safety deadline, cancellation fencing, durable result/event delivery, attempt-aware idempotency, thread bindings, atomic outcome transfer and managed shutdown. |
| `shared/models.ts` | Types in [`client.ts`](https://github.com/croffasia/itsaplan/blob/02235dd57a6cecffa62e0d6c054cb7b7df72e153/packages/runner/src/client.ts) and text/run events in [`agui.ts`](https://github.com/croffasia/itsaplan/blob/02235dd57a6cecffa62e0d6c054cb7b7df72e153/packages/runner/src/agui.ts) | Converts the protocol data contracts into validated schemas, retains wire names/statuses, accepts the chat `attempts` field actually returned by the server, and adds original local journal/configuration metadata. Streams textual events rather than exposing arbitrary provider tool payloads. |

These are modified adaptations, not unmodified vendored copies. No runner binary or package process is required. `run.ts`, `config.ts`, `listen.ts` and runner `package.json` were inspected for current behavior, not copied as product implementation. Shell/provider launchers, local runner session storage, Hermes integration, invocation listener and AG-UI SSE serving are intentionally not imported. Paseo already owns execution/session state; polling runs inside its managed backend.

**License scope:** the repository root application is **AGPL-3.0** at this revision. Only the separately Apache-licensed `packages/runner` source is adapted. Server route/schema code was inspected to verify behavior but was not copied into the plugin. The temporary live acceptance instance was an upstream checkout, not redistributed application code.

Repository matching separately reviewed the Git connections API and permission guards at [`599af2bbb5364e55f551dbea7c1736b7c3749eae`](https://github.com/croffasia/itsaplan/tree/599af2bbb5364e55f551dbea7c1736b7c3749eae). The original Apache runner adaptation base above is unchanged. `server/protocol.ts` now reads the project-filtered connections endpoint and strips non-repository fields; `server/engine.ts` persists and reuses resolved source mappings. The new matching/resolution modules are original code implementing the inspected API contracts, not copied AGPL application code.

The experience/reliability pass additionally inspected runner, queue, identity and human-comment trigger contracts at [`79f7802af892df8a1eaba190a02d2fe182fe6785`](https://github.com/croffasia/itsaplan/tree/79f7802af892df8a1eaba190a02d2fe182fe6785). The adaptation base, Apache copyright and license above remain unchanged. Additional differences: `server/protocol.ts` reads authoritative queue metadata, validates task provenance and supports separately authenticated human comments; `server/engine.ts` captures execution policy, separates pause/stop, maintains valid leases during unconfirmed cancellation, and records acceptance evidence. `shared/models.ts` adds local plan, effective selection, cancellation and evidence metadata without changing runner result statuses.

`server/task.ts`, `server/plan.ts`, `server/experience.ts`, `server/rerun.ts`, `server/diagnostics.ts` and `server/review.ts` are original plugin code implementing the inspected contracts. They do not contain copied AGPL application implementations. No private rerun endpoint, runner listener, provider launcher or external service was introduced.

The follow-up extends the original local journal models with review acknowledgments and pinned request actor/delivery scope. `server/protocol.ts` and `server/engine.ts` now validate original plugin-defined issue-origin smoke markers against durable handoff records before normal external-agent execution. These canonical comments are plugin code, not copied upstream application code or new upstream execution statuses. Existing run-origin comments retain their immutable semantics; HTTP routes, `x-api-key`, execution attempts and `success`/`failed` wire results are unchanged.

## Paseo

Verified at [`72e3316f4f5dfe775c77dbf998968c92e2de9019`](https://github.com/getpaseo/paseo/tree/72e3316f4f5dfe775c77dbf998968c92e2de9019), package version **0.13.0**. The initial manifest/package/TypeScript scaffold was generated with the official `paseo plugin init`. Public plugin/SDK documentation and the Linear plugin example informed extension-point and UI usage; no separate Linear integration or copied Linear API client is included.

Runtime dependencies `@getpaseo/client` and `@getpaseo/protocol` are pinned to 0.13.0. The plugin SDK is a development dependency as in the generated scaffold; Paseo supplies its plugin runtime. Each npm dependency retains its own license. `package-lock.json` records the dependency graph; this file does not relicense third-party packages.

The execution/settings redesign also reviewed Paseo main at [`d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed`](https://github.com/getpaseo/paseo/tree/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed), specifically [`settings-navigation.ts`](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/app/src/navigation/settings-navigation.ts), `components/settings/index.tsx`, `screens/settings/providers-section.tsx` and `screens/settings-screen.tsx`. Their grouped navigation and focused detail patterns informed an original composition of public plugin UI primitives. No Paseo app implementation was copied or imported; the installed public 0.13.0 SDK and existing compatibility range remain authoritative.

## Future updates

Before updating a protocol adaptation, compare the runner **and server** routes at a recorded revision, preserve copyright/license notices, check for a newly added applicable NOTICE, and update this table. Do not broaden the copied source scope to AGPL application files under the runner's Apache license. Before widening Paseo compatibility, verify startup API access, cancellation, native worktree normalization, message acknowledgment ordering, plugin teardown deadlines, settings/RPC contracts and MCP capabilities against the installed SDK.
