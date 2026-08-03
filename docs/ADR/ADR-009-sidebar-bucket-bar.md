# ADR-009: Sidebar bucket bar — global status-bucket dropdowns at the top of the sidebar

- **Status**: Accepted
- **Date**: 2026-08-03
- **Relates to**: ADR-007 (project-scoped workspace tree), ADR-008 (sidebar section
  header), ADR-003 (workspaceStatus domain module), ADR-002 (centralized theme),
  ADR-006 (outliner buckets)

## Context

The workspace tree (ADR-007) is project-scoped — a workspace appears under the
project(s) it is linked to, so there is no single place to see a GLOBAL view of
"what needs my attention right now" across all projects. The owner wants a
horizontal button bar at the **very top** of the left sidebar (above the Projects
section header, below the Tauri drag strip) with one button per global active
bucket:

- **Attention / Running / Idle** (Archived excluded — it has its own tree section).
- Each button: a suitable icon in a suitable color + a count badge.
- Click → a **dropdown opening downward** listing that bucket's workspaces,
  **newest-first** (by `latestProcessCompletedAt`, tiebreak `createdAt`).
- Each menu item: workspace name + activity (files / +added / −removed) + how
  long ago.
- Click an item → navigate to that workspace.
- All three buttons always render; empty buckets show a small "No workspaces"
  row (button never disabled).

Owner decisions (final, iterated): buttons show a **small text label under the
icon** (so a first-run user understands them), **no badge on Idle** (it can
hold hundreds — the count is noise), **solid per-bucket colored badges**
(attention `bg-warning text-white`, running `bg-success text-white` —
translucent variants blended into the icon and were dropped; `CountBadge`
sits `-top-2 -right-2`, clearly above-and-right of the icon), **no background
on the bar row** (consistent with ADR-008's no-outline aesthetic). Icons:
**Attention = `WarningIcon`** (triangle, `text-warning` — a new `warning`
token bridged into tailwind from the existing `--warning` CSS var),
**Running = `ClockIcon`** (`text-success`), **Idle = `MoonIcon`** (`text-low`).

## Decision

### Single-source bucket config — `packages/ui/src/lib/buckets.ts`

Pure, framework-free config mapping each bar bucket to its presentation
(`BarBucketId = Exclude<BucketId, 'archived'>`, `BAR_BUCKET_ORDER`, and
`BAR_BUCKETS: Record<BarBucketId, { id, labelKey, icon, iconWeight?, iconClass,
badgeClass }>`). This is the single place a bucket's icon, color, and label key
live — future bucket UIs (tree, dashboard) import it instead of scattering
duplicated maps. Labels stay i18n keys resolved via `t()` at render time.

### `SidebarBucketBar` — `packages/ui/src/components/SidebarBucketBar.tsx`

Props: `{ workspaces: readonly OutlinerWorkspace[]; activeWorkspaceId:
string | null; onSelectWorkspace: (id: string) => void; className? }` — active
workspaces only; Archived is intentionally not accepted (excluded by design).

- Partitions `workspaces` with the **existing** predicates
  (`isWorkspaceNeedsAttention` / `isWorkspaceRunning` / `isWorkspaceIdle` from
  `workspaceStatus.ts`) and sorts each bucket locally with the **existing**
  `compareWorkspaceDashboardRecency` — the shared prop array is never mutated,
  so the project tree below keeps its own ordering.
- Renders `BAR_BUCKET_ORDER.map` of one private `BucketButton` parameterized by
  `meta` + `items` — zero per-bucket duplication.
- Container: `<div role="toolbar" aria-label="Workspace buckets">`, transparent
  (no bg / border), `flex shrink-0 items-center gap-1`. Placed in `Sidebar.tsx`
  between the drag strip and the Projects header, as a **direct child** (the
  data is already in `SidebarProps`; no new props, no `SharedAppLayout` change).

### `BucketButton` (private) + dropdown

- Icon-only trigger (`size-4` icon in `meta.iconClass`, `relative`),
  `aria-label="${label}"` (or `"${label} — ${count}"` when count > 0), `h-8`
  hit target, `hover:bg-accent`, `focus-visible:ring-2`.
- Per-bucket `CountBadge` (hidden at 0, `99+` cap) in `meta.badgeClass`.
- Uses the **existing** `DropdownMenu` primitive (`DropdownMenuTrigger asChild`
  → `DropdownMenuContent side="bottom" align="start" min-w-[260px] max-w-[320px]`).
  Radix gives menu semantics, keyboard nav, Esc, outside-click, and
  one-open-at-a-time for free; it closes the menu after `onSelect` (so
  close-on-navigate is free too).
- Empty bucket → a non-focusable `"No workspaces"` text row under the label.
- Menu item (`WorkspaceBucketMenuItem`, private): two-line — name + elapsed on
  line one (active workspace gets `aria-current="page"` + `font-semibold
  text-high`), activity stats on line two via the shared
  `WorkspaceActivityText`. `onSelect` → `onSelectWorkspace(id)`.

### Shared primitives extracted (DRY, no scattering)

- `WorkspaceActivityText` (`packages/ui/src/components/WorkspaceActivityText.tsx`)
  — the `files / +added / −removed` stats line, extracted from `LeafNode.tsx`.
  Tree leaf + bucket-bar menu item + (future) dashboard share one renderer.
- `CountBadge` (`packages/ui/src/components/CountBadge.tsx`) — color-agnostic
  pill (layout only; color classes passed by the caller, since `cn()` is plain
  `clsx` with no tailwind-merge). Adopted by the notification bell too,
  replacing its inline badge markup (same geometry → no visual change).

### i18n (en only)

- New keys: `workspaces.bucketBarLabel` ("Workspace buckets") and
  `workspaces.bucketEmpty` ("No workspaces").
- Reused: `workspaces.outliner.attention`, `workspaces.running`,
  `workspaces.idle`.

## Consequences

- Positive: a global, always-visible status surface above the project tree;
  one config (`lib/buckets.ts`) is the single source of bucket
  presentation; the bar reuses the domain predicates, recency comparator, and
  dropdown primitive — no duplicated categorization, sorting, or menu logic;
  the `WorkspaceActivityText` / `CountBadge` extractions remove duplicated
  markup from the tree leaf and the notification bell.
- Negative: three more buttons on an already-dense 256px sidebar (icon +
  micro-label; labels truncate at narrow widths but stay in `aria-label`).
- Ongoing: if the dashboard or command bar ever surfaces buckets, they import
  `lib/buckets.ts` + the shared primitives rather than re-deriving them.
