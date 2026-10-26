# Changelog

## Unreleased

- Add bounded opt-in checklist, relation/subtask, public linked Doc, supported text/PDF/image attachment and development context. Persist verified images outside the JSON journal; missing or changed captured assets fail closed.
- Add project/issue-type/select-option provider and model bindings, below explicit and saved issue overrides. Stale, conflicting or unavailable selections fail before dispatch; fields cannot select repositories or permission modes.
- Add normalized SDK tool activity with off/metadata/full privacy, known-credential redaction, reconnect deduplication and text cursors.
- Use canonical issue identifiers at the start of new native worktree branches, preserving existing worktrees. Add conditional nonclosing PR-reference guidance and selected-execution development links; no automatic pushes, PR creation, merges or completion transitions.
- Add explicitly attested continuation through durable human/browser requests, with fresh sessions by default, original-scope/native/lease checks and a post-refresh configuration/credential admission fence. Bind privacy, execution safety limits and worktree association; changed policy cannot reuse an old approval.
- Add exact, explicitly approved per-run ticket-report previews and owned-comment updates without MCP. Fence before writes and reconcile complete actor/body/marker evidence after lost acknowledgments; ambiguous delivery never blindly reposts.
- Keep optional context/field controls in project editors, activity/continuation controls in Advanced, and reporting/development in selected execution details. Preserve the minimal activity landing page and web-based issue management.
- Reveal context-source switches only while enabled and field-routing controls through Configure. Read catalogs only for an open editor or existing bindings that require validation.
- Verify existing scheduled external-run consumption and meaningful issue-less native titles without adding a scheduler. Document provider-neutral run-link and Gitea CI/outbound-PR limitations in the upstream follow-up ticket.

- Distinguish the It's a Plan API server URL from the browser-facing web app URL, with separate examples and saved-connection guidance.
- Replace the project selector and “Add mapping” step with named It's a Plan projects and direct per-project repository setup. Preserve existing settings when discovery is unavailable, and clarify first-run/empty-account states.
- Label the required external-agent execution key explicitly, distinguish it from personal/MCP credentials, and show setup guidance before entry. Preserve the actionable non-agent identity error in connection tests and startup status without exposing remote error bodies; display connection-test feedback with the connection controls.
- Align settings with Paseo's native section help, header actions, modal editors, and compact bottom sheets. Remove description-only rows, condense project setup to a named list, and keep advanced configuration and execution history out of the overview.
- Add focused write-only credential editors, explicit apply/save/discard behavior, clearer provider-default labels, and human-readable timing units without changing stored settings or execution contracts.
- Automatically match connected It's a Plan repository links to registered Git checkouts on the owning Paseo host. Preserve explicit overrides, expose ambiguity through a native checkout picker, and retain per-project execution opt-in. Permission failures remain per-project and never select a fallback.
- Discover the owning Paseo endpoint and identity from runtime metadata, use its private local credential by default, and add a non-claiming host connection test. Keep legacy custom endpoints as explicit manual overrides and fence both connection modes against wrong-host reconnections.
- Persist resolved source mappings before native creation so restarts and chat follow-ups cannot silently move to a different checkout. Retain source mappings across recovered result delivery; only reuse earlier-attempt sessions when their source repository matches.
- Preserve blank model overrides through native Paseo creation instead of selecting the first catalog entry. Keep explicit-model validation and public API creation; use the pinned SDK adapter only where public 0.13 creation requires a model string.
- Resolve original run intent from authoritative queue metadata while preserving upstream system instructions and adding a narrow native delivery contract. Assess exact smoke output and observed tool use separately from result delivery; label no-tools as instruction-only.
- Add a unified non-claiming readiness checklist, actionable setup links, per-project readiness and a read-only global queue preview that distinguishes partial/unavailable data from an empty queue.
- Review effective host/repository/worktree/provider/model/mode plans with selection provenance; expose actual session selection and require compatible reuse. Preserve chat continuity under unchanged defaults and reject incompatible changes without replacing the conversation.
- Show actionable execution stages, approvals, heartbeats, cancellation acknowledgment, delivery and acceptance in focused native session dialogs; retain explicit evidence-based milestones.
- Separate persisted pause from acknowledged stop. Capture immutable per-claim settings/limits; apply safe changes to future claims and drain connection changes instead of interrupting active work.
- Add explicitly selected bulk project defaults without automatic opt-in or repository guessing; keep the global, unfiltered claim limitation visible.
- Add reviewed upstream rerun/smoke requests through human mentions, with an optional separate human credential or browser handoff. Persist request nonces before delivery, dismiss untouched previews and reconcile uncertain submissions without reposting.
- Add structurally redacted, copyable diagnostics and visible clipboard failure feedback.
- Deny pending approvals before native cancellation, retain lease maintenance during unconfirmed stop while still valid, and fence new claims until reconciliation. Reject late writes from closed storage owners so retired backends cannot overwrite replacement state.
- Compare historical records with authoritative upstream/native state and explicitly acknowledge review without fabricating delivery, completion or stop confirmation. Require the authenticated external polling agent's numeric ID, not username alone; fail closed when agent metadata is unavailable or inconsistent. Persist and display reviewed observations.
- Preview full-width selectable diagnostics; copy only already-loaded data and preserve manual access after clipboard denial. Render guidance and warnings separately from real action errors.
- Test delegation from an existing issue without a previous run/session. Bind strict issue-origin smoke markers to durable actor/project/issue scope and use the existing upstream queue and acceptance pipeline.
- Recover exact browser handoffs across reloads with the same nonce, reconciliation first and visible do-not-repost guidance; no recovery submit or channel conversion.
- Preserve rows/dialogs during explicit refresh, pin human delivery identity, recheck pause after queue/persistence boundaries, and capture credentials coherently across connection changes.
- Report legitimate initialization status during plugin reload instead of constructing a gateway before settings load. Include native client-state regressions in the standard test command.
- Add a shared implementation-ticket reporting convention to automatic issue dispatch and manual issue starts: preserve requirements, record significant findings/decisions/blockers, disclose unavailable comment delivery, and return evidence-based structured final reports. Preserve no-tools/exact-output tasks; keep issue comments permission-bound and separate from execution results/status transitions.
- Make available-tool use the explicit default in native system instructions and new delegation prompts, including turns on reused sessions. Preserve explicit no-tools/smoke restrictions and normal Paseo permissions without changing provider configuration or replaying active turns.
- Replace the native issue browser and issue-search command with an execution-focused landing screen and an **Open It's a Plan** web shortcut. Existing issue-browser entry URLs open the new activity content; retain the `main` sidebar contribution and a single canonical screen, without a compatibility alias. Keep the empty state neutral rather than prompting another assignment while delivery may be pending.
- Move history, attention items, request delivery and runtime controls into URL-backed focused pages. Open individual executions separately; keep technical details, diagnostics and reporting behind explicit actions.
- Reduce settings to native category navigation with nested setup checks and advanced options. Preserve drafts between categories, disable the executions shortcut while changes need resolution, and show save/discard controls only when relevant.
- Replace smoke-test issue browsing with a pasted issue URL or numeric ID. Validate the configured origin, installation prefix and safe identifier before requesting a reviewed preview.

## 1.0.0

- Native Paseo 0.13 server/client contributions, host settings, typed RPC, issue browser, command center and host-aware session navigation.
- In-process adaptation of It's a Plan runner 0.7.0 claims, run/chat heartbeats, results and text events; shared capacity, fail-closed leases, authentication pause and transient reconnect.
- Multi-project issue resolution by stable IDs, configured checkout/workspace validation, dynamic provider/model/mode selection, native isolated worktrees and deterministic creation keys.
- Durable run-attempt/session/thread associations, atomic recovered-outcome transfer, conservative ambiguous-send handling and result-only retry.
- Initial/follow-up chat resumption and cancellation; manual issue start/attachment; evidence-gated global and per-project milestone policies, without automatic issue completion.
- Write-only credentials in restricted private storage, serialized updates, nonce-safe backend locking, validated URLs, request deadlines and separately credentialed optional MCP.
- Explicit reload/disable policy: cancel claimed run/chat turns, preserve sessions/worktrees and completed outcomes, reconcile pending delivery. Unclaimed manual sessions continue in Paseo; missed outcomes are reconciled from native state without inferring success.
- Automated protocol/runtime/storage tests and local real-server acceptance. See VERIFICATION.md for provider availability and untested surfaces; no claim of live Codex/Claude validation.
