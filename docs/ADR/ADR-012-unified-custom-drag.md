# ADR-012: Unified custom drag-and-drop (hello-pangea removed)

- **Status**: Accepted
- **Date**: 2026-08-03
- **Amended**: 2026-08-03 (extensibility for reorder drags + indexed column drops with live insertion preview; see the two "Amendment" sections below)
- **Relates to**: ADR-011 (Tasks section in the sidebar tree), PLAN-sidebar-kanban-cross-dnd-2026-08-03.md (superseded by this ADR).

## Amendment (2026-08-03): indexed kanban-column drops + live insertion preview

Owner requirement: a card dropped onto a kanban column must land at a **positional index**, not appended to the column end — insert BEFORE the hovered card when the pointer is above that card's `height/2`, AFTER it when below. A **live insertion indicator** must preview the slot before mouseup.

Consulted via @escalate-deepseek. Extends this ADR without conflicting with the future reorder kinds:

1. **`index` on the candidate** — `Candidate` and `DragCompletion` gain `index: number | null`, orthogonal to `Placement`. `Placement` ('on'/'before'/'after') serves future `column-reorder`/`project-reorder` (before/after a target); `index` serves card-slot positioning within a column. `issue-move` uses `index`; reorder kinds will use `placement` and keep `index: null`.
2. **Pure midpoint split** — `computeInsertIndex(pointerY, cardRects)` in `geometry.ts`: `pointerY < card.midpoint → insert before`, else after; returns `0..cards.length`. Callers pre-sort and pre-filter.
3. **Controller resolution** — resolved per rAF frame for `issue-move` candidates over kanban columns only: post-hoc `querySelector` of the target column, its `[data-dnd-card]` children measured live (fresh `getBoundingClientRect`; the existing scroll listener already invalidates the target cache), the dragged source card excluded via `data-dnd-card-issue-id`. Tree-status candidates keep `index: null`. `recomputeCandidate` fires only when `targetId` OR `placement` OR `index` changed.
4. **Insertion preview** — new `DragInsertionContext` (`{ targetId, index }`), a SEPARATE context from `DragActive`/`DragCandidate` (render-storm discipline: index changes every few pixels but re-renders only the subscribing column). `KanbanCards` splices a 2px `bg-brand/80` rounded indicator bar at the insertion slot (including after the last card for append).
5. **Drop plumbing** — `completion.index` → `kanban-internal.destIndex` (new optional field on the outcome) → `handleKanbanMove.destIndex` (already `number | 'end'`; **no change** there — `undefined`/`'end'` appends). Tree-status drops stay index-less (`move-issue`).
6. **Same-status relaxation** — a kanban-column target passes through as `kanban-internal` even when it is the source status: the kanban handler's own guards decide (within-column reorder requires manual-sort mode; a drop back onto the card's own slot produces a redundant-but-harmless `bulkUpdateIssues` — accepted, the resolver cannot know the source's current index). Tree-status same-status remains a `no-op`.

Cards gain `data-dnd-card` + `data-dnd-card-issue-id` so the controller can hit-test column cards without a registry (the ghost uses a captured element, so no source-id attr existed before).

## Amendment (2026-08-03): extensibility to reorder drags

Consulted via @escalate-deepseek against two **future** requirements (owned, NOT implemented now):
(1) kanban **column reordering** (drag status columns left/right); (2) sidebar **project reordering**
(keep important projects on top). Verdict: as originally written, the design would need a ~60% rewrite
of `DragProvider` internals + hook signatures to support either. Six **type-level generalizations**
below cost nothing today (a one-variant union is behaviorally identical) and keep both features to
~50–100 lines each later. All six are folded into the Architecture section below and MUST be
implemented as part of this ADR.

1. **Discriminated `DragSource` (not a bare `{issueId, projectId}`)** — `DragState.activeDrag`
   carries a union, so `column-reorder`/`project-reorder` sources slot in without touching the
   provider's state machine.
2. **`placement` on the candidate** — `'on' | 'before' | 'after'`, computed by a vertical-third
   check of the target rect. Reorder needs relative placement (a column moved ONTO a column is
   nonsense); the proximity model stays single-candidate but gains the edge it needs. Today the
   resolver always sees `'on'` (no behavior change); the field is stored but unconsumed.
3. **`useDraggable(source: DragSource, opts)`** — signature takes a source object, not `(issueId,
   projectId)`. Issue rows pass `{kind:'issue-move', ...}`; future column/project rows pass their
   own variant, hook unchanged.
4. **`acceptKinds` on drop targets** — `useDropTarget(targetId, projectId, { acceptKinds? })`,
   default `['issue-move']`. The provider filters the registry against `activeDrag.kind`, so a
   project drag never highlights status/card targets and vice versa. Cards never register as
   targets, so no collision. Kanban columns register `['issue-move','column-reorder']` later.
5. **Custom `DragCompletion` replaces the hello-pangea `DropResult`** — the provider builds
   `{ source: DragSource, targetId, placement }`, not `{ draggableId:'issue:<uuid>', source,
   destination, ... }`. `resolveDragEnd` dispatches on `source.kind`; the `issue:` string-prefix
   check and the `index:0` fiction die with hello-pangea.
6. **Ghost source query by kind** — a `Record<DragKind, (id) => selector>` dispatch instead of a
   hardcoded `[data-tree-card=...]`.

## Context

Issue cards live in two views of the same project data: the sidebar **tree** (Tasks section → status columns → card rows, rendered by react-arborist 3.16 over a react-window virtualized list) and the **kanban board** (columns = statuses, cards = issues). The kanban interaction model demands drag-and-drop: move a card between statuses within one project across both surfaces.

Target flows:
1. tree status → tree status
2. tree card → kanban column
3. kanban card → tree status
4. kanban column → kanban column (with intra-column sort_order reorder)

Owner UX requirements:
- During a drag, **all valid drop targets are highlighted**.
- At any instant there is a **single proximity drop-candidate**; releasing the pointer over it performs the drop; releasing anywhere else snaps back.
- Release lands on the candidate (or a valid target under the cursor), never "between".

### Why hello-pangea failed (verified live)

`@hello-pangea/dnd` 18 was the initial choice (already a dependency, used by the kanban). A `Draggable` mounted **inside a react-arborist/react-window virtualized row never registers** in hello-pangea's internal registry: `useIsomorphicLayoutEffect` registration does not survive the row recycle (unmount/remount), so a mousedown hits `registry.draggable.getById` → **Invariant failed** → the drag never lifts and `onDragStart` never fires. Kanban cards (normal DOM, same `DragDropContext`) registered fine. Ruled out empirically: duplicate ids, multiple contexts, `isDragDisabled`, the native HTML5 `draggable` attribute (react-dnd inside react-arborist sets it), and store-identity churn.

Root cause is a **fundamental incompatibility between hello-pangea's registry lifecycle and react-window row recycling** — not a wiring bug.

### The interim custom-manager attempt (and why it's being replaced)

We built a hand-rolled global window-level drag manager for tree cards only (`packages/ui/src/components/outliner/treeDrag/`), keeping hello-pangea for the kanban, reusing a pure `resolveDragEnd` resolver and `bulkUpdateIssues`. It worked for tree→tree (verified live: highlights, candidate, `POST /v1/issues/bulk`, card moved) and fixed kanban-internal routing (bare-UUID draggableId → `issue:` prefix). But it left the app with **two competing drag systems** and real bugs:

- **Bug 1**: after one kanban-internal drag, the board DnD stops completely (custom manager's window listeners interfere with hello-pangea's sensor on subsequent drags).
- **Bug 2**: tree DnD moves the card in the backend but the UI only reflects it after ~20s (fallback polling); the fire-and-forget mutation never invalidates the shape collection.
- **Unverified**: kanban→tree (hello-pangea Droppable inside a virtualized tree status row may not detect drag-over from a kanban card).

Two systems owning one pointer lifecycle is the root of the remaining fragility. A design/creative exploration (2 designers, 2 reviewers, 1 brainstorm) converged on: **one drag system, state in React context (not a library registry, not window listeners), no hello-pangea**.

## Decision

Replace hello-pangea (both surfaces) AND the interim custom manager with a **single custom drag system built on React context**. Kanban nature dictates drag — we keep the interaction, we unify its implementation.

### Architecture

```ts
type DragKind = 'issue-move' | 'column-reorder' | 'project-reorder';

type DragSource =
  | { kind: 'issue-move'; issueId: string; projectId: string }
  // future: | { kind: 'column-reorder'; columnId: string; projectId: string }
  // future: | { kind: 'project-reorder'; projectId: string }

type DragCompletion = { source: DragSource; targetId: string; placement: 'on' | 'before' | 'after' };

type DragState = {
  activeDrag: DragSource | null;
  candidateTargetId: string | null;
  candidatePlacement: 'on' | 'before' | 'after' | null;
};

DragProvider (React context, mounted once above tree + kanban)
  state: DragState
  actions: startDrag(source: DragSource), cancel(), drop() → DragCompletion
  renders the drag GHOST via a portal to document.body
  owns window-level mousemove/mouseup/keydown(Esc) while a drag is active
  computes the single proximity candidate via Manhattan distance to registered target rects
    (with vertical-third placement: top/bottom 33% → 'before'/'after', middle → 'on')
  filters the target registry by acceptKinds matching activeDrag.kind

useDraggable(source: DragSource, { disabled })   // tree cards AND kanban cards (future: columns, project rows)
  mousedown → 5px threshold → startDrag(source)
  no DOM node owns the drag; state lives in the provider

useDropTarget(targetId, projectId, { acceptKinds? })  // tree status rows AND kanban columns
  default acceptKinds = ['issue-move']
  registers { id, projectId, getBoundingClientRect, acceptKinds } in the provider's target map
  highlights: ring-1 on all valid targets while dragging, ring-2 on the candidate
```

Key properties:

1. **State in context, not in a registry or the DOM.** Row recycling (react-window) cannot lose the drag — the provider outlives rows; sources hold `issueId` by value.
2. **One pointer lifecycle.** No hello-pangea sensor, no second manager — the provider owns all mousedown/mousemove/mouseup. Eliminates Bug 1 structurally.
3. **Drop resolution reuses the existing pure `resolveDragEnd`** (web-core), re-typed: the provider builds a `DragCompletion` (amendment 5) and feeds it to the same handler, which now dispatches on `source.kind`. `issue-move` keeps the current logic: parse target as status, cross-project guard, same-status no-op, `kanban-internal` (both ends kanban columns) delegates to the kanban reorder path; everything else is `move-issue` → `bulkUpdateIssues`. `column-reorder` / `project-reorder` are stub branches returning `invalid` until implemented.
4. **Optimistic feedback (fixes Bug 2).** On drop, the UI updates immediately (kanban: local `setItems`; tree: shape invalidation), then the REST call runs, with rollback on failure. The 30s fallback polling becomes a safety net, not the primary refresh path.
5. **Proximity = single candidate.** `manhattanDistanceToRect(pointer, rect)` clamped to edges (inside ⇒ 0 ⇒ candidate), `DROP_THRESHOLD_PX = 32` magnetic radius, `DRAG_THRESHOLD_PX = 5` to promote a press into a drag. Candidate carries `placement` (vertical-third of the target rect; amendment 2 — currently always `'on'`, consumed only by future reorder kinds). Linear scan — target count is ~10–20 (per-project statuses + columns), so binary search/spatial indexing is explicitly rejected as overengineering (revisit only past ~100 targets).
6. **Targets are the stable containers, not the virtualized cards.** Tree status rows and kanban columns register; cards are drag sources only. This is why virtualization is a non-issue: the containers do not recycle. Future project rows register as sources AND as `acceptKinds:['project-reorder']` targets (reorder = before/after a neighbour project).
7. **Ghost** via a pure DOM clone of the captured source element (no React re-render per frame): `pointer-events: none`, position updated by direct `transform` mutation. The source element is captured from `useDraggable`'s `onMouseDown` `e.currentTarget` at press time — NOT via a DOM query (avoids colliding with a same-issue card rendered in the other surface; supersedes the amendment-6 `Record<DragKind, selector>` dispatch).
8. **Click-vs-drag disambiguation**: sub-threshold mouseup falls through to the row click (navigate/toggle); after a real drag, a one-shot capture-phase click swallower prevents react-arborist from navigating to the dragged card.
9. **Guards**: `e.button !== 0`, mousedown on the caret `<button>` ignored, `isMultiSelectActive` disables, ESC cancels (during press and drag), `user-select: none` during drag restored in `try/finally`, `destroy()` removes window listeners (StrictMode/HMR safety).

### Removed

- `@hello-pangea/dnd`: `DragDropContext`, `Draggable`, `Droppable`, `KanbanProvider` wrapper, `KanbanDragHandlerContext` bridge, all `data-rfd-*` attributes.
- The interim `TreeDragManager` window-listener manager (its geometry + ghost + candidate logic is folded into `DragProvider`).

### Kept

- `resolveDragEnd` (pure resolver) and its tests — the single drop-decider for both surfaces, re-typed to accept `DragCompletion` and dispatch on `source.kind` (stub branches for future reorder kinds).
- The proximity geometry (`manhattanDistanceToRect` / `findBestCandidate` + the vertical-third `placement`), the `ring-1`/`ring-2` highlight classes, the `[data-drop-target-id]`/`[data-drop-target-project]` DOM convention.
- `bulkUpdateIssues` as the one write path; kanban's existing intra-column `sort_order` reorder logic.

## Consequences

### Positive

- One drag system, one mental model (~300 lines, zero heavy deps).
- Survives react-arborist virtualization (state in context).
- Fixes the three known bugs structurally: kanban freeze (no competing sensors), 20s staleness (optimistic + invalidation), kanban→tree (unified target detection, no hello-pangea droppable in virtualized rows).
- Unit-testable in jsdom by firing pointer events — no hello-pangea sensor/DOM requirements.
- Keyboard/mobile remain out of scope V1 (mouse-only), documented.

### Negative / accepted

- We lose hello-pangea's battle-tested sensor stack (autoscroll, drop animations, touch/keyboard). V1 is mouse-only; autoscroll during drag is explicitly out of scope (targets re-query live `getBoundingClientRect` each frame, so scrolling is naturally handled without a velocity engine).
- Intra-kanban reorder now goes through our own path — must preserve `sort_order` recalculation from the old handler.
- `resolveDragEnd`'s `tree-card` droppable branch is removed entirely (cards are no longer drop targets); a bare-UUID targetId that resolves to an issue is rejected as `invalid: 'not a drop target'` (defensive).

### Risks

- Regressing kanban-internal reorder (sort_order) — covered by migrating the existing handler + tests.
- Click-after-drag navigation — covered by the one-shot click swallower.
- Ghost context isolation — the clone is pure DOM, no React context needed.

## Implementation status + deviations (2026-08-03)

**DONE, verified live** (all four flows, highlights, candidate, no reload-free staleness, consecutive kanban drags work — the two prior bugs are closed). Tests: ui 124, web-core 82; tsc + build green. New module `packages/ui/src/components/dnd/` (`types`, `geometry`, `DragController`, `DragContext`, `DragProvider`, `useDraggable`, `useDropTarget`); `treeDrag/` deleted.

Deviations from the decision text, all accepted:

1. **Ghost source = captured element**, not a DOM query (see property 7). The `data-tree-card` attribute is gone.
2. **`onDragEnd` callback added** to `DragControllerCallbacks` (fires on cancel AND drop). Fixes a latent bug where an ESC-cancel left the drag-active flag stuck true.
3. **`DragKind` union already includes** `'column-reorder' | 'project-reorder'` (types only); `resolveDragEnd` returns `invalid: 'unsupported drag kind'` for them.
4. **`resolveDragEnd` re-typed to `DragCompletion`** (amendment 5); the `issue:` draggable-id prefix and hello-pangea type dependency are gone from the resolver. The `tree-card` surface is removed (see above).
5. **kanban-internal position model**: custom drags carry no index (`destIndex` defaults to `'end'` → append). Same-status drops are `no-op`. The legacy **list view** keeps positional reorder via its own `DragDropContext` in `KanbanContainer` + an adapter (`DropResult` → `KanbanMove` with numeric `destIndex`); within-column positional reorder still requires manual-sort mode, exactly as before.
6. **hello-pangea is NOT fully removed.** It remains for: the list-view adapter (`KanbanContainer.tsx`), the sub-issues section (`IssueSubIssuesSectionContainer`), settings status reorder (`RemoteProjectsSettingsSection`), the `IssueList*`/`SubIssueRow` row components, and the `DropResult` re-export in `KanbanBoard.tsx`. The dependency stays in `packages/ui/package.json`. Full removal = follow-up task (convert those surfaces to the unified system or accept their legacy DnD).
7. **`handleKanbanMove` guards**: same-status + numeric index requires manual sort (legacy reorder); same-status + `'end'` = no-op; cross-column always allowed. Bulk-update builder skips the source-column recalc when `fromStatusId === toStatusId` (no duplicate writes).

## Implementation notes (build order)

1. Extract `DragProvider` from the interim manager: state machine (`DragState`, discriminated `DragSource`), target registry (with `acceptKinds`), candidate calc (+ `placement`), `buildDragCompletion`, ghost, click-swallow, optimistic drop.
2. `useDraggable(source, opts)` for tree cards (replace `useTreeCardDrag`/interim hook) and kanban cards (replace hello-pangea `Draggable`).
3. `useDropTarget(targetId, projectId, opts)` for tree status rows (replace the hello-pangea `Droppable`) and kanban columns (replace `Droppable`).
4. Remove hello-pangea entirely (context, provider, bridge, attrs, KanbanProvider refactor) and re-type `resolveDragEnd` onto `DragCompletion` (drop the `issue:` prefix dispatch).
5. Optimistic update: kanban `setItems` + tree shape invalidation after `bulkUpdateIssues`.
6. Migrate tests: interim manager tests → `DragProvider` tests; hello-pangea tree/kanban tests → hook tests. Keep `resolveDragEnd` tests (re-typed).
7. Live smoke: all four flows, highlights, candidate, snap-back, reload-free updates, ESC, click-vs-drag, caret, multi-select.
8. (NOT now, ownership noted) kanban column reorder + project reorder: each = add a `DragSource` variant, `acceptKinds` on targets, one `buildDragCompletion` branch, one `resolveDragEnd` branch, one ghost-query entry — no provider/hook rewrite.
