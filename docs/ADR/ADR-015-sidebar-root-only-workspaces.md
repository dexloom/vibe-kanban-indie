# ADR-015: Sidebar — root-only Workspaces section and Main-board navigation

- **Status**: Accepted
- **Date**: 2026-08-05
- **Refines**: ADR-013 §Sidebar tree (line 95)
- **Relates to**: ADR-007 (sidebar tree), ADR-011 (Tasks section)

## Context

ADR-013 shipped hierarchical projects where every project node (root or nested board) renders its own Tasks + Workspaces + child boards. In practice the Workspaces section is only meaningful at the **root**: a single flat overview of "every workspace in this project subtree" is what a solo dev wants, and rendering one Workspaces section per nested board fragments the view without adding signal. Additionally, the sidebar's "open kanban" affordance is split across two redundant gestures — the explicit `ArrowSquareOutIcon` button and a row-click that already navigates via `react-arborist`'s `onActivate` — and there is no in-row affordance to create a child board under the hovered project.

## Decision

1. **One Workspaces section, at the root, at the BOTTOM.** Only root projects (`parent_id === null`) render a Workspaces section; nested boards render Tasks + child boards only. The root's Workspaces section **aggregates** the active and archived workspaces of the entire subtree (root + all descendant boards), deduped by `workspace.id` so a workspace linked to both root and a child appears once. Children order at the root: `[Tasks, ...childBoards, Workspaces]`.
2. **Hide the Workspaces section when the aggregate is empty.** Mirrors the existing gate on the Unassigned pseudo-project (`buildTreeData.ts:73-78`).
3. **Aggregation is frontend-only, in `buildTreeData`.** The workspace partitions and project tree are already on the client; a server aggregation endpoint would invent coupling for fewer than 100 workspaces. The aggregator is a pure tree-walk over `childrenByParent` + a union of `workspacesByProject` entries.
4. **`ArrowSquareOutIcon` removed from every project row.** Row-click already navigates via `onActivate` (`handleActivate` → `onSelectProject`); the explicit button is redundant. Row-click on a `ProjectTreeNode` no longer toggles expand/collapse — the caret does. Matches standard tree UX (VSCode, Finder).
5. **`+` button on every non-Unassigned project row.** Creates a child board with `parent_id` set to the row's project id. Reuses `CreateRemoteProjectDialog` with a new `parentId?: string` prop threaded into the insert payload (which already speaks `CreateProjectRequest.parent_id`).
6. **Unassigned unchanged.** Keeps its own Workspaces section (it is a pseudo-project, not a root in the model).
7. **Tasks section unchanged.** Stays toggle-only; the root project name is the navigation affordance to the Main board.

## Consequences

### Positive

- One unobstructed overview of subtree workspaces; no per-board fragmentation.
- Frees the row's trailing slot for the child-board `+` (no row-width regression).
- Removes a redundant navigation affordance; row-click semantics become unambiguous (navigate) and match platform conventions.
- Zero backend change — `create_project` and `derive_key_chain` already support arbitrary depth.

### Negative / accepted

- Stale persisted open-state keys (`<childId>:workspaces`, `<childId>:bucket:*`) accumulate for nested boards; mitigated by extending the prune effect to check full node ids against the live tree.
- `buildSidebarTreeInitialOpenState` still seeds only top-level projects (pre-existing gap from ADR-013); nested boards' Tasks sections continue to default closed until first expansion. Out of scope here.
- The dialog grows a `parentId` prop — minor surface.

## Risks

- **Aggregation correctness**: a workspace linked to multiple subtree projects must appear exactly once. Mitigated by id-dedupe + tests.
- **Active/archived bucketing**: aggregator must keep active and archived arrays separate so `categorizeWorkspacesForOutliner` buckets correctly. Mitigated by two-pass dedupe + test.
- **Row-click semantics change**: existing test `SidebarProjectTree.test.tsx:241-252` asserts row-click both navigates AND toggles; that test must be rewritten to assert navigation only. Caret handles toggle.
- **Open-state GC**: stale keys must be pruned against full node ids, not just project prefixes; otherwise child-board workspace keys survive forever. The full-id check is scoped to **workspace structural keys only** (`<id>:workspaces`, `<id>:bucket:*`). Status/card keys (`<P>:status:*`, `<P>:card:*`) are exempt because their nodes only appear in the live tree once Tasks data loads — applying the full-id check to them would prune a status the user expanded in a prior session before its data arrives, silently losing expansion state across restarts.
