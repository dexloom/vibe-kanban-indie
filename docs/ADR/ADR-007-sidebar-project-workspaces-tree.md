# ADR-007: Global sidebar — project-scoped workspace tree

- **Status**: Accepted
- **Date**: 2026-08-03
- **Amends**: ADR-005 (global sidebar, amended), **supersedes** ADR-006's view-local
  Outliner placement (the outliner moves into the global sidebar as a 3rd level).

## Amendment (2026-08-03): indent 8 → 12

The original decision set `indent` to 8px. In practice 12px reads better for the
3-level tree at 256px (project → section → bucket → leaf); the owner approved
12px after visual review. Code uses `indent={12}`. This amends the "indent
reduced to 8px" line below and the "indent 8 + no box border" mitigation in
Consequences. All other decisions stand.

## Context

The Workspaces outliner (ADR-006) proved the tree UX (react-arborist, Gmail-style
leaves, dotted guides). The owner then wanted the workspace tree to be the primary
nav and project-bound: remove the global "Workspaces" button, and turn the sidebar's
Projects group into a 3-level tree **Project → "Workspaces" section → Active/Running/
Idle/Archived buckets → workspace leaves**. Future sections (TODOs, Notes) slot in
beside "Workspaces" per project.

Data reality (verified): local `workspaces` rows have **no `project_id`** — the only
project linkage is the `issue_workspaces` join (workspace → issue → issue.project_id,
M:N). So "project-bound" is frontend-derived today.

## Decision

- **`SidebarProjectTree`** (react-arborist, same patterns as `WorkspaceOutliner`):
  node types `project → section("Workspaces") → bucket(Active/Running/Idle/Archived)
  → leaf(workspace)`. Project reorder via react-arborist `onMove` with a
  project-only guard (explicit grip handle on the project row). Drop the outlined
  Projects box border; `indent` 12px (amended 2026-08-03; originally 8px).
- **Project membership (Phase 1, frontend-only)**: new
  `useWorkspaceProjectMembership()` hook builds `Map<localWorkspaceId, Set<projectId>>`
  from `useUserContext().workspaces` (remote shapes expose `local_workspace_id` +
  `project_id`). A workspace renders under every project it's linked to (M:N).
  Workspaces with no membership render under an **"Unassigned"** pseudo-project at
  the bottom of the tree. (Owner decision: Unassigned group is the right UX.)
- **Remove the view-local Outliner** (owner decision): `WorkspaceOutlinerContainer`
  mounts in `WorkspacesLayout` are deleted; the per-workspace view becomes a pure
  content pane. Left-edge chrome drops from 556px to 256px.
- **Global "Workspaces" button removed** from `Sidebar.tsx`; `/workspaces` dashboard
  route stays as a cross-project flat list reachable via command-bar / URL (minimal
  keep). `/chat` deep-link retained (ADR-003).
- **Phase 2 (deferred, weeks)**: add `workspaces.project_id` (migration + set at
  create + backfill from the join). Tracked in `docs/TODO/phase2-workspaces-project-id.md`.
  Until then the tree is "issue-link-derived" project grouping, documented as such.

## Consequences

- Positive: workspace nav lives in the global chrome; per-project context visible;
  future per-project sections (TODOs/Notes) have a natural home; one tree, no
  duplication; total chrome footprint shrinks.
- Negative: until Phase 2, project grouping is derived (M:N, Unassigned group);
  a 3-level tree at 256px is dense (mitigated by indent 8 + no box border); the
  per-workspace view loses its local nav; `/workspaces` button entry point gone
  (dashboard reachable only via command-bar/URL).
- Ongoing: keep `WorkspaceOutliner`'s leaf/bucket renderers shared with
  `SidebarProjectTree` (extract shared node primitives rather than duplicating).
