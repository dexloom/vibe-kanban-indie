# ADR-023: The MCP card-tool surface is a pinned contract

- **Status**: Accepted
- **Date**: 2026-08-08

## Context

Every agent that drives the board — `orchestrator`, `intake`, `product`, `coder`,
`planner`, `decider` — reaches it through exactly one door: the `vibe-kanban` MCP
server in **global mode** (`.mcp.json` passes no `--mode`). The plugin's agent
definitions name the tools they may call *by literal string* in their allowlists,
so a tool that disappears from `global_mode_router()` does not degrade the agent —
it removes a capability the agent's own prompt still assumes it has.

`e41e2c16` ("refactor: remove cloud/remote stack (Phase 1)", part of the ADR-004
arc) deleted `crates/mcp/src/task_server/tools/remote_issues.rs` and
`remote_projects.rs` as collateral. The module names said "remote", but the tools
were never remote: they talked to the *local* REST routes in
`crates/server/src/routes/kanban.rs`, which the same commit left untouched. The
follow-up `e36a3d2b` then removed the now-unreferenced status/tag helpers from
`tools/mod.rs` to clear a dead-code lint, cementing the loss.

Nothing failed. `cargo test` was green, `cargo clippy` was green, the server built
and served, and the deletion shipped as `0.2.24-beta.*`. The only symptom was an
orchestrator with no card surface: no `list_issues` to sweep with, no `get_issue`
to read a card, no `update_issue` to reflect status. Anyone on the `beta`
dist-tag had a dead orchestrator, and the regression was one `latest` promotion
away from being everyone's.

The router was assertable all along — `orchestrator_mode_exposes_only_scoped_workflow_tools`
pins the orchestrator-mode set *exactly*. Global mode had only a handful of
`assert!(contains(..))` spot checks, which is precisely the shape of test that
cannot fail when something is **removed**.

## Decision

1. **Reinstate the tools from the deleted source, not from a rewrite.** The files
   are recovered from `e41e2c16^` and renamed to `issues.rs` / `projects.rs`
   (nothing "remote" remains in the fork). Routers are `issues_tools_router` /
   `projects_tools_router`, registered in `global_mode_router()`. The shared
   helpers they need (`expand_tags`, `fetch_project_statuses`,
   `status_id_from_name`, `status_name_from_id`, `default_status_id`,
   `resolve_status_name`) are restored to `tools/mod.rs` alongside their tests.

   Recovery over rewrite is deliberate: the response shapes carry hard-won,
   *invisible* contracts — the thin `list_issues` row (VIBE-23), the minimal
   `update_issue` ack that never echoes the card body (VIBE-2), the
   `Option<Option<Uuid>>` un-nest tri-state (VIBE-16). A clean-room
   reimplementation reproduces the tool names and loses all three.

2. **`global_mode_router()`'s tool-name set is pinned by an exact-set assertion**
   (`global_mode_exposes_the_full_card_surface`), mirroring the orchestrator-mode
   test. Removing a tool now fails `cargo test`. Adding one is a deliberate act:
   the set is extended in the same commit.

3. **`IssueSummary.updated_at` and `IssueDetails.updated_at` are one contract.**
   Both are `DateTime::to_rfc3339()`, and they must stay byte-identical: the
   orchestrator's `cards{}` cache compares a cached stamp against a fresh
   `list_issues` row by exact **string** equality. A one-sided format change
   (truncating sub-seconds, switching to `Z`) does not error — it silently turns
   every cached card into a `get_issue` every tick. Pinned twice: as a unit test
   on the two renderings, and as an HTTP round-trip
   (`create_issue` → `list_issues` → `get_issue` → `update_issue`) that asserts
   the list row, the detail payload, and the update ack all agree, before *and*
   after a write.

4. **Orchestrator mode is left unchanged.** Global mode is what the plugin
   connects with; widening the orchestrator-scoped surface is a separate
   decision, not a side effect of this restoration.

5. **`assignee_user_id` is the one filter not restored.** Its backing field is
   gone from `api_types::SearchIssuesRequest` (ADR-019, user-entity excision), so
   it cannot be honoured. Every other `list_issues` filter is preserved verbatim:
   `project_id`, `status`, `priority`, `parent_issue_id`, `search`, `simple_id`,
   `tag_id`, `tag_name`, `sort_field`, `sort_direction`, `limit`, `offset`.

## Consequences

- Positive: the card surface an agent's allowlist promises is the surface the
  server actually exposes, and a future refactor that drops a router `+` fails at
  `cargo test` instead of at an operator's first tick against a fresh npm
  release. The `updated_at` cache contract is enforced end-to-end rather than
  documented in a comment.
- Negative: two exact-set assertions (global + orchestrator) must be edited
  whenever a tool is legitimately added — intentional friction, and the failure
  message says so.
- Ongoing: an excision ADR that touches `crates/mcp` must state which tools it
  removes and update the pinned set in the same commit. "The module was named
  after the thing being deleted" is not evidence that the module belonged to it —
  see also `shared/remote-types.ts` in ADR-004, retained for the same reason.
