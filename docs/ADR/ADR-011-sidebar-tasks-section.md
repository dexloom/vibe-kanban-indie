# ADR-011: Sidebar — per-project Tasks section

- **Status**: Accepted
- **Date**: 2026-08-03
- **Amends**: ADR-007 (adds a second per-project section above Workspaces).

## Context

ADR-007 placed a per-project Workspaces section in the global sidebar tree and
anticipated future sibling sections. Kanban tasks now need the same placement: a
Tasks section per project, above Workspaces, showing status columns and issue
rows that navigate to the project issue view.

Three constraints shape the design:

1. `packages/ui` cannot import `web-core`. `useShape` lives in web-core, so task
   subscriptions and loader components must remain there.
2. A sidebar with many projects must not subscribe eagerly to every project's
   statuses and issues. Opening a Tasks section must gate its subscriptions.
3. react-arborist 3.16 resolves unknown node state through `openByDefault`, while
   consuming `initialOpenState` only once. Lazy status nodes therefore require
   `openByDefault={false}` to avoid expanding every status after loading.

## Decision

- Add `TasksSectionNode` (`type: 'section'`, `kind: 'tasks'`), `StatusNode`, and
  recursive `CardNode` entries to the sidebar tree model. Section `kind`
  distinguishes Tasks from Workspaces.
- Keep `SidebarProjectTree` data-only. `useProjectTasks(projectId, enabled)` in
  web-core wraps `PROJECT_PROJECT_STATUSES_SHAPE` and `PROJECT_ISSUES_SHAPE`.
  `SidebarProjectTasksRegistry` renders one hook-safe loader per project and
  aggregates results for the UI package.
- Enable a project's loaders when its Tasks section opens; disable them when it
  closes. Tasks sections and status rows default closed.
- Set `openByDefault={false}`. Preserve ADR-007 new-project behaviour with an
  effect that opens only newly added project and Workspaces nodes; Tasks remains
  closed.
- Build task nodes in the pure `buildTreeData` function. Tasks appears above
  Workspaces. Visible statuses sort by `sort_order`; hidden statuses and issues
  without a visible status are omitted. Top-level issues sort by `sort_order`.
  Sub-issues nest recursively under their parent and sort by
  `parent_issue_sort_order`.
- Render cards as compact title rows only: optional priority dot, monospaced
  `simpleId`, and title. Do not render description, tags, or assignees. Parent
  cards show an isolated expansion caret; leaf cards remain plain navigable
  rows.
- Keep persistence schema version 1. `${projectId}:tasks` keys join the existing
  open-state map without invalidating prior project, section, or bucket state.

## Consequences

- Tasks remain visible and navigable alongside workspaces without eager Electric
  subscriptions.
- Nested sub-issues preserve issue hierarchy while collapsed defaults keep the
  256px sidebar compact.
- New-project auto-expansion now depends on a small imperative effect rather than
  react-arborist's implicit default-open fallback.
- Active issue rows expose `aria-current="page"`; expandable rows expose
  `aria-expanded`.

## Amendment (same day, post-implementation)

- Cards render the issue **title only** — `simpleId` and the priority dot were
  dropped after owner review (ids add no value in the tree; navigation uses the
  internal id).
- **Status and card open state IS persisted** (schema v1, unchanged) and restored
  post-mount: `handleToggle` writes status/card ids too, and a replay effect
  (`pendingOpenStatusCardIds`) opens stored-open nodes as they lazily mount after
  the Tasks gate. Persistence survives browser restarts.
- All row types share one `TreeRow` shell (replaces `TreeCaretRow`): tree indent,
  caret-or-spacer column, content slot. No per-type geometry. Childless rows show
  a bullet in the caret column; dotted guide lines were removed.
- Status color dot sits after the status name; text columns are level-uniform
  (sections 34, groups 46, cards/leaves 58 in the 256px sidebar).
