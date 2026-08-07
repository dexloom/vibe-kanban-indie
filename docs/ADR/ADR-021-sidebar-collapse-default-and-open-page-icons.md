# ADR-021: Sidebar collapse-by-default, open-task counts, and open-page icons

- **Status**: Accepted
- **Date**: 2026-08-07
- **Supersedes**: ADR-011 (Tasks-section default-open rule), part of ADR-015 (project row navigates on click), ADR-017 §4 (Tasks section / status row click navigates to the kanban)
- **Relates to**: ADR-007 (sidebar), ADR-015 (root-only Workspaces), ADR-016 (orchestrator prompt rows)

## Context

The sidebar tree defaulted to an expansive posture: every project, its Tasks
section, its Workspaces section, and the attention/running/idle buckets
started OPEN (ADR-011 made Tasks open-by-default; the seed map opened
everything else). For a solo dev with several projects that meant a wall of
expanded rows on every reload, hiding the structure it was meant to reveal.

Three related pain points compounded this:

1. **The Tasks badge counted the wrong thing.** `TasksSectionNode` showed
   `section.children.length` — the number of status columns — not the number
   of tasks. A project with one "Todo" column holding 47 cards showed "1".
2. **Clicking a project/Tasks/status row navigated** to the kanban, so the
   only way to collapse a branch was the tiny caret. Navigation and
   expand/collapse fought for the same gesture.
3. **Empty status columns cluttered the tree.** A status with zero cards
   (e.g. an unused "In Review") still rendered a row.

## Decision

### 1. Collapse-by-default (everything starts collapsed)

`openState.ts` now seeds **every** level CLOSED absent a persisted value:
projects, Tasks sections, Workspaces sections, buckets, and statuses. The
single rule `isTasksSectionOpen(stored, projectId)` was flipped from
"open unless persisted `false`" to "open only when persisted `true`".
`buildSidebarTreeInitialOpenState` and the legacy per-bucket migration base
follow suit. The persisted-state blob format and key scheme are unchanged, so
a user's explicit choices still survive a reload; only the *default* flips.

The mid-session "auto-open new projects" effect in `SidebarProjectTree` was
rewritten to **restore** persisted-OPEN state for late arrivals instead of
force-opening them — a brand-new project stays collapsed.

### 2. Row click toggles; a dedicated icon navigates

`handleActivate` now calls `node.toggle()` for `project`, Tasks-section, and
`status` rows (click AND keyboard). A new **open-page icon**
(`ArrowSquareOutIcon`, aria-label `sidebar.openProjectPage` /
`sidebar.openWorkspacesPage`) renders on:

- project / board rows → opens that board's kanban (`goToProject`),
- Tasks section rows → opens the project's kanban (`goToProject`),
- Workspaces section rows → opens the flat `/workspaces` dashboard
  (`goToWorkspaces`).

The icons `stopPropagation` on click and pointer-down so they navigate
without toggling and without promoting a drag. Card rows, workspace leaves,
and orchestrator-prompt rows keep navigating on activation (clicking a task
opens the task page; clicking a workspace opens the workspace page).

`Sidebar`/`SidebarProjectTree`'s `onSelectProject` prop was replaced by
`onOpenProjectPage` (project/kanban navigation) plus `onOpenWorkspacesPage`.

### 3. Open-task count (cards excluding done)

`TasksSectionNode` now shows `openTaskCount`: the total issue cards under
**non-done** statuses (sub-issues included). "Done" is a name heuristic —
`isDoneStatusName` matches `done|complete|completed|close|closed|resolved|
finished` (case-insensitive, trimmed) — because project statuses are
user-defined with no enum. A done column that still holds cards renders in
the tree but its cards are excluded from the count.

### 4. Hide empty status columns (sidebar tree only)

`buildTreeData` now filters out statuses with zero cards **once task data
has loaded**. While loading (or never loaded) empty statuses are kept to
avoid flicker and to show configured columns before counts arrive. This
applies to the sidebar tree only; the kanban board (`KanbanContainer`)
still renders every non-hidden column.

### 5. Load all projects eagerly for counts

Because counts must render while a Tasks section is collapsed, the
per-project Tasks loader (`SidebarProjectTasksRegistry`) now subscribes
**all** live projects unconditionally. The previous open-state-gated loader
set (`openTasksProjectIds` / `deriveOpenTasksProjectIds` /
`onTasksExpansionChange`) was removed from `SharedAppLayout`. For a
single-dev local app the per-project Electric shapes are cheap enough to
subscribe eagerly.

## Consequences

- **Existing users** keep their persisted expand/collapse choices; only the
  default for never-touched nodes flips to collapsed.
- **Done-name heuristic is English-centric.** A status named "Shipped" still
  counts as open. Documented; acceptable for the current single-user scope.
- **Drag-and-drop** onto hidden empty statuses is impossible *in the tree*,
  but the kanban board retains all columns so no functionality is lost.
- **Late-arrival restore edge case:** if projects stream in one at a time
  after some are already mounted, a not-yet-arrived project's persisted-open
  state can be pruned from the blob by the first project's prune pass before
  it arrives; worst case that project appears collapsed and the user
  re-expands it. The common reload case (projects present at Tree mount, or
  all arriving together) is unaffected.
- **Eager per-project subscriptions** trade a little Electric shape cost for
  always-available counts — the right call for a local single-user app.
