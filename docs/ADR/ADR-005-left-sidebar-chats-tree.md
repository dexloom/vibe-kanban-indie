# ADR-005: Left sidebar — Projects outlined group + collapsible "chats" tree

- **Status**: **Amended** (2026-08-03) — see "Amendment" below
- **Date**: 2026-08-03
- **Amends**: ADR-003 (Workspaces/Chat nav split). The ADR-003 domain module
  (`workspaceStatus`), the `/workspaces` aggregate dashboard, the `/chat` smart
  redirect, and the destination/predicate model remain canonical. This ADR
  changes only the *host* of those surfaces (40px rail → tree in a 256px
  sidebar) and the *labels/badges* presentation.

## Amendment (2026-08-03)

The original Decision (a 256px sidebar hosting a workspace **chats tree** in the
global chrome) was **rejected by the owner as "complete mess, no tree view"** and is
superseded. The corrected composition:

1. **Projects** outlined group at the top — unchanged (owner: "current look is great,
   keep as-is").
2. **One wide "Workspaces" button** → `/workspaces` (the aggregate dashboard).
   Highlighted via `isWorkspacesDashboardDestination || isWorkspaceChatDestination`.
   Renamed from the lowercase "chats" label.
3. **Removed**: the Tasks button and the separate Chat button (and the chats
   smart-redirect affordance from the chrome). `/chat` + `ChatLanding` +
   `goToChat()` are retained (ADR-003) as a deep-link / command-bar target only.
4. **Bottom horizontal group**: Notifications + Organizations side-by-side
   (plus version). An `OrganizationSwitcherButton` was built (the user popover had
   no real org switcher — only a static label).

**The workspace tree is EJECTED from the global sidebar** — it becomes the
**local left panel of the Workspaces view** (the Outliner). See **ADR-006**.

The previously-announced removal of `isLeftSidebarVisible` is **retracted**: that
field gates the view-local 300px panel inside the Workspaces view, which now hosts
the Outliner. It stays live.

## Original Context

ADR-003 split the old single "Chat" rail button into a Workspaces-dashboard
button and a Chat smart-redirect button, both living in the narrow 40px icon
rail (`AppBar.tsx`). Two follow-on problems remained:

1. The rail is icon-only; workspace identity (name, recency, diff size, status)
   is invisible until the user opens the dashboard or the content-area sidebar.
   The bucket tree that would surface this — Needs attention / Running / Idle —
   already exists twice (`WorkspacesSidebar`'s accordion, `WorkspacesDashboard`'s
   sections) but never in the always-visible chrome.
2. The Projects group is undifferentiated visually; users have repeatedly
   requested it be a prominent, outlined block at the top.

The rail width (40px) cannot host a tree, and a hover-flyout tree
(`useWorkspaceSidebarPreviewController`) is undiscoverable.

## Decision

Replace the 40px icon rail with a **256px sidebar** composed of stacked regions:

1. **Projects** — an *outlined, visibly boxed* group at the top. Keeps
   `@hello-pangea/dnd` reorder; renders `initials + name` rows + a Create action.
2. **chats** (lowercase label) — a 2-level **collapsible tree**. Top level = the
   status buckets from `categorizeWorkspacesForDashboard` — **Needs attention /
   Running / Idle** — plus an **Archived** bucket fed from
   `useWorkspaceContext().archivedWorkspaces`, which is **collapsed by default**.
   Leaves = workspaces rendered by the existing `WorkspaceSummary` primitive
   (`name · relative time · files / +added / −removed`). Leaf click →
   `appNavigation.goToWorkspace(id)`.
3. **Tasks** — single icon-button row (unchanged behaviour).
4. Bottom — notification bell + user/org popover + version (unchanged).

Bucket categorization comes from the single source `categorizeWorkspacesForDashboard`
(the inline filter block in `WorkspacesSidebar` is consolidated onto it — it does
not sort today, causing divergence from the `/workspaces` dashboard).

Bucket default expansion: Needs attention + Running + Idle **expanded**,
**Archived collapsed**. Empty buckets hide their header; if all buckets are empty
show a single "No workspaces" line.

Tree implementation: **hand-rolled on existing primitives** —
`CollapsibleSectionHeader` (buckets, already collapse-persisted to localStorage
`vibe.ui.collapsible.<persistKey>`) + `WorkspaceSummary` (leaves). New persist
keys are passed as the `persistKey` string to `CollapsibleSectionHeader`
(`chats-sidebar-needs-attention`, `chats-sidebar-running`, `chats-sidebar-idle`,
`chats-sidebar-archived`) — NOT added to the zustand `PERSIST_KEYS` registry
(that is the `usePersistedExpanded` store, a disjoint system). `CollapsibleSectionHeader`
also gains `aria-expanded`/`aria-controls` and drops its double-init `useEffect`
race (stable `persistKey`/`defaultExpanded` identities required of callers).
`@tanstack/react-virtual` (already a dependency) is wired in only for bucket
lists exceeding ~40 leaves.

Width: desktop grid becomes `[256px_1fr]` (single row; the Navbar row and the
sidebar's top Tauri drag-region strip compose within the grid). The old corner
spacer div is removed.

Navigation affordances retained from ADR-003:
- The "chats" header label click → `goToChat()` (the `/chat` smart-redirect stays
  as the "jump to most relevant workspace" accelerator).
- A `LayoutIcon` in the chats header → `/workspaces` (the aggregate dashboard
  remains the full-page home).
- Leaf active state = `isWorkspaceChatDestination(currentDestination) &&
  workspaceId === leaf.id` (ADR-003 predicate; covers the transient `{kind:'chat'}`
  state before the smart redirect lands).

Presentation changes:
- **Badges move into bucket headers** ("Needs attention · 2", "Running · 1").
  The floating pill UI on the Workspaces/Chat buttons is removed.
- The content-area preview flyout (`useWorkspaceSidebarPreviewController`,
  `WorkspacesSidebarReopenTag`, and the absolute `WorkspacesSidebarContainer`
  panel mounted in `SharedAppLayout`) is removed — the tree is now always
  visible. **`WorkspacesSidebarContainer` itself is NOT deleted**: the dashboard
  (`WorkspacesLayout`) still mounts it. Only `SharedAppLayout`'s flyout mounting
  goes away, along with the now-orphaned `isLeftSidebarVisible` store field.
- `AppBar.tsx` is deleted, but **`AppBarHostStatus`/`AppBarHost` types are
  extracted first** to a neutral module (`WorkspacesSidebar.tsx` imports
  `AppBarHostStatus` today) so the deletion compiles.
- `MobileDrawer` (280px panel) children are rebuilt on the same
  `ProjectsGroup` + `ChatsSidebarTree` components.
- i18n-ization: the section labels ("Projects", "chats", "Tasks", "Remote") are
  currently HARD-CODED literals in `AppBar.tsx`; this ADR introduces
  `appBar.projects`, `appBar.chats`, `appBar.tasks`, `appBar.remote` in all 7
  locales and removes the dead `appBar.chat`/`appBar.workspaces` keys. "chats" is
  the lowercase label choice; each locale's translation value wins (do not force
  lowercase in non-English).

a11y: `role="tree"` / `treeitem` / `group`, roving `tabIndex`, ↑↓ traverse
leaves, ←/→ collapse/expand buckets, `aria-expanded`/`aria-controls` added to
`CollapsibleSectionHeader`, `aria-current="page"` on the active leaf.

## Dev loop (no backend rebuilds)

The backend serves the UI from disk when `VK_FRONTEND_DIR` is set (see
`crates/server/src/routes/frontend.rs`). Dev flow: build the frontend once
(`pnpm --filter @vibe/local-web run build`), start the server with
`VK_FRONTEND_DIR=$PWD/packages/local-web/dist`, then iterate frontend-only with
vite builds — no `cargo build`.

## Consequences

- Positive: workspace identity (name, recency, diff, status) is visible in the
  always-on chrome; the Projects outline satisfies the repeated request; ~250
  lines of flyout/preview plumbing are deleted; no new dependency; the existing
  bucket/leaf primitives get more use; the dashboard keeps a home at
  `/workspaces`; archived workspaces are reachable (collapsed) without a
  separate view.
- Negative: the 40px rail's minimal footprint is lost (a future "collapse to
  rail" toggle is deferred); at <1280px width 256px is a real tax (make the
  sidebar resizable/collapsible later); `react-arborist` would be needed if deep
  nesting (e.g. sessions under workspaces) is later wanted — flagged.
- Ongoing: two collapsible-state mechanisms coexist (in-memory
  `useUiPreferencesStore.expanded` vs `CollapsibleSectionHeader` localStorage);
  this ADR picks the latter and leaves consolidation as a separate cleanup.
