# PLAN: Sidebar Tree ↔ Kanban Board Cross-Surface Drag-and-Drop

- **Status**: Proposed
- **Date**: 2026-08-03
- **Depends on**: ADR-011 (tasks section), `@hello-pangea/dnd` 18 (already in dep tree)
- **Branch**: `feat/ui-modernization` (HEAD `dd3859cc`)

---

## 1. Goals & non-goals

### Goals

- Drag an Issue card between these targets within ONE Project:
  1. **Tree view ↔ Kanban view**: drag a card from Tasks section of `SidebarProjectTree` into a status column on `KanbanBoard`, and back.
  2. **Tree view → Tree view (Tasks only)**: drag a card between any two StatusNodes under the Tasks section (e.g. Todo → Reviewed). Works even when the destination status is **collapsed** — drop lands on the correct status row.
- Use a single `@hello-pangea/dnd` `DragDropContext` wrapping both surfaces.
- Reuse the existing `bulkUpdateIssues` mutation path (no parallel write path).
- Keep the project-reorder drag in react-arborist intact.

### Non-goals (explicitly excluded)

- Workspaces section (buckets, leaves, project reorder).
- Project reorder (already handled by react-arborist, unchanged).
- Cross-project drag (forbidden — only within one Project).
- Tasks-section expand/collapse bug (other agent owns).
- Tree Tasks section open/closed state persistence (ADR-011: not persisted for statuses/cards).

---

## 2. Affected files

| File | Role |
|------|------|
| `packages/web-core/src/shared/components/ui-new/containers/SharedAppLayout.tsx` | New top-level `DragDropContext` mount; `onDragEnd` handler; `resolveDragEnd` pure function. |
| `packages/web-core/src/features/kanban/ui/KanbanContainer.tsx` | Remove its `KanbanProvider`→`DragDropContext`; register kanban-internal handler into bridge ref. |
| `packages/ui/src/components/KanbanBoard.tsx` | `KanbanProvider` stripped of `DragDropContext` (becomes layout-only), or removed + inlined. |
| `packages/ui/src/components/outliner/CardNodeRow.tsx` | Wrap in `<Draggable>` (`draggableId="issue:<uuid>"`). Merge `dragHandle` + `provided.innerRef`. |
| `packages/ui/src/components/outliner/StatusNodeRow.tsx` | Wrap in `<Droppable>` (`droppableId="<projectId>:status:<statusId>"`). |
| `packages/ui/src/components/outliner/treeNodes.tsx` (`TreeNodeRouter`) | Add `Draggable`/`Droppable` wrapper routing for card/status nodes. |
| `packages/ui/src/components/outliner/types.ts` | No changes needed (id factories already exist). |
| `packages/ui/src/components/SidebarProjectTree.tsx` | No changes needed (`disableDrag` already excludes card/status nodes). |
| `packages/web-core/src/shared/lib/remoteApi.ts` | No changes (reuse existing `bulkUpdateIssues`). |
| `packages/web-core/src/shared/components/sidebar/SidebarProjectTasksRegistry.tsx` | No changes (shape collection subscription handles reconciliation). |

### Files NOT touched

- `KanbanProvider` consumers — they still render `<KanbanBoard>`, `<KanbanCards>`, `<KanbanCard>` as before (these are leaf `<Draggable>`/`<Droppable>` components — they don't contain a `DragDropContext`).
- All workspace/project-reorder code paths.
- `buildTreeData.ts` — ownership stays pure data.

---

## 3. Library choice rationale

`@hello-pangea/dnd` 18 already in `packages/web-core/package.json` (`^18.0.1`), already used across 5 components (`KanbanBoard.tsx`, `IssueListSection.tsx`, `SubIssueRow.tsx`, `IssueSubIssuesSectionContainer.tsx`, `RemoteProjectsSettingsSection.tsx`). No second drag system introduced. `@dnd-kit` is NOT added as transitive dep — only `@hello-pangea/dnd` + its react peer deps are in the lockfile. Native `react-arborist` drag stays for project-reorder only (separate mouse-handler system, scoped by `disableDrag`/`disableDrop`).

### Data layer note (legacy naming vs current engine)

The folders `packages/web-core/src/shared/integrations/electric/` and `…/electric/collections.ts`, the hook name `useShape`, and many comments mention "Electric sync" / "Electric CDC". **This is legacy naming** — the real backend `crates/remote` (which hosted the ElectricSQL service) was deleted in the local-only fork. The current data engine is:

- `createShapeCollection` from `@tanstack/react-db` (`shared/lib/electric/collections.ts:1`).
- REST sync via `makeRequest` (`shared/lib/remoteApi.ts`).
- Read path: `useLiveQuery` over the shape collection → `useShape` returns the rows.
- Write path: optimistic `collection.update(...)` (when `mutation` is provided) OR a plain REST call (`bulkUpdateIssues` at `remoteApi.ts:61`).
- Fallback polling: `FALLBACK_REFRESH_INTERVAL_MS = 30_000` (`collections.ts:43`) re-fetches if a write-triggered refetch is missed.

So **after a `bulkUpdateIssues` write, reconciliation is a REST refetch + react-db collection sync, not an Electric CDC stream**. Plan sections that say "Electric sync" are using the legacy name; the mechanism behind it is REST+react-db.

---

## 4. Existing primitives

### Mutation: move issue between statuses

**File**: `packages/web-core/src/shared/lib/remoteApi.ts:61`

```typescript
export async function bulkUpdateIssues(
  updates: BulkUpdateIssueItem[]  // { id: string; changes: Partial<UpdateIssueRequest> }
): Promise<void>
```

`UpdateIssueRequest` (`shared/remote-types.ts:110`) has `status_id?: string | null`. The kanban's `handleDragEnd` already calls `bulkUpdateIssues` with `{status_id: destId, sort_order: ...}` (see below). Cross-surface drops use the **same call**, passing only `{status_id: targetStatusId}` (no sort_order recalculation for unrelated issues).

### Existing kanban DragDropContext location

**File**: `packages/ui/src/components/KanbanBoard.tsx:264–281` (`KanbanProvider` component)

```tsx
<DragDropContext onDragEnd={onDragEnd}>
  <div className={cn('inline-grid grid-flow-col auto-cols-...', className)}>
    {children}
  </div>
</DragDropContext>
```

Called from `KanbanContainer.tsx:1033` (kanban mode) and `:1193` (list-view mode).

### draggableId convention (kanban)

- `KanbanCard`: `draggableId={id}` where `id` is `issue.id` — bare UUID (`KanbanBoard.tsx:96`)
- `IssueListRow`: `draggableId={issue.id}` — bare UUID (`IssueListRow.tsx:95`)
- `SubIssueRow`: `draggableId={id}` — bare UUID (`SubIssueRow.tsx:82`)
- `RemoteProjectsSettingsSection`: `draggableId={status.id}` — bare UUID (`RemoteProjectsSettingsSection.tsx:206`)

### droppableId convention (kanban)

- `KanbanCards`: `droppableId={id}` where `id` is `status.id` — bare UUID (`KanbanBoard.tsx:180`)
- `IssueListSection`: `droppableId={status.id}` — bare UUID (`IssueListSection.tsx:99`)
- `IssueSubIssuesSection`: `droppableId={parentIssueId}` — bare UUID (`IssueSubIssuesSection.tsx:56`)

### Existing kanban onDragEnd handler

**File**: `packages/web-core/src/features/kanban/ui/KanbanContainer.tsx:706–799`

Handles kanban-internal drags: `setItems` (optimistic local state) + `bulkUpdateIssues` with full sort_order recalculation for all affected columns. Uses `kanbanFilters.sortField` to gate within-column reorders. Sync-guarded via `isSyncingRef`.

### react-arborist disableDrag / disableDrop

**File**: `packages/ui/src/components/SidebarProjectTree.tsx:317–337`

- `isProjectDragDisabled(data)`: returns `data.type !== 'project'` → all non-project nodes (section, bucket, status, card, leaf) already have arborist drag DISABLED.
- `isProjectDropDisabled(args)`: only allows root-level project-to-project drops.

This means: card rows (`type === 'card'`) and status rows (`type === 'status'`) are already excluded from react-arborist's drag system. hello-pangea/dnd wrappers can safely claim these rows without arborist interference.

---

## 5. id schema

| Kind | Pattern | Example | Collision-safe? |
|------|---------|---------|-----------------|
| `draggableId` (kanban Issue) | `"issue:<issueUuid>"` | `"issue:0192f8a3-…"` | Yes — "issue:" prefix distinguishes from bare UUIDs used by arborist node ids. |
| `draggableId` (tree Issue) | same | same | Yes — one draggableId per issue entity, shared across surfaces. |
| `droppableId` (kanban column) | `<statusId>` (bare UUID, unchanged) | `"0192f8a3-…"` | Yes — statusIds are globally-unique UUIDs; "issue:" prefix on draggables can't collide. |
| `droppableId` (tree status row) | `"<projectId>:status:<statusId>"` | `"proj123:status:abc456"` | Yes — `makeStatusNodeId()`; distinct from bare kanban UUID, distinct from arborist node ids. |
| `droppableId` (invalid/forbidden) | any other | — | Resolver rejects. |

**Rationale**: Tree droppables use `makeStatusNodeId(projectId, statusId)` (already defined in `types.ts:190`). This is guaranteed distinct from the kanban's bare `status.id` droppableIds. Both surfaces show the same active project simultaneously — the prefix prevents droppableId collision between tree and kanban.

---

## 6. Architecture

### 6.1 Single DragDropContext mount point

**Decision**: Mount `<DragDropContext>` in `SharedAppLayout`, wrapping the entire layout grid.

```tsx
// SharedAppLayout.tsx
<div className="grid grid-cols-[256px_1fr] ...">
  <DragDropContext onDragEnd={handleCrossSurfaceDragEnd}>
    <Sidebar ... />        {/* contains SidebarProjectTree */}
    <div>
      <NavbarContainer ... />
      <Outlet />           {/* renders KanbanContainer (kanban) or other pages */}
    </div>
  </DragDropContext>
</div>
```

**Why `SharedAppLayout`** (not `_app.projects.$projectId.tsx` or a new provider):
- `SharedAppLayout` owns BOTH the `<Sidebar>` (tree) and `<Outlet>` (kanban). A route-level context would NOT span the sidebar.
- Portal approach would require separate contexts bridged by manual event translation — fragile.
- `DragDropContext` mounts once for the full app lifecycle (not recreated per-project navigation). The `onDragEnd` handler gates on `activeProjectId`, rejecting cards from non-active projects.

**Consequences**: `KanbanContainer` must NOT mount its own `DragDropContext` (see §6.4). The `KanbanProvider` component from `KanbanBoard.tsx` is refactored to a layout-only component (or removed — its grid `div` is inlined).

### 6.2 onDragEnd handler

**Location**: `SharedAppLayout.tsx`

```typescript
function resolveDragEnd(
  result: DropResult,
  activeProjectId: string | null
): DragOutcome;

type DragOutcome =
  | { type: 'no-op' }
  | { type: 'kanban-internal'; result: DropResult }
  | { type: 'move-issue'; issueId: string; targetStatusId: string; projectId: string }
  | { type: 'invalid'; reason: string };
```

**Resolution logic** (pure function, unit-testable):

1. `result.destination === null` → `no-op`
2. `!activeProjectId` → `invalid: "no active project"`
3. Parse `draggableId`: if not `"issue:<uuid>"` → `invalid: "not an issue"`
4. Look up issue by UUID (via a closure-provided `issuesById` or pass it in) → if not found, `invalid: "unknown issue"`
5. `issue.project_id !== activeProjectId` → `invalid: "cross-project"`
6. Parse `destination.droppableId`:
   - If bare UUID (kanban column): `targetStatusId = droppableId`
   - If matches `/<projectId>:status:(.+)/`: extract statusId → `targetStatusId`
   - Otherwise → `invalid: "not a valid status target"`
7. If `source.droppableId` and `destination.droppableId` resolve to same status AND both are kanban columns AND same index → `no-op`
8. If both source and destination are kanban columns → `kanban-internal` (delegate to KanbanContainer handler)
9. If cross-surface OR tree→tree → `move-issue` with `targetStatusId`

**Bridge pattern for kanban-internal delegation**:

`SharedAppLayout` holds a `useRef` for the kanban handler. `KanbanContainer` registers its existing `handleDragEnd` via a React context setter on mount.

```typescript
// SharedAppLayout.tsx
const kanbanHandlerRef = useRef<((result: DropResult) => void) | null>(null);
// ... provide setter via context

const handleCrossSurfaceDragEnd = useCallback((result: DropResult) => {
  const outcome = resolveDragEnd(result, activeProjectId, issuesById);
  if (outcome.type === 'no-op' || outcome.type === 'invalid') return;
  if (outcome.type === 'kanban-internal') {
    kanbanHandlerRef.current?.(result);
    return;
  }
  // move-issue
  bulkUpdateIssues([{
    id: outcome.issueId,
    changes: { status_id: outcome.targetStatusId }
  }]).catch(err => console.error('DnD cross-surface move failed:', err));
}, [activeProjectId, issuesById]);
```

### 6.3 react-arborist dnd disabled for card rows

**Already done.** `SidebarProjectTree.tsx`:

```typescript
// Line 317
const isProjectDragDisabled = useCallback(
  (data: SidebarTreeNode) => data.type !== 'project',
  [],
);
```

All non-project nodes (`section`, `bucket`, `status`, `card`, `leaf`) are excluded from react-arborist's built-in drag. The `dragHandle` ref is still attached to these rows but react-arborist ignores it for drag initiation because `disableDrag` returned `true`.

**What we add**: hello-pangea/dnd `<Draggable>` wrapper on `CardNodeRow` and `<Droppable>` on `StatusNodeRow`. Since arborist is NOT active on these nodes, there's no handler conflict. The `dragHandle` ref from arborist is merged with `provided.innerRef` via a callback ref:

```typescript
const setRefs = (el: HTMLDivElement | null) => {
  provided.innerRef(el);
  if (dragHandle) {
    if (typeof dragHandle === 'function') dragHandle(el);
    else (dragHandle as MutableRefObject<HTMLDivElement | null>).current = el;
  }
};
```

This ensures both refs point to the same DOM node (arborist uses it for keyboard focus management; hello-pangea uses it for mouse tracking).

### 6.4 Keyboard a11y + caret toggle preservation

**Caret toggle**: In `TreeCaretRow` (used by `StatusNodeRow`) and `CardNodeRow`, the caret `onClick` calls `node.toggle()`. This handler fires separately from drag. `hello-pangea/dnd` supresses click events during drag (via `snapshot.isDragging` guard), so:
- Normal click → caret toggles (expands/collapses StatusNode or CardNode children).
- Drag start → caret does NOT toggle; drag proceeds.

**Keyboard navigation**: react-arborist provides keyboard navigation (Arrow Up/Down, Left/Right, Enter) via its tree widget. The `role="treeitem"` ARIA attributes are preserved. `<Draggable>` and `<Droppable>` do NOT strip ARIA roles or keyboard event handlers — they only add mouse/touch handlers. Arborist keyboard navigation is fully preserved.

**Keyboard accessibility for drag itself**: `@hello-pangea/dnd` supports Space-to-lift via its default `dragHandleProps`. The drag handle covers the entire row. Space on a focused card row initiates drag (arrow keys continue to work for arborist tree navigation).

### 6.5 Collapsed-target drop detection

**Decision**: `StatusNodeRow` IS the `<Droppable>`. The droppable wraps the row element itself, NOT its children. This means:
- Drop always lands on the status row — regardless of collapse state.
- Cards inside a collapsed status are NOT drop targets (only the status header is).
- No auto-expand needed. User drops on collapsed status → issue's `status_id` changes → next render shows the card under that status (still collapsed until user expands).

The `<Droppable>` renders a `placeholder` (invisible spacer), which react-arborist virtualization handles correctly because droppable state changes trigger re-render of the affected row.

### 6.6 KanbanProvider refactoring

`KanbanProvider` in `KanbanBoard.tsx:258–281` currently wraps `DragDropContext`. After lifting the context to `SharedAppLayout`, this component is refactored:

**Option A** (chosen): Remove `DragDropContext` from `KanbanProvider`. Keep the layout grid `div`. Rename to `KanbanGrid` or keep name — either works since the import consumers don't need to know about the internal DragDropContext.

```tsx
// KanbanBoard.tsx — after refactor
export const KanbanProvider = ({ children, className }: {
  children: ReactNode; className?: string;
}) => (
  <div className={cn('inline-grid grid-flow-col auto-cols-...', className)}>
    {children}
  </div>
);
```

`KanbanContainer.tsx:1033` and `:1193` now just use `KanbanProvider` (layout only) without a nested `DragDropContext` — the outer one from `SharedAppLayout` handles all drag events.

The `KanbanBoard`, `KanbanCards`, `KanbanCard` components are unchanged — they're `<Draggable>`/`<Droppable>` leaf components that connect to the nearest ancestor `DragDropContext`.

---

## 7. UI behavior

### 7.1 Drag preview

Use hello-pangea/dnd default: the dragged element lifts with a drop shadow (`snapshot.isDragging && 'cursor-grabbing shadow-lg'` from the existing `KanbanCard`/`IssueListRow` styles). No custom portal or clone.

### 7.2 Cross-view flows

- **tree → kanban**: User drags a card (from `CardNodeRow` under any Tasks status) to a kanban column (`KanbanCards`). Card appears in destination column via shape collection re-sync. The tree re-renders (card moves to new status or disappears from tree if tasks section not yet reloaded — collection subscription handles reconciliation).
- **kanban → tree**: User drags a kanban card to a `StatusNodeRow` in the sidebar. Tree may not visually show the card until the status expands — that's expected (lazy data already loaded via `SidebarProjectTasksRegistry`, just collapsed). Card disappears from source kanban column via the same shape collection subscription.
- Both use same mutation: `bulkUpdateIssues([{id: issueId, changes: {status_id: targetStatusId}}])`.

### 7.3 Cross-status within tree

Drag from `CardNodeRow` (under Status A) to `StatusNodeRow` (Status B header). Drop always lands on the status header (collapsed or expanded). User must expand the target status to see the moved card — collapse persists per ADR-011 (status/card open-state NOT persisted).

### 7.4 Disallowed drops

Resolved in `resolveDragEnd` → returns `{type: 'invalid', reason: ...}`. The library snaps the card back because `onDragEnd` returns early (no state change). Invalid targets:
- `project` node (not a status target)
- `section`/`bucket`/`leaf` nodes from Workspaces section
- Any droppable whose parsed `projectId` ≠ `activeProjectId`
- Dropping on own card row (draggable cannot be a droppable)
- Dropping in empty space within the tree (arborist has no droppable → `destination === null` → no-op)

### 7.5 Multi-select disabled

When `isMultiSelectActive` is `true`, kanban `KanbanCard` already passes `dragDisabled={isMultiSelectActive}` (`KanbanContainer.tsx:1090`). Tree `CardNodeRow` mirrors this: `isDragDisabled` when multi-select is active. This prevents drag during bulk selection.

---

## 8. State & data flow

### 8.1 Mutation path (single existing call)

```
User drops card
  → DragDropContext.onDragEnd fires
  → resolveDragEnd(…) → {type: 'move-issue', issueId, targetStatusId, projectId}
  → bulkUpdateIssues([{id: issueId, changes: {status_id: targetStatusId}}])
  → POST /v1/issues/bulk
  → Backend writes
  → Shape collection refetches (REST, via `makeRequest` in
    `packages/web-core/src/shared/lib/electric/collections.ts`)
  → useShape(PROJECT_ISSUES_SHAPE) re-fires in both:
      a) SidebarProjectTasksRegistry → tasksByProject → buildTreeData → SidebarProjectTree re-renders
      b) ProjectProvider → issues → filteredIssues → items state → KanbanContainer re-renders
```

### 8.2 Optimistic update

For kanban-internal drags: existing `setItems` in `KanbanContainer.handleDragEnd` already provides optimistic local reorder + `isSyncingRef` guard against incoming collection refetch flicker. Unchanged.

For cross-surface drags: NO optimistic update. The `bulkUpdateIssues` call is fire-and-forget. The shape collection re-syncs from the server on the next request (triggered either by mutation invalidation or by `FALLBACK_REFRESH_INTERVAL_MS = 30s` polling in `collections.ts:43`). Latency bound is therefore "next mutation-triggered refetch or 30s, whichever comes first". Acceptable for cross-surface drag (rare operation). If needed, a V2 could add an optimistic local state bump for the tree (mirror kanban's `setItems` pattern with the tree `tasksByProject` ref).

### 8.3 Effects on lazy Tasks loader

None. `SidebarProjectTasksRegistry` is already subscribed to `PROJECT_ISSUES_SHAPE` for open tasks projects. The shape collection re-emits data on the next refetch and `useShape` propagates it. The tree rebuilds via `buildTreeData` (pure, memoized). No additional network requests or hooks fired.

For a project whose Tasks section is NOT open — the card disappears from the tree (correct: the tree only shows cards for loaded/expanded projects). The kanban continues to show the card in its new column.

### 8.4 Droppable inside react-arborist virtual list

react-arborist 3.16 uses `react-window` `FixedSizeList` for virtualization. Each `<Droppable>` mounts inside a single virtual row's DOM subtree. This is safe because:
- hello-pangea/dnd doesn't require `Droppable` to be a direct child of anything specific — just inside the `DragDropContext`.
- `react-window` rows are absolutely-positioned divs; the droppable is contained within one row.
- Virtualization doesn't unmount scrolled-out Droppables aggressively with `overscanCount: 5` (layout.ts). Droppable refs remain stable enough for drag detection.

Potential issue: `react-window` may not re-render scrolled-out rows, causing `<Droppable>` to miss drag-over events. Mitigation: set `overscanCount` higher (8–10) during active drag via a flag, or use `isDropDisabled` on non-relevant surfaces. NOT a blocker — test empirically.

---

## 9. TDD plan (RED tests first)

### 9.1 Pure logic: `resolveDragEnd`

**File**: new `packages/web-core/src/shared/lib/resolveDragEnd.ts` (or inline in SharedAppLayout)

```typescript
import type { DropResult } from '@hello-pangea/dnd';
import type { DragOutcome } from './types';

function resolveDragEnd(
  result: DropResult,
  activeProjectId: string | null
): DragOutcome;
```

Unit tests (Vitest, `describe('resolveDragEnd')`):

| Test case | Expected outcome |
|-----------|-----------------|
| `destination === null` | `no-op` |
| `activeProjectId === null` | `invalid: "no active project"` |
| `draggableId === "issue:uuid"`, source==dest, same index | `no-op` |
| `draggableId === "issue:uuid"`, source==dest same status, diff index | `kanban-internal` or `no-op` (depends on surface) |
| `draggableId === "issue:uuid"`, cross-status kanban | `kanban-internal` |
| `draggableId === "issue:uuid"`, tree→kanban diff status | `move-issue` |
| `draggableId === "issue:uuid"`, kanban→tree diff status | `move-issue` |
| `draggableId === "issue:uuid"`, tree→tree diff status | `move-issue` |
| `draggableId` not starting with `"issue:"` | `invalid: "not an issue"` |
| Destination droppable is workspace bucket id | `invalid: "not a valid status target"` |
| Destination droppable is leaf node id | `invalid: "not a valid status target"` |
| Destination droppable is project node id | `invalid: "not a valid status target"` |
| Tree droppable has wrong project prefix (cross-project) | `invalid: "cross-project"` |
| Kanban droppable status belongs to wrong project | `invalid: "cross-project"` |

### 9.2 Tree component test: Draggable/Droppable wrapping

**File**: extend `packages/ui/src/components/outliner/treeNodes.test.tsx` (existing 52 tests)

Verify:
- `CardNodeRow` renders inside `<Draggable>` with `draggableId="issue:<uuid>"`
- `StatusNodeRow` renders inside `<Droppable>` with `droppableId="<projectId>:status:<statusId>"`
- `ProjectTreeNode` does NOT render `<Draggable>` or `<Droppable>` (project reorder stays react-arborist)
- `BucketNode`, `LeafNode` do NOT render `<Draggable>` or `<Droppable>`

### 9.3 Integration: KanbanProvider refactor

**File**: extend `packages/ui/src/components/KanbanBoard.test.tsx` (if exists) or create

Verify:
- `KanbanProvider` renders children without a `DragDropContext`
- `KanbanCard` still renders `<Draggable>` (leaf, connects to ancestor context)
- `KanbanCards` still renders `<Droppable>` (leaf)

### 9.4 Smoke (Playwright) — write AFTER implementation

| Test | Steps | Expected |
|------|-------|----------|
| tree card → kanban column | Drag `CardNodeRow` to a `KanbanCards` column | Card appears in destination kanban column; source tree status count decrements |
| kanban card → tree status | Drag `KanbanCard` to a `StatusNodeRow` in tree | Card's `status_id` updates; tree shows it under new status (when expanded) |
| tree card → collapsed tree status | Drag `CardNodeRow` onto a collapsed `StatusNodeRow` | Drop succeeds; expanding the status shows the moved card |
| cross-project reject | Drag issue from Project A to tree status under Project B | Drop rejected (card snaps back) |
| workspace node reject | Drag issue onto a workspace leaf | Drop rejected |
| duplicate source/dest | Drag card and drop on same status, same position | No-op; no API call |
| sort_order preserved | Drag within kanban (intra-status) | Existing kanban handler fires; sort_order recalculated |

---

## 10. Verification steps

```bash
# Type checks (all packages)
pnpm --filter @vibe/ui run check
pnpm --filter @vibe/web-core run check
pnpm --filter @vibe/local-web run check

# Unit tests (ui package — 52 existing + new resolveDragEnd + tree rendering tests)
pnpm --filter @vibe/ui run test

# Lint
pnpm --filter @vibe/local-web run lint:i18n

# Build
pnpm --filter @vibe/local-web run build

# Format
pnpm exec prettier --write --single-quote \
  packages/web-core/src/shared/components/ui-new/containers/SharedAppLayout.tsx \
  packages/ui/src/components/KanbanBoard.tsx \
  packages/ui/src/components/outliner/CardNodeRow.tsx \
  packages/ui/src/components/outliner/StatusNodeRow.tsx \
  packages/ui/src/components/outliner/treeNodes.tsx
```

---

## 11. Risks / open questions

| Risk | Mitigation |
|------|-----------|
| **react-window virtualization + Droppable** — scrolled-out `Droppable` rows may not receive drag-over events. | Test empirically early. Mitigations: (a) increase `overscanCount` during drag, (b) use `isDropDisabled` to disable non-visible Droppables, (c) if severe, pre-mount all droppable rows using `react-arborist`'s `openByDefault` workaround. |
| **DragDropContext recreation on project navigation** — React unmounts/mounts `SharedAppLayout` on route change. | Verify `SharedAppLayout` uses `<Outlet>` and persists across navigations — it should NOT remount. If it does, wrap with a stable key. |
| **Tree card `dragHandle` ref callback vs `provided.innerRef`** — both need same DOM node. | Use callback ref merger (tested pattern from `KanbanBoard.tsx:99–107`). |
| **`onDragEnd` closure staleness** — `activeProjectId` or `issuesById` may be stale when handler fires. | Pass via `useRef` mirror or compute with functional updates. The `resolveDragEnd` pure function accepts values as args, not closures. |
| **Kanban-internal handler ref stale** — KanbanContainer's `handleDragEnd` may reference old `items` state. | Already solved: `handleDragEnd` uses `setItems(prev => …)` functional updater (captures latest state). Handler is re-registered on dependency change via `useEffect`. |
| **Only one project's Tasks data loaded at a time** — tree only shows cards for expanded projects. | Expected per ADR-011 (lazy loading). Dragging a card from an expanded project to kanban works. Dragging into a collapsed project's tree is impossible (no visible droppable targets — target project's Tasks section is closed, status nodes aren't rendered). |
| **Sub-issues not draggable** — `CardNodeRow` currently doesn't render sub-issues as separate draggable cards. | Out of scope for this plan. Sub-issue hierarchy stays as-is (expandable children within parent card). |

### Open questions

1. **Should dropping on a collapsed tree status auto-expand it?** Leaning NO — consistent with ADR-011 (status open-state is ephemeral, auto-expand would create an orphaned open state). User expands manually.
2. **Should tree-card drag provide a visual drop indicator (green line) within a column?** hello-pangea/dnd provides a placeholder (`provided.placeholder`) in the `Droppable`. For tree droppables, this shows as a brief space-pulse at the status row. Acceptable for V1.
3. **Should within-tree same-status reorder (sort_order only) be supported?** Out of scope for this plan — only BETWEEN statuses. Could add later by extending `resolveDragEnd` + `bulkUpdateIssues` with sort_order.

---

## 12. Rollout

**Recommendation: Single atomic PR.**

Rationale:
- All changes are interdependent: lifting `DragDropContext` to `SharedAppLayout` requires simultaneous removal from `KanbanProvider`, which requires tree row wrapping, which requires the unified `onDragEnd`.
- Incremental delivery would introduce intermediate broken states (e.g., kanban without a `DragDropContext`, or tree with `<Draggable>` but no context).
- Scope is bounded: ~6 files touched, mostly additive (tree rows get wrappers), one removal (context from `KanbanProvider`).
- Testing surface is manageable with existing 52 unit tests + new pure-function tests.

### Implementation order within the PR

1. Write `resolveDragEnd` pure function + tests (RED → GREEN).
2. Refactor `KanbanProvider` to layout-only (remove `DragDropContext`).
3. Mount single `DragDropContext` in `SharedAppLayout` with `onDragEnd` + bridge ref.
4. Register kanban handler from `KanbanContainer` via context bridge.
5. Wrap `CardNodeRow` in `<Draggable>`, `StatusNodeRow` in `<Droppable>`.
6. Add tree rendering tests for Draggable/Droppable presence.
7. Dev-server smoke test (drag tree↔kanban, tree→tree).
8. Write Playwright smoke tests.
