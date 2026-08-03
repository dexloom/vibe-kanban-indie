# PLAN — Sidebar Global Bucket Bar

- **Date:** 2026-08-03
- **Branch:** `feat/ui-modernization`
- **Status:** Ready to implement
- **ADR ref:** ADR-009 (pending — file `docs/ADR/ADR-009-sidebar-bucket-bar.md`, set `Status: Proposed` before code, `Accepted` after merge)
- **Design sources:** variant A (escalate-glm) + variant B (escalate-deepseek), reconciled

---

## 1. Goal

A horizontal 3-button toolbar pinned to the very top of the left sidebar
(between the Tauri drag strip and the Projects section header). Each button is
a global status bucket — **Need attention / Running / Idle** (Archived
excluded) — with an icon, a neutral count badge, and a downward dropdown of
workspaces newest-first. Clicking an item navigates to that workspace.

All three buttons always render. Empty buckets open a small "No workspaces"
dropdown row; the button is never disabled.

---

## 2. Reconciliation decisions

One choice per divergence, with rationale.

| # | Divergence | Decision | Rationale |
|---|---|---|---|
| 1 | Component name: `SidebarBucketBar` vs `WorkspaceBucketBar` | **`SidebarBucketBar`** | Matches `SidebarProjectTree`, `SidebarSectionHeader` — all sidebar siblings share the `Sidebar*` prefix. |
| 2 | Props: active-only vs active+archived | **active-only `{ workspaces }`** | Archived is excluded per requirement; accepting a prop only to discard it is noise. Zero changes to `SharedAppLayout` / `SidebarProps`. |
| 3 | Idle icon: `MoonIcon` vs `ClockIcon` | **`MoonIcon`** | Idle = dormant/quiet. `ClockIcon` reads as "pending/elapsed" and competes with the elapsed-time text inside the menu. `MoonIcon` is more distinct from the warning-circle (attention) and play (running) at 16px. |
| 4 | Badge: neutral shared `CountBadge` (A) vs per-bucket colored (B) | **Per-bucket colored (owner override)** | Owner chose color-coded badges. `CountBadge` stays a shared color-agnostic layout primitive; each caller supplies its color classes. Icon carries the base color; badge gets the same hue at 15% translucency (`bg-error/15 text-error`, etc.). ⚠ If the alpha modifier no-ops (ADR-002 known limitation — vars lack `<alpha-value>`), fall back to solid `bg-error text-white` per bucket. |
| 5 | Empty-state copy: single `workspaces.bucketEmpty` vs per-bucket sentences | **Single `workspaces.bucketEmpty`** | The icon + label already disambiguate which bucket is empty. Three friendlier sentences triple the i18n surface for negligible copy gain. |
| 6 | Menu item: two-line + `WorkspaceActivityText` extraction (A) vs one-line inline (B) | **Two-line + extraction** | The tree leaf (`LeafNode.tsx` L82–92) renders the exact same stats line. Extracting once = tree leaf + bar item + future dashboard share one renderer. Owner is a DRY fanatic. |
| 7 | Tooltip on buttons: `side="right"` (A) vs none (B) | **None** | Each button has a visible text label (in the dropdown header) and a descriptive `aria-label`. A tooltip on a labeled dropdown trigger is redundant; also removes the menu/tooltip collision that motivated `side="right"`. |
| 8 | `role="toolbar"` | **Include** | Three related buttons in a horizontal group = toolbar semantics. Cheap, correct, gives AT a landmark. Requires `aria-label` (added via new i18n key). |
| 9 | `CountBadge` → notification bell adoption | **Include in this pass** | 1-line change in `AppBarNotificationBellContainer.tsx` removes duplicated inline markup. Deferring creates two implementations and a forgettable follow-up; owner is a DRY fanatic. |

**Net:** mostly variant A's architecture (config in `lib/`, `WorkspaceActivityText`
extraction, neutral `CountBadge`, single empty key, no per-bucket colored badges),
with variant B's `Sidebar*` naming and `role="toolbar"`, plus an extra bell
adoption to honor the DRY principle end-to-end.

---

## 3. Final architecture

### 3.1 Files

| Path | Action | Purpose |
|---|---|---|
| `packages/ui/src/lib/workspaceBuckets.ts` | **NEW** | Pure config: `BarBucketId`, `BAR_BUCKET_ORDER`, `BAR_BUCKETS`. Zero React. |
| `packages/ui/src/components/CountBadge.tsx` | **NEW** | Shared neutral count pill. Reused by bar + bell. |
| `packages/ui/src/components/WorkspaceActivityText.tsx` | **NEW** | Shared diff-stats line (`12 +34 −7`). Reused by bar + leaf. |
| `packages/ui/src/components/SidebarBucketBar.tsx` | **NEW** | The toolbar itself: 3 `BucketButton`s + private `WorkspaceBucketMenuItem`. |
| `packages/ui/src/components/Sidebar.tsx` | EDIT | Insert `<SidebarBucketBar>` after drag strip. Add import. |
| `packages/ui/src/components/outliner/LeafNode.tsx` | EDIT | Replace inline stats span with `<WorkspaceActivityText>`. Drop local `hasStats`. |
| `packages/web-core/src/pages/workspaces/AppBarNotificationBellContainer.tsx` | EDIT | Replace inline badge span with `<CountBadge count={unseenCount} />`. |
| `packages/web-core/src/i18n/locales/en/common.json` | EDIT | Add 2 keys under `workspaces`. |

No changes to `SharedAppLayout`, `SidebarProps`, `SidebarProjectTree`, the
`react-arborist` tree, `workspaceStatus.ts`, or the data layer.

### 3.2 Full code — new files

#### `packages/ui/src/lib/workspaceBuckets.ts`

```ts
import {
  type Icon as PhosphorIcon,
  type IconWeight,
  MoonIcon,
  PlayIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';

import type { BucketId } from '../components/outliner/types';

/**
 * Global sidebar bucket bar (ADR-009). The three *active* workspace buckets
 * exposed as quick-access dropdowns at the top of the sidebar. `archived` is
 * intentionally excluded — it has its own section in the project tree.
 *
 * Pure data: no React, no i18n lookups, no side effects. Consumers
 * (currently only SidebarBucketBar) read the icon + color and resolve labels
 * via t() at render time so this file stays framework-agnostic.
 */
export type BarBucketId = Exclude<BucketId, 'archived'>;

export const BAR_BUCKET_ORDER: readonly BarBucketId[] = [
  'attention',
  'running',
  'idle',
] as const;

export interface BarBucketMeta {
  id: BarBucketId;
  /** i18n key under common.json. Reuses existing outliner labels. */
  labelKey: string;
  icon: PhosphorIcon;
  /** Phosphor weight. `fill` for running so the play triangle reads solid. */
  iconWeight?: IconWeight;
  /** Tailwind text-color token applied to the icon only. */
  iconClass: string;
  /** Tailwind classes for the count badge (bg + text). Per-bucket colored
   *  (owner decision). Passed through to CountBadge's className. */
  badgeClass: string;
}

export const BAR_BUCKETS: Record<BarBucketId, BarBucketMeta> = {
  attention: {
    id: 'attention',
    labelKey: 'workspaces.outliner.attention',
    icon: WarningCircleIcon,
    iconClass: 'text-error',
    badgeClass: 'bg-error/15 text-error',
  },
  running: {
    id: 'running',
    labelKey: 'workspaces.running',
    icon: PlayIcon,
    iconWeight: 'fill',
    iconClass: 'text-success',
    badgeClass: 'bg-success/15 text-success',
  },
  idle: {
    id: 'idle',
    labelKey: 'workspaces.idle',
    icon: MoonIcon,
    iconClass: 'text-low',
    badgeClass: 'bg-tertiary text-low',
  },
};
```

#### `packages/ui/src/components/CountBadge.tsx`

```tsx
import { cn } from '../lib/cn';

interface CountBadgeProps {
  count: number;
  /** Cap shown when count exceeds the threshold (e.g. 99 -> "99+"). */
  cap?: number;
  className?: string;
}

/**
 * Small pill-shaped count badge pinned to the top-right of a relative parent.
 * Hidden when count <= 0. The number is also conveyed via the parent's
 * aria-label, so the badge itself is aria-hidden to avoid double announcement.
 *
 * Color-agnostic: this component only lays out the pill; callers pass the
 * color classes (bell: `bg-brand-secondary text-white`; bucket bar: per-bucket
 * `bg-error/15 text-error`, etc.) via `className`. Keeps conflicting bg-*
 * classes out of the shared primitive (cn() is plain clsx, no tailwind-merge).
 */
export function CountBadge({ count, cap = 99, className }: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute -top-2 -right-1 flex h-[18px] min-w-[18px] items-center',
        'justify-center rounded-full px-1 text-2xs font-medium',
        className,
      )}
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}
```

Geometry deliberately matches the existing inline bell badge so the extraction
is a true no-op visually.

#### `packages/ui/src/components/WorkspaceActivityText.tsx`

```tsx
import { cn } from '../lib/cn';

interface WorkspaceActivityTextProps {
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  className?: string;
}

/**
 * Compact diff-stats line: `12 +34 -7`. Returns null when there is nothing to
 * show. Rendered inside the outliner tree leaf and the sidebar bucket-bar
 * menu items so the two stay in lockstep (ADR-009). Extracted from
 * LeafNode.tsx.
 */
export function WorkspaceActivityText({
  filesChanged,
  linesAdded,
  linesRemoved,
  className,
}: WorkspaceActivityTextProps) {
  const hasFiles = filesChanged != null;
  const hasAdded = linesAdded != null && linesAdded > 0;
  const hasRemoved = linesRemoved != null && linesRemoved > 0;
  if (!hasFiles && !hasAdded && !hasRemoved) return null;

  return (
    <span
      className={cn('flex items-center gap-1.5 text-2xs text-muted', className)}
    >
      {hasFiles && <span>{filesChanged}</span>}
      {hasAdded && <span className="text-success">+{linesAdded}</span>}
      {hasRemoved && <span className="text-error">&minus;{linesRemoved}</span>}
    </span>
  );
}
```

#### `packages/ui/src/components/SidebarBucketBar.tsx`

```tsx
import { useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import {
  compareWorkspaceDashboardRecency,
  isWorkspaceIdle,
  isWorkspaceNeedsAttention,
  isWorkspaceRunning,
} from '../lib/workspaceStatus';
import {
  BAR_BUCKETS,
  BAR_BUCKET_ORDER,
  type BarBucketId,
  type BarBucketMeta,
} from '../lib/workspaceBuckets';
import { cn } from '../lib/cn';
import { CountBadge } from './CountBadge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { WorkspaceActivityText } from './WorkspaceActivityText';
import {
  formatRelativeElapsed,
  type OutlinerWorkspace,
} from './outliner/types';

interface SidebarBucketBarProps {
  /** All active (non-archived) workspaces. */
  workspaces: readonly OutlinerWorkspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  className?: string;
}

const BUCKET_PREDICATE: Record<
  BarBucketId,
  (w: OutlinerWorkspace) => boolean
> = {
  attention: isWorkspaceNeedsAttention,
  running: isWorkspaceRunning,
  idle: isWorkspaceIdle,
};

/**
 * Top-of-sidebar toolbar with one dropdown button per active workspace bucket
 * (ADR-009). Always renders all three buttons; empty buckets open a small
 * "No workspaces" row. Items inside each dropdown are sorted newest-first by
 * `compareWorkspaceDashboardRecency` — the shared prop array is never
 * mutated, so the project tree below keeps its own ordering.
 */
export function SidebarBucketBar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  className,
}: SidebarBucketBarProps) {
  const { t } = useTranslation('common');

  const buckets = useMemo(() => {
    const byBucket: Record<BarBucketId, OutlinerWorkspace[]> = {
      attention: [],
      running: [],
      idle: [],
    };
    for (const ws of workspaces) {
      for (const id of BAR_BUCKET_ORDER) {
        if (BUCKET_PREDICATE[id](ws)) {
          byBucket[id].push(ws);
          break; // buckets are mutually exclusive by construction
        }
      }
    }
    for (const id of BAR_BUCKET_ORDER) {
      byBucket[id].sort(compareWorkspaceDashboardRecency);
    }
    return byBucket;
  }, [workspaces]);

  return (
    <div
      role="toolbar"
      aria-label={t('workspaces.bucketBarLabel')}
      className={cn('flex shrink-0 items-center gap-1', className)}
    >
      {BAR_BUCKET_ORDER.map((id) => (
        <BucketButton
          key={id}
          meta={BAR_BUCKETS[id]}
          items={buckets[id]}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          emptyLabel={t('workspaces.bucketEmpty')}
        />
      ))}
    </div>
  );
}

interface BucketButtonProps {
  meta: BarBucketMeta;
  items: readonly OutlinerWorkspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  emptyLabel: string;
}

function BucketButton({
  meta,
  items,
  activeWorkspaceId,
  onSelectWorkspace,
  emptyLabel,
}: BucketButtonProps) {
  const { t } = useTranslation('common');
  const Icon = meta.icon as ComponentType<{
    className?: string;
    weight?: BarBucketMeta['iconWeight'];
  }>;
  const count = items.length;
  const label = t(meta.labelKey);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `${label} — ${count}` : label}
          className={cn(
            'relative flex flex-1 items-center justify-center rounded-sm',
            'h-8 px-2 cursor-pointer transition-colors',
            'text-normal hover:bg-accent hover:text-high',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          )}
        >
          <Icon className={cn('size-4 shrink-0', meta.iconClass)} weight={meta.iconWeight} />
          <CountBadge count={count} className={meta.badgeClass} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="min-w-[260px] max-w-[320px]"
      >
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {count === 0 ? (
          <p className="px-2 py-1.5 text-xs text-low">{emptyLabel}</p>
        ) : (
          items.map((ws) => (
            <WorkspaceBucketMenuItem
              key={ws.id}
              workspace={ws}
              active={ws.id === activeWorkspaceId}
              onSelectWorkspace={onSelectWorkspace}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceBucketMenuItem({
  workspace,
  active,
  onSelectWorkspace,
}: {
  workspace: OutlinerWorkspace;
  active: boolean;
  onSelectWorkspace: (id: string) => void;
}) {
  const elapsed = formatRelativeElapsed(workspace.latestProcessCompletedAt);
  return (
    <DropdownMenuItem
      // Radix closes the menu after onSelect fires by default — gives us
      // close-on-navigate for free.
      onSelect={() => onSelectWorkspace(workspace.id)}
      aria-current={active ? 'page' : undefined}
      className="flex flex-col items-stretch gap-0.5 py-1.5"
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn('truncate', active && 'font-semibold text-high')}>
          {workspace.name}
        </span>
        {elapsed && <span className="shrink-0 text-xs text-low">{elapsed}</span>}
      </span>
      <WorkspaceActivityText
        filesChanged={workspace.filesChanged}
        linesAdded={workspace.linesAdded}
        linesRemoved={workspace.linesRemoved}
      />
    </DropdownMenuItem>
  );
}
```

---

## 4. Exact edits

### 4.1 `Sidebar.tsx` — insert bar after drag strip

Add import (alphabetical, after `SidebarSectionHeader` import block):

```diff
 import { useId, type ReactNode } from 'react';
 import { useTranslation } from 'react-i18next';
 import { cn } from '../lib/cn';
 import { Tooltip } from './Tooltip';
 import { SidebarSectionHeader } from './SidebarSectionHeader';
+import { SidebarBucketBar } from './SidebarBucketBar';
 import {
   SidebarProjectTree,
 } from './SidebarProjectTree';
```

Insert between drag strip (L83) and `SidebarSectionHeader` (L85):

```diff
       <div data-tauri-drag-region className="h-7 shrink-0" aria-hidden="true" />

+      <SidebarBucketBar
+        workspaces={workspaces}
+        activeWorkspaceId={activeWorkspaceId}
+        onSelectWorkspace={onSelectWorkspace}
+      />
+
       <SidebarSectionHeader
         title={t('appBar.projects')}
         titleId={titleId}
         actions={headerActions}
       />
```

All three props already exist on `SidebarProps` — zero new props, zero
`SharedAppLayout` change.

### 4.2 `LeafNode.tsx` — adopt `WorkspaceActivityText`

Add import:

```diff
 import { cn } from '../../lib/cn';
+import { WorkspaceActivityText } from '../WorkspaceActivityText';
 import { TREE_LAYOUT } from './layout';
 import {
   formatRelativeElapsed,
   type LeafNode,
   type TreeNodeRenderProps,
 } from './types';
```

Drop `hasStats` (L25–28) and replace the inline stats span (L82–92):

```diff
 export function OutlinerLeafNode({
   node,
   style,
   dragHandle,
   activeWorkspaceId,
 }: TreeNodeRenderProps<LeafNode> & { activeWorkspaceId?: string | null }) {
   const ws = node.data.workspace;
   const isActive = ws.id === activeWorkspaceId;
   const elapsed = formatRelativeElapsed(ws.latestProcessCompletedAt);
-  const hasStats =
-    ws.filesChanged != null ||
-    (ws.linesAdded != null && ws.linesAdded > 0) ||
-    (ws.linesRemoved != null && ws.linesRemoved > 0);
```

```diff
         {hasStats && (
-          <span className="flex items-center gap-1.5 text-2xs text-muted">
-            {ws.filesChanged != null && <span>{ws.filesChanged}</span>}
-            {ws.linesAdded != null && ws.linesAdded > 0 && (
-              <span className="text-success">+{ws.linesAdded}</span>
-            )}
-            {ws.linesRemoved != null && ws.linesRemoved > 0 && (
-              <span className="text-error">−{ws.linesRemoved}</span>
-            )}
-          </span>
-        )}
+        <WorkspaceActivityText
+          filesChanged={ws.filesChanged}
+          linesAdded={ws.linesAdded}
+          linesRemoved={ws.linesRemoved}
+        />
       </div>
```

`WorkspaceActivityText` returns `null` when empty, so the `hasStats &&`
guard moves inside the component — no behavior change.

### 4.3 `AppBarNotificationBellContainer.tsx` — adopt `CountBadge`

```diff
 import { useNavigate } from '@tanstack/react-router';
 import { BellIcon } from '@phosphor-icons/react';
+import { CountBadge } from '@vibe/ui/components/CountBadge';
 import { cn } from '@vibe/ui/lib/cn';
 import { Tooltip } from '@vibe/ui/components/Tooltip';
 import { useNotifications } from '@/shared/hooks/useNotifications';
```

```diff
         <BellIcon className="w-5 h-5" weight="bold" />
-        {unseenCount > 0 && (
-          <span className="absolute -top-2 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-brand-secondary text-2xs font-medium text-white">
-            {unseenCount > 99 ? '99+' : unseenCount}
-          </span>
-        )}
+        <CountBadge
+          count={unseenCount}
+          className="bg-brand-secondary text-white"
+        />
      </button>
```

### 4.4 `packages/web-core/src/i18n/locales/en/common.json`

Add two keys inside the existing `workspaces` object (after `"outliner"`):

```json
    "outliner": {
      "attention": "Attention"
    },
    "bucketEmpty": "No workspaces",
    "bucketBarLabel": "Workspace buckets",
```

Reused keys (no additions): `workspaces.outliner.attention`,
`workspaces.running`, `workspaces.idle`.

English-only — this fork does not ship other locales (per AGENTS.md and the
local-only architecture).

---

## 5. Data flow + DRY map

Single-source primitives and their consumers:

| Primitive | Location | Consumers (post-change) |
|---|---|---|
| `categorizeWorkspacesForOutliner` / `isWorkspaceNeedsAttention` / `isWorkspaceRunning` / `isWorkspaceIdle` | `packages/ui/src/lib/workspaceStatus.ts` | `SidebarProjectTree` (already), `SidebarBucketBar` (new — uses the three predicates directly; the bar does **not** call `categorizeWorkspacesForOutliner` because it needs newest-first sort, which that fn does not apply to attention/running) |
| `compareWorkspaceDashboardRecency` | `packages/ui/src/lib/workspaceStatus.ts` | `SidebarBucketBar` (sorts all 3 buckets locally) |
| `formatRelativeElapsed` | `packages/ui/src/components/outliner/types.ts` | `LeafNode` (existing), `SidebarBucketBar` menu item (new) |
| `BAR_BUCKETS` config (icon, color, weight, labelKey) | `packages/ui/src/lib/workspaceBuckets.ts` (new) | `SidebarBucketBar` only |
| `WorkspaceActivityText` | `packages/ui/src/components/WorkspaceActivityText.tsx` (new) | `LeafNode` (refactored), `SidebarBucketBar` menu item (new) |
| `CountBadge` | `packages/ui/src/components/CountBadge.tsx` (new) | `SidebarBucketBar` (new), `AppBarNotificationBellContainer` (refactored) |
| `DropdownMenu*` primitives | `packages/ui/src/components/DropdownMenu.tsx` | `SidebarBucketBar` only (new) |

Data flow:

```
SharedAppLayout
  └─ <Sidebar workspaces activeWorkspaceId onSelectWorkspace>  (props unchanged)
       ├─ <SidebarBucketBar workspaces activeWorkspaceId onSelectWorkspace>  ← NEW
       │     · useMemo partitions workspaces via the shared predicates
       │     · sorts each bucket with compareWorkspaceDashboardRecency
       │     · renders 3 <BucketButton> (BAR_BUCKET_ORDER)
       │     · each button: <DropdownMenu> with <CountBadge> + <WorkspaceBucketMenuItem>
       │     · item onSelect → props.onSelectWorkspace(id) → appNavigation.goToWorkspace(id)
       │
       ├─ <SidebarSectionHeader title="Projects" />            (unchanged)
       └─ <SidebarProjectTree ... />                           (unchanged)
```

Key invariants:

- The `workspaces` prop array is never sorted or mutated in place. The bar
  copies into per-bucket arrays; the tree below sees the original order.
- Each workspace lands in exactly one bucket — the predicates are mutually
  exclusive by construction (`isWorkspaceRunning` returns false if
  `isWorkspaceNeedsAttention`; `isWorkspaceIdle` is the complement of both).
  The `break` after the first match is safe but defensive.

---

## 6. Accessibility + edge cases

| Concern | Handling |
|---|---|
| Menu semantics, keyboard nav, Esc, outside-click, one-open-at-a-time | Free from Radix `DropdownMenu` — opening button B closes button A automatically. |
| Trigger labeling | `aria-label="${label}"` or `"${label} — ${count}"` when count > 0; the visible affordance is icon-only. |
| Active item | `aria-current="page"` on the menu item whose workspace matches `activeWorkspaceId`. |
| Redundant count announcement | `CountBadge` is `aria-hidden` — the number lives in the button's `aria-label`. |
| Toolbar landmark | `role="toolbar" aria-label="Workspace buckets"` (`workspaces.bucketBarLabel`). |
| Empty bucket | Still renders, still clickable; dropdown shows one `<p>No workspaces</p>` row under the label. Never disabled. |
| Close-on-navigate | Radix closes the menu after `onSelect` fires by default — the navigate call happens inside that handler. |
| StrictMode double-invoke | `useMemo` partition + `sort` are pure; no side effects; safe under double render. |
| Sidebar width budget (256 px) | Three flex-1 buttons in a `bg-panel p-1` row = ~80 px each, fits a 32 px touch target + icon + badge. Dropdown content is `min-w-[260px] max-w-[320px]` and portaled to body (`z-[10000]`), so it overflows the sidebar edge freely. |
| Mobile drawer | Sidebar already renders inside the mobile drawer in `SharedAppLayout`; the bar lives inside `<Sidebar>`, so it travels with it. No extra work. |
| `latestProcessCompletedAt` missing | `formatRelativeElapsed` returns `null` → elapsed span omitted; menu item still renders name + stats. |
| `linesAdded`/`linesRemoved` = 0 or absent | `WorkspaceActivityText` omits those spans; returns `null` if nothing to show. |
| Badge overflow | `count > 99` → `"99+"` (cap shared with bell). |

---

## 7. Verification checklist

Run from repo root after applying the changes.

**Type / lint / build:**

```bash
pnpm --filter @vibe/ui run lint
pnpm --filter @vibe/web-core run lint
pnpm run lint:i18n            # verifies the new keys + no orphan refs
pnpm run check                # tsc + Rust workspace checks
pnpm --filter @vibe/ui run test
pnpm --filter @vibe/web-core run test
pnpm run build
```

**Unit test to add** — `packages/ui/src/components/SidebarBucketBar.test.tsx`:

1. Renders all 3 buttons even when `workspaces=[]` (zero badges).
2. With mixed workspaces, badge counts match the predicate partition.
3. Clicking a button opens its dropdown; items are newest-first by
   `latestProcessCompletedAt` (assert DOM order).
4. `onSelectWorkspace` fires with the right id on item click and the menu
   closes afterwards.
5. Active workspace's menu item has `aria-current="page"`.
6. `role="toolbar"` + `aria-label` present on the container.

**Runtime smoke** (`pnpm run dev`):

- [ ] Bar visible at the very top of the sidebar, above the Projects header,
      below the macOS drag region (Windows/Linux: below the Tauri strip).
- [ ] Three icons in the right color: red warning-circle, green solid play,
      grey moon.
- [ ] Badges appear only when count > 0; cap at "99+"; **each badge tinted its
      bucket color** (verify computed style — if `bg-error/15` no-ops per the
      ADR-002 alpha limitation, switch to solid `bg-error text-white` etc.).
- [ ] Clicking each button opens the menu **downward** (`side="bottom"`).
- [ ] Inside a bucket, workspaces are ordered newest-first; the elapsed time
      matches `latestProcessCompletedAt`.
- [ ] Clicking an item navigates to that workspace and the menu closes.
- [ ] Empty bucket opens a one-row "No workspaces" dropdown.
- [ ] Opening bucket B closes bucket A (one-open-at-a-time).
- [ ] Esc / outside-click closes the open menu.
- [ ] Notification bell badge still renders identically (CountBadge adoption).
- [ ] Tree leaf stats line still renders identically (WorkspaceActivityText
      adoption).
- [ ] At 256 px sidebar width, the row does not overflow horizontally.
- [ ] On mobile, the bar appears inside the drawer above the Projects header.

**Documentation:**

- [ ] File `docs/ADR/ADR-009-sidebar-bucket-bar.md` with `Status: Proposed`
      before code, `Accepted` after merge. Cross-reference this plan.

---

## 8. Owner decisions (2026-08-03)

All review-glm open questions + the two extra design calls, settled by the owner:

1. **Button content** — icon only (+ badge). Labels live in aria-label and the
   dropdown header. (Plan unchanged.)
2. **Idle icon** — `MoonIcon`. (Plan unchanged.)
3. **Attention header label** — reuse `workspaces.outliner.attention`
   ("Attention"). (Plan unchanged.)
4. **Badge color** — **per-bucket colored** (owner override): attention
   `bg-error/15 text-error`, running `bg-success/15 text-success`, idle
   `bg-tertiary text-low`. `CountBadge` is color-agnostic; callers pass the
   color classes. (ADR-002 alpha-modifier caveat noted; verify at runtime.)
5. **Bar background** — **none** (owner override): the toolbar row is
   transparent, only the icons in a row (consistent with the ADR-008
   "no outline" aesthetic). Dropped `bg-panel rounded-md p-1`.

No further open questions.

---

**End of plan.**
