# ADR-006: Workspaces view — local Outliner (tree-view) left panel

- **Status**: Accepted
- **Date**: 2026-08-03
- **Relates to**: ADR-003 (domain module canonical), ADR-005 (global sidebar, amended)

## Context

ADR-005's attempt to host the workspace tree in the global sidebar was rejected by
the owner ("complete mess, no tree view"). The tree semantically belongs INSIDE the
Workspaces view, where it has always had a host (`WorkspacesSidebar` /
`WorkspacesSidebarContainer`, a 300px left panel in `WorkspacesLayout`). The owner
wants a Maya / Borland-Delphi-style **outliner**: a two-level collapsible tree whose
branches are the status buckets and whose leaves are workspace rows
(`name · relative time · files / +added −removed`), with persisted collapse state
and keyboard navigation.

## Decision

- **`WorkspaceOutliner`** (packages/ui) — relocated from ADR-005's
  `ChatsSidebarTree` (the component was correct; only its host was wrong). Two-level
  tree: bucket headers via `CollapsibleSectionHeader`, leaves via the shared
  `WorkspaceSummary` primitive (each leaf wrapped in a focus-owning
  `<div role="treeitem" tabIndex>` so the shared leaf is untouched).
- **Mounts**: the Outliner is the local left panel of the Workspaces view — both
  `WorkspacesLayout` (`/workspaces/$workspaceId`, desktop AND mobile mounts) and
  `WorkspacesDashboard` (`/workspaces`), gated by the existing
  `isLeftSidebarVisible` (300px). The old fat `WorkspacesSidebar` /
  `WorkspacesSidebarContainer` (search/filter/sort/pagination/PR-filter chrome) are
  deleted, along with the orphaned `AppBarButton` and `hostStatus` modules.
- **Buckets**: Active / Running / Idle / Archived, order top→bottom
  (urgency-descending). Semantics: Active = `needsAttention` (things demanding the
  user), Running = `isRunning && !needsAttention`, Idle = the rest of the active
  list (renamed from the misnomer `recentlyActive`), Archived =
  `archivedWorkspaces`. Defaults: Active/Running/Idle expanded, **Archived
  collapsed**. Empty buckets hide their headers; all-empty shows a single
  "No workspaces" line.
- **Domain**: `categorizeWorkspacesForOutliner(active, archived)` added to
  `packages/ui/src/lib/workspaceStatus.ts`, returning `{ attention, running, idle,
  archived }` (field `attention`, NOT `active` — `active` means "non-archived"
  elsewhere in the app). `CategorizedWorkspaces.recentlyActive` renamed to `idle`
  (mechanical, compile-checked).
- **Keyboard**: roving `tabIndex` — `↑/↓` traverse visible treeitems (bucket headers
  + leaves), `←/→` collapse/expand buckets, `Enter`/`Space` select leaf / toggle
  bucket, `Home`/`End` jump. A pure `computeOutlinerKeymap` function is unit-tested;
  `useOutlinerKeyboard` is a thin wrapper. `CollapsibleSectionHeader` gained
  `forwardRef` + `tabIndex` + `role` + a controlled `expanded`/`onToggle` mode (the
  outliner is the single source of expand state so the keymap stays in sync with the
  DOM); its children wrapper is `role="group"`.
- **Tree library**: none — the tree is exactly two levels; a maintained tree
  library is overkill. `@tanstack/react-virtual` (already a dependency) is deferred
  until a bucket exceeds ~40 leaves.

## Consequences

- Positive: the owner's vision is implemented in the correct host; the global
  sidebar (ADR-005 amended) stays clean; ~600 lines of `WorkspacesSidebar` /
  `WorkspacesSidebarContainer` / `AppBarButton` / `hostStatus` are deleted; the
  domain module stays pure and unit-tested; ADR-003's domain/dashboard/smart-redirect
  remain canonical.
- Negative: the per-workspace left panel loses its inline search/filter/sort chrome
  (that moves to the dashboard or command-bar); the 4-bucket layout is a name-remap
  of the existing 3-bucket logic — a true "Active = recently touched, Idle = dormant"
  split is deferred (would need a recency threshold).
- Ongoing: total left-edge chrome at rest = 256px (global) + 300px (outliner) =
  556px on desktop — fine at ≥1280px; the `isLeftSidebarVisible` collapse toggle is
  the relief valve at narrower widths.
