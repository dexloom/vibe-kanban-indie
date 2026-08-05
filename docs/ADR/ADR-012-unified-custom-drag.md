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
3. **Controller resolution** — resolved per rAF frame for `issue-move` candidates over kanban columns only: post-hoc `querySelector` of the target column, its `[data-dnd-card]` children measured live (fresh `getBoundingClientRect`; see amendment below — round-4 dropped the target rect cache, every frame re-queries the DOM), the dragged source card excluded via `data-dnd-card-issue-id`. Tree-status candidates keep `index: null`. `recomputeCandidate` fires only when `targetId` OR `placement` OR `index` changed.
4. **Insertion preview** — new `DragInsertionContext` (`{ targetId, index }`), a SEPARATE context from `DragActive`/`DragCandidate` (render-storm discipline: index changes every few pixels but re-renders only the subscribing column). `KanbanCards` splices a 2px `bg-brand/80` rounded indicator bar at the insertion slot (including after the last card for append).
5. **Drop plumbing** — `completion.index` → `kanban-internal.destIndex` (new optional field on the outcome) → `handleKanbanMove.destIndex` (already `number | 'end'`; **no change** there — `undefined`/`'end'` appends). Tree-status drops stay index-less (`move-issue`).
6. **Same-status relaxation** — a kanban-column target passes through as `kanban-internal` even when it is the source status: the kanban handler's own guards decide. The custom drag controller ALWAYS emits a numeric `index` for kanban-column hits (kanban columns register `acceptKinds:['issue-move']` and the controller computes a midpoint-split slot), so `destIndex === null` is not how same-status no-ops work. In **non-positional sort mode** (the default), `handleKanbanMove` short-circuits same-status moves via its `isManualSort` guard — no backend write, no UI change. In **manual-sort mode**, the same handler performs a real intra-column reorder and the legacy list-view adapter (still on its own hello-pangea `DragDropContext`) provides the numeric `destIndex` via the `DropResult → KanbanMove` adapter. Tree-status same-status remains a `no-op` in `resolveDragEnd` itself.

Cards gain `data-dnd-card` + `data-dnd-card-issue-id` so the controller can hit-test column cards without a registry (the ghost uses a captured element, so no source-id attr existed before).

## Amendment (2026-08-03, round-4 corrections): cursor, target re-query, drag-end semantics

Three corrections surfaced in the round-4 review:

1. **Cursor via body class, not inline style** — `DragController.promote()` toggles `body.dnd-dragging` and `teardown()` removes it. The global stylesheet ships `body.dnd-dragging, body.dnd-dragging * { cursor: grabbing !important; }`. Why: the source card sits under the pointer during a drag and its own `cursor: auto` rule would beat an inline body style; an inline body style would visibly revert to `default` over the card. The wildcard override re-asserts `grabbing` on every descendant regardless of component-level rules. The card itself no longer ships a `cursor-default` class (round-4 #2); the natural `auto` is correct outside a drag.
2. **Drop targets re-queried per frame, no cache** — `collectTargets` no longer caches. Every call re-runs the DOM `querySelectorAll` against `[data-drop-target-id][...]`. The previous cache + `scroll`/`resize`-based invalidation left a status column mounted mid-gesture (shape sync) invisible until the next scroll. A shape sync that adds a column now becomes a candidate on the very next mousemove with no scroll/resize event required. The per-call `elements` map is preserved so `resolveCardIndex` still gets an O(1) element lookup within that call. ADR property 5 ("linear scan is cheap") is unchanged — the per-frame DOM query is itself the linear scan. `scroll`/`resize` listeners are gone.
3. **`onDragEnd` fires only for an actual drag** — `cancel()` captures `wasDragging = state.kind === 'dragging'` before teardown and only calls `callbacks.onDragEnd()` when true. A sub-threshold mouseup or ESC during a press (gesture never lifted) is silent on `onDragEnd`. The previous behavior fired `onDragEnd` for every gesture, including never-a-drag, which made the provider's active flag need a false negative reset. `cancel()` still runs `teardown()` and `removeAllListeners()` for all paths — the change is purely about the `onDragEnd` callback.

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
5. **kanban-internal position model**: custom drags carry a numeric `index` (controller always emits one for kanban-column hits); `handleKanbanMove` decides whether to act on it. Same-status kanban-column drops in **non-positional sort mode** are no-ops via `handleKanbanMove`'s `isManualSort` guard (the `destIndex` is irrelevant to that gate); in **manual-sort mode** the legacy list view (still on its own hello-pangea `DragDropContext`) provides a numeric `destIndex` via the `DropResult` → `KanbanMove` adapter, and `handleKanbanMove` performs the intra-column reorder.
6. **hello-pangea is NOT fully removed.** It remains for: the list-view adapter (`KanbanContainer.tsx`), the sub-issues section (`IssueSubIssuesSectionContainer`), settings status reorder (`RemoteProjectsSettingsSection`), the `IssueList*`/`SubIssueRow` row components, and the `DropResult` re-export in `KanbanBoard.tsx`. The dependency stays in `packages/ui/package.json`. Full removal = follow-up task (convert those surfaces to the unified system or accept their legacy DnD).
7. **`handleKanbanMove` guards**: same-status + numeric index requires manual sort (legacy reorder); same-status + `'end'` = no-op; cross-column always allowed. Bulk-update builder skips the source-column recalc when `fromStatusId === toStatusId` (no duplicate writes).

## Round-4 corrections (2026-08-03)

Review surfaced four follow-up bugs and a handful of smells. All four bugs fixed; smells 4–10 addressed; deviations list updated to keep ADR truthful:

8. **Cursor via body class, not inline body style** — round-4 #2: `DragController` toggles `body.dnd-dragging`; global stylesheet ships the `!important` wildcard override; `KanbanCard` no longer carries a `cursor-default` class.
9. **Drop target cache dropped** — round-4 #3: `collectTargets` re-queries the DOM every call. `scroll`/`resize` listeners removed. A status column mounted mid-drag becomes a candidate on the next mousemove with no scroll/resize event.
10. **`onDragEnd` no longer fires on sub-threshold / press-stage gestures** — round-4 #4: `cancel()` captures `wasDragging` before teardown and only invokes the callback for an actual drag.
11. **`KanbanCards.renderedChildren` memo is now live** — round-4 #1: `cardChildren` memoized via `React.useMemo` (the prior code called `React.Children.toArray` inline, defeating the memo). The splice logic is hoisted into a named module function `spliceInsertionIndicator` (also called via the module namespace so a test `vi.spyOn` can observe it).
12. **`KanbanMove` / `KanbanDragHandler` moved to `model/kanbanMove.ts`** — round-4 #6: pure logic no longer imports React wiring. The context module re-exports both for call-site compatibility.
13. **`isKanbanColumnTarget` renamed to `isColumnLikeTarget`** — round-4 #7: the predicate returns true for any non-tree-status id (including `proj:tasks`, `workspace-42`); the old name implied it returned true only for kanban columns. The doc comment now states what the predicate actually means.
14. **`treeReadyRef` write moved out of render** — round-4 #8: the latch that the auto-open / replay effects depend on is now an effect, not a render-time ref write.
15. **`computePlacement(x, y, r)` lost its `_x`** — round-4 #9: the parameter was unused; signature is now `computePlacement(y, r)`. Re-added when column reorder lands.
16. **Insertion-indicator test selector stable** — round-4 #10: indicator divs carry `data-dnd-insertion-indicator=""`; tests select by that attribute instead of the brittle `className.split(' ')[0]` assumption.

Tests after round-4: ui 170 (was 167; +3 for the new cursor / mid-drag-mount / memo regression tests), web-core 106 (unchanged). `pnpm check` + `pnpm --filter @vibe/local-web run build` green.

## Round-5 UX enhancement (2026-08-03): push-apart placeholder + source card dim

Two visual upgrades to the live insertion preview. Drop semantics, controller state machine, single-candidate model, drop resolver — all unchanged.

17. **Push-apart insertion placeholder** — the 2px `bg-brand/80` bar becomes a **card-sized slot**: `border-2 border-dashed border-brand/60 bg-brand/5`, `shrink-0`, `mx-2`, with `style.height` set to the first card's measured `getBoundingClientRect().height`. Empty columns fall back to `60px`. The slot is rendered inline in `KanbanCards` (the named `spliceInsertionIndicator` helper is removed — the placeholder needs the measured height and the module-namespace spy test was the only consumer). `data-dnd-insertion-indicator` is preserved on the new element (tests + the controller's DOM contract both rely on it). Cards below the slot push down naturally via flex-column; the visual result is "this card lands here" rather than "an indicator exists near this card". Height measurement is folded into the existing `useLayoutEffect` (one DOM query, shared with the source-index lookup) so no extra pass. `positionalReorderEnabled=false` still suppresses the preview.
18. **Source card dim** — the dragged source card applies `opacity-50 transition-opacity` for the duration of the drag. The source id lives in a new **`DragSourceContext`** (`string | null`), fed by `DragProvider` from `candidate.sourceIssueId` (constant within a drag, set on first candidate change, cleared on `onDragEnd`). Kept separate from `DragInsertionContext` because the source column has no live insertion while the pointer is over a different column — a single context would force every source-column card to subscribe to insertion changes it doesn't care about, defeating the existing render-storm split. The 1-frame gap between `onPromote` and the first `onCandidateChange` is invisible.

Tests after round-5: ui 172 (was 170; +4 new — placeholder-height measurement, empty-column fallback, source-dim dim, source-dim no-drag-noop; −2 removed — the deleted `spliceInsertionIndicator` pure-helper test and its memo-regression spy). `pnpm check` + `pnpm --filter @vibe/local-web run build` green.

## Amendment (2026-08-04): project-reorder interaction model — swap, not before/after

Owner requirement: drag-and-drop reorder of top-level projects in the sidebar tree via the unified custom DnD system. The model is **SWAP**: when a dragged project enters another project row's zone, they swap positions (dragged takes target's slot, target takes dragged's old slot). No placement / before / after / midpoint. Project order persists to the backend via `bulkUpdateProjects` writing `sort_order`; the tree derives order from `PROJECTS_SHAPE` via `sortProjectsByOrder`.

Consulted via @escalate-glm. Extends the ADR's existing extensibility surface (round-3 amendment: discriminated `DragSource`, `acceptKinds`, customizable target id) without disturbing the issue-move flow:

1. **`DragSource` gains `project-reorder`** — `{ kind: 'project-reorder'; projectId: string }`. Variant lives on the same `DragSource` union; consumers narrow via `kind`. No new hook; `useDraggable({kind:'project-reorder', projectId}, {disabled})` is the binding.
2. **`Candidate` gains `sourceProjectId: string | null`** — mirror of `sourceIssueId` for project-reorder drags. Controller sets it on the first candidate change (constant within a drag); teardown clears it. Provider carries it as `DragSourceProjectContext` (a new `string | null` context, parallel to `DragSourceContext`) so project rows can dim themselves while a peer is being dragged without forcing them to subscribe to `DragInsertionContext` changes they don't care about.
3. **`project-reorder` targets are OTHER project rows** — each project row registers as `useDropTarget(project.id, project.id, {acceptKinds:['project-reorder']})`. The dragged source row is excluded via `data-drop-target-id === source.projectId` (self-exclusion) — NOT the equality filter (`data-drop-target-project === source.projectId`) that issue-move uses, since every project row's `data-drop-target-project` IS its OWN id, which would reject every peer.
4. **Resolver branch runs BEFORE the issue-move path** — `resolveDragEnd` checks `source.kind === 'project-reorder'` first; same-id and unassigned targets return `no-op`. Otherwise it returns `{ type: 'project-reorder', projectId, targetProjectId }`. The signature is unchanged (the project-reorder branch ignores `activeProjectId` / `issuesById` / `statusIds`; those params are no-ops for this kind).
5. **`placement` / `index` ignored for project-reorder** — `DragController.buildDragCompletion` always emits `placement:'on'` and forwards `this.candidate.index` (null for project-reorder; the geometry/index branch stays gated on issue-move). Downstream the placement field is unconsumed; layout only reads `source` and `targetId` to identify the swap pair.
6. **Unassigned is inert** — the `UNASSIGNED_PROJECT_ID` row registers no drop-target attributes and `useDraggable` is called with `{ disabled: true }`. The resolver rejects unassigned as a target anyway (defence in depth). Layout never rewrites the order array based on a drop that touches unassigned.
7. **Persist via whole-list rewrite, not pairwise update** — on drop the layout updates the optimistic `orderedProjects` state with a swap, then sends `bulkUpdateProjects(updates)` where `updates = swapped.map((p, i) => ({ id: p.id, changes: { sort_order: i * STEP } }))` with `STEP=100`. Recomputing ALL projects (not just the pair) normalizes the field: default `sort_order=0` on every project makes a pairwise swap a no-op under the created_at tiebreak in `sortProjectsByOrder`; the rewrite defeats the tiebreak by ordering the written values monotonically. `refreshShapeSource(PROJECTS_SHAPE, {organization_id: orgId})` runs on both success and failure so the tree re-derives on its own if the backend rejects the write.
8. **Test surface** — `DragController.test.ts` asserts (a) a project-reorder source collects OTHER project rows as targets (peer included, self excluded) and (b) `candidate.sourceProjectId` is set for project-reorder and null for issue-move. `resolveDragEnd.test.ts` covers swap semantics: project-reorder onto a different project id → outcome; same id → `no-op`; unassigned target → `no-op`; issue-move behaviour is unchanged. `treeNodes.test.tsx` asserts `data-drop-target-accept-kinds="project-reorder"`, the unassigned row has no drop attributes, and the source row carries `opacity-50` when `DragSourceProjectContext` matches. `makeCompletion(sourceId, targetId, projectId, index, kind)` gains an optional 5th `kind` argument so existing issue-move call sites keep their positional signatures; project-reorder call sites pass `'project-reorder'`.

Tests after the amendment: ui 179 (was 172; +3 DragController, +4 treeNodes); web-core 110 (was 106; +4 resolveDragEnd). `pnpm check` + `pnpm --filter @vibe/local-web run build` green.

Implementation note: `KanbanBoard.tsx`'s `KanbanCardProps.source` is narrowed from `DragSource` to `Extract<DragSource, { kind: 'issue-move' }>` so card-only code reaches `.issueId` without a runtime guard (the new variant doesn't reach card rows; project rows have their own renderer).

## Implementation notes (build order)

1. Extract `DragProvider` from the interim manager: state machine (`DragState`, discriminated `DragSource`), target registry (with `acceptKinds`), candidate calc (+ `placement`), `buildDragCompletion`, ghost, click-swallow, optimistic drop.
2. `useDraggable(source, opts)` for tree cards (replace `useTreeCardDrag`/interim hook) and kanban cards (replace hello-pangea `Draggable`).
3. `useDropTarget(targetId, projectId, opts)` for tree status rows (replace the hello-pangea `Droppable`) and kanban columns (replace `Droppable`).
4. Remove hello-pangea entirely (context, provider, bridge, attrs, KanbanProvider refactor) and re-type `resolveDragEnd` onto `DragCompletion` (drop the `issue:` prefix dispatch).
5. Optimistic update: kanban `setItems` + tree shape invalidation after `bulkUpdateIssues`.
6. Migrate tests: interim manager tests → `DragProvider` tests; hello-pangea tree/kanban tests → hook tests. Keep `resolveDragEnd` tests (re-typed).
7. Live smoke: all four flows, highlights, candidate, snap-back, reload-free updates, ESC, click-vs-drag, caret, multi-select.
8. (NOT now, ownership noted) kanban column reorder + project reorder: each = add a `DragSource` variant, `acceptKinds` on targets, one `buildDragCompletion` branch, one `resolveDragEnd` branch, one ghost-query entry — no provider/hook rewrite.

## Pass-2 review (2026-08-04): architecture notes + TO RESOLVE

Independent pass-2 review (full session scope) scored the system 8.5/10 and surfaced
six architecture notes for the DnD surface. Five are fixes that keep the current
architecture; one (pointer events) is an interaction-layer upgrade that changes the
controller's event source. Each is recorded here with its **TO RESOLVE** marker —
resolution = implementing the fix described.

- **TO RESOLVE — same-column swap gated on sort mode**: a same-column swap is only
  meaningful under `sortField === 'sort_order'`. Under `priority`/`created_at`/`title`
  sort, the shape-sync re-sorts the column and the persisted swap is invisible (silent
  REST write with no UX effect). Fix: gate the swap branch in `handleKanbanMove` on
  `kanbanFilters.sortField === 'sort_order'` (short-circuit to no-op otherwise).
- **TO RESOLVE — pointer events for touch (B2)**: the controller listens to
  `mousedown`/`mousemove`/`mouseup` only, so touch-hold-drag never promotes on mobile
  even though the mobile drag handle is rendered. Decision (owner): migrate the
  controller + `useDraggable` to **Pointer Events** (`pointerdown`/`pointermove`/
  `pointerup`/`pointercancel`), which unifies mouse + touch + pen. `click` swallowing
  stays (synthetic clicks still fire after pointer gestures).
- **TO RESOLVE — `isSyncingRef` race on rapid swaps (B3)**: `isSyncingRef` is a boolean
  cleared by the FIRST settle; a second swap fired inside the sync window gets its
  optimistic `setItems` overwritten when the first refresh lands. Fix: a numeric
  in-flight counter (`isSyncingCount++`/`--`, gate on `> 0`) instead of a boolean.
- **TO RESOLVE — strict `persistIssues` typing (E5)**: the helper's param is
  `{id;changes:Record<string,unknown>}[]` cast to `Parameters<typeof bulkUpdateIssues>[0]`,
  defeating type safety. Fix: type the param as `BulkUpdateIssueItem[]`.
- **TO RESOLVE — single card-detection rule (D1)**: card-vs-column is discriminated two
  ways (`isCardTarget` on `data-drop-target-status` vs `el.hasAttribute('data-dnd-card')`
  in `resolveColumnInsertIndex`). Fix: use `isCardTarget(el)` everywhere.

Lower-severity hardening from the same pass (recorded; fixes are the noted actions):

- **TO RESOLVE — same-status kanban-internal leaks a full-column write (E1)**: the
  resolver has no same-status guard for the kanban surface (tree-status has one); if a
  same-status kanban-internal ever leaks, `handleKanbanMove`'s gate (`from === to &&
  move.index === undefined`) does not fire for `index: null`, and every column card gets
  a sort_order write. Fix: `no-op` in `resolveDragEnd` when
  `surface === 'kanban' && statusId === issue.status_id && index == null`.
- **TO RESOLVE — asymmetric snapshot invalidation (E2/E3)**: `sourceCardRects` freezes at
  promote and never invalidates; `targetColumnRects` invalidates on scroll/resize but not
  on realtime card adds. Fix: invalidate `sourceCardRects` on scroll/resize too, and
  re-snapshot `targetColumnRects` when the live card count diverges from the cached one.
- **TO RESOLVE — move-preview clone keeps `data-dnd-card-issue-id` (E4)**: the clone
  strips `data-dnd-card`/`data-drop-target-id`/`data-drop-target-status` but not
  `data-dnd-card-issue-id`; a clone before the source card in DOM order could be cloned
  again. Fix: strip the issue-id attr too.
- **TO RESOLVE — `orderedProjectsRef` optimistic/persist divergence (E6)**: the
  optimistic `setOrderedProjects` uses the React updater's `prev` while the persisted
  `bulkUpdateProjects` reads `orderedProjectsRef.current`; concurrent project-list
  updates can diverge. Fix: compute the swapped array once and feed it to both.
- **TO RESOLVE — `computeKanbanMove` cross-status dedupe (E7)**: a cross-status move
  splices the issue into the destination without filtering it out first; a corrupted
  local state with the id already present creates a duplicate. Fix: filter `issueId`
  from the destination before splicing.
- **TO RESOLVE — extract `persistIssueSwap` (D2)**: the kanban swap REST shape
  (`status_id` + `sort_order` exchange) is duplicated in `KanbanContainer`'s swap branch
  and `SharedAppLayout`'s issue-swap fallback. Fix: move into `persistIssues.ts` as a
  dedicated helper; both call sites use it.
- **TO RESOLVE — drop the `?? null` on `completion.index` (D3)**: `DragCompletion.index`
  is already `number | null`; `index: completion.index ?? null` is redundant.
- **TO RESOLVE — narrow `parsedDest.projectId!` (D4)**: the `move-issue` branch relies on
  branch order for `projectId` being set. Fix: guard + return `invalid` when absent.
- **TO RESOLVE — stable move-preview clone ref (D6)**: the preview effect re-runs on
  every `candidateIndex` change (~120 DOM ops/s while dragging across a column). Fix:
  keep a stable clone element ref and reposition it via `insertBefore` when only the
  index changed.

Noted as follow-up, NOT fixed in this pass (deferred, see below):

- **Follow-up — Pointer Events ADR (A1)**: fully covered by the pointer-events fix above
  when it lands; no separate ADR needed — the migration IS the resolution.
- **Follow-up — integration test across the full drop path (A2)**: DragController →
  resolveDragEnd → KanbanDragHandlerContext → handleKanbanMove → computeKanbanMove →
  persistIssues is only unit-tested in slices. A single end-to-end test asserting "drop
  card A on card B in the same column ⇒ exactly two `bulkUpdateIssues` writes with
  swapped `status_id` + `sort_order`" is outstanding.
- **Follow-up — snapshot lifecycle assumption (A3)**: the system assumes geometry is
  stable for the drag duration; source freezes once, target invalidates on scroll/resize.
  Realtime shape sync mid-drag can stale either. Tracked here as an accepted trade-off;
  a future invalidation policy (E2/E3) reduces the window.

## Pass-2 resolution status (2026-08-04)

All **TO RESOLVE** items above are resolved in this pass (the B1–B3, E1–E7, D1–D6
fixes). Deferred follow-ups: A2 (integration test), A3 (snapshot lifecycle ADR) — see
the notes above.

## Pass-3 review (2026-08-04): preview/commit agreement + pointer completeness

Pass-3 scored 9.0/10. Three blockers and one edge are resolved in this pass. Every
remaining deferred item is recorded below with a **TO RESOLVE** marker so the gaps are
never silently forgotten.

- **TO RESOLVE — swap preview gated on sort mode (P3-B1)**: pass-2 gated the swap COMMIT
  on `sortField === 'sort_order'` but not the swap PREVIEW (`KanbanCards.isSwapPreview`).
  Under priority/created_at/title sort the user sees a live swap then a snap-back with
  no commit — preview and commit disagree. Fix: plumb `positionalReorderEnabled` (the
  `sortField === 'sort_order'` flag) into `KanbanCards` and gate BOTH `isSwapPreview` and
  the cross-column move-preview clone on it. Implemented this pass.
- **TO RESOLVE — `touch-action: none` on draggables (P3-B2)**: Pointer Events without
  `touch-action: none` let the browser absorb the gesture into scrolling, so no
  `pointermove` reaches the controller on touch. The mobile drag handle renders but is
  inert. Fix: `touch-action: none` on `KanbanCard`, `CardNodeRow`, and the project-row
  `TreeRow`. Implemented this pass.
- **TO RESOLVE — `pointerId` tracking (P3-B3)**: the controller listens on `window`
  without filtering by `pointerId`; two fingers (or pen + mouse) overwrite
  `lastClientX/Y` and the first `pointerup` ends the drag. Fix: capture `e.pointerId` in
  `startPress`, ignore non-matching events in move/up/cancel, clear on teardown.
  Implemented this pass.
- **TO RESOLVE — `persistIssues` double-refresh / misattributed error (P3-E1)**: the
  `.then(refresh).catch(refresh)` chain treats a refresh failure as a bulk failure
  (wrong `onError`) and refreshes twice. Fix: make refresh failure non-fatal
  (`bulkUpdateIssues(...).then(() => refresh().catch(() => {})).catch(...)`).
  Implemented this pass.
- **TO RESOLVE — swap-preview key fallback parses React internals (P3-E5)**: when
  `issueIds` is absent/length-mismatched, `displayChildren` parses React's `.$` key
  prefix. `KanbanContainer` always passes `issueIds` today, so the fallback is defensive;
  consider throwing on absence in a later pass.

Deferred — **TO RESOLVE** (recorded, NOT fixed in this pass):

- **TO RESOLVE — end-to-end drop integration test (A2)**: DragController →
  resolveDragEnd → KanbanDragHandlerContext → handleKanbanMove → computeKanbanMove →
  persistIssues is only unit-tested in slices. Outstanding: "drop card A on card B in the
  same column ⇒ exactly two `bulkUpdateIssues` writes with swapped `status_id` +
  `sort_order`".
- **TO RESOLVE — snapshot lifecycle ADR (A3)**: system assumes geometry stable for the
  drag duration. Realtime shape sync mid-drag can stale source/target snapshots. Accepted
  trade-off; E2/E3 reduce the window.
- **TO RESOLVE — `KanbanContainer` monolith (1306 lines)**: mixes kanban rendering,
  multi-select, dispatch, legacy list-view adapter, DnD handler registration. Split into
  `KanbanContainer` (render) + `useKanbanDnDHandler` + multi-select hook.
- **TO RESOLVE — `handleCrossSurfaceDragEnd` state-machine-in-a-switch**: inline
  side-effects per outcome. Extract pure per-outcome persisters
  (`persistKanbanInternal`, `persistIssueSwapFallback`, `persistCrossSurfaceMove`,
  `persistProjectReorder`) into a `dndPersisters.ts`; the switch becomes a dispatch.
- **TO RESOLVE — `bulkUpdateProjects` inline persist**: project-reorder still inlines
  `bulkUpdateProjects(...).then(...).catch(...)`; extract `persistProjectReorder` next to
  `persistIssueSwap` (rename `persistIssues.ts` → `persistDrag.ts`).
- **TO RESOLVE — `isColumnTarget` dead export (P3-DRY1)**: `isColumnTarget` in
  `targetKind.ts` has no production consumers; remove or keep with a symmetry comment.
- **TO RESOLVE — move-preview clone stale after render (P3-E7)**: effect B positions the
  clone against a snapshot of `col.children`; a shape-sync render landing between effects
  A and B could place it a slot late. Consider `useLayoutEffect` for positioning.

## Pass-3 resolution status (2026-08-04)

Resolved this pass: **P3-B1** (preview gated on sort mode), **P3-B2** (`touch-action:
none`), **P3-B3** (`pointerId` tracking), **P3-E1** (`persistIssues` refresh-error
handling), plus regression tests for each. Deferred with **TO RESOLVE** markers: A2
(integration test), A3 (snapshot lifecycle ADR), KanbanContainer monolith, dndPersisters
extraction, `persistProjectReorder`, `isColumnTarget` dead export, move-preview clone
stale-slot guard.

## Pass-4 review (2026-08-04): two independent reviewers — sort-mode gates + robustness

Two independent reviewers scored 9.0–9.3/10. All findings below are recorded with
**TO RESOLVE** markers and resolved in this pass.

- **TO RESOLVE — cross-column move COMMIT gated on sort mode (P4-B1)**: P3-B1 gated the
  swap commit and both previews, but the cross-column MOVE commit still does a positional
  insert + full-column `sort_order` rewrite under non-`sort_order` sort → optimistic flash
  then shape-sync jump, plus a meaningless persisted `sort_order`. Fix: under
  `!isManualSort`, drop the insertion index (append) and write only `{ status_id }` for
  the destination column (no `sort_order`).
- **TO RESOLVE — mobile: whole-card drag vs handle (P4-E1)**: `touch-action: none` +
  `onPointerDown` sit on the whole `KanbanCard`; the `DotsSixVerticalIcon` handle is
  purely visual, so on touch the board can't scroll by swiping a card (drag wins). Fix:
  on `isMobile`, bind the DnD handler + `touch-action: none` to the handle only; desktop
  keeps whole-card drag.
- **TO RESOLVE — `isSyncingCountRef` timeout safety (P4-BUG1)**: if `bulkUpdateIssues`
  never settles (network drop), the counter stays >0 forever and the board is frozen
  (items-rebuild effect gated on it). Fix: 10s timeout that decrements the counter if
  `onSettled` hasn't fired.
- **TO RESOLVE — `sourceColumnEl` null fallback (P4-BUG2)**: when the source element is
  null, `sourceCardRects` is empty and `isPointerOverSource` always returns false —
  self-drop detection silently breaks. Fix: fall back to `elementFromPoint` +
  `[data-dnd-card-issue-id]` match when the snapshot lacks the source card.
- **TO RESOLVE — `isColumnTarget` dead export (P4-DRY1)**: remove from `targetKind.ts`
  and `index.ts` (zero consumers).
- **TO RESOLVE — `useDraggable` focus swallowing (P4-E2)**: `e.preventDefault()` on
  pointerdown blocks focus on non-`<button>` interactive children (anchors, tabindex,
  contenteditable, inputs). Fix: broaden the exempt guard to
  `button, a, input, textarea, select, [contenteditable], [tabindex]`.
- **TO RESOLVE — ghost retains source data-attrs (P4-E3)**: `createGhost` clones the
  source element including `data-dnd-card-issue-id` / `data-drop-target-*`; safe today
  only because of DOM-order invariants. Fix: strip all source data-attrs from the ghost.
- **TO RESOLVE — StrictMode stale destroyed controller (P4-E4)**: `DragProvider` memoizes
  the controller ref as context value; StrictMode dev cleanup nulls the ref but `useMemo`
  keeps serving the destroyed controller. Fix: drop the `useMemo`, serve
  `controllerRef.current` directly (ref is stable in production).
- **TO RESOLVE — `isManualSort` single source (P4-D2)**: `sortField === 'sort_order'`
  computed at `KanbanContainer.tsx:758` and `:1143`; extract one memo, reuse in swap
  branch, move branch, and the `positionalReorderEnabled` prop.
- **TO RESOLVE — `persistProjectReorder` extraction (P4-D3)**: project-reorder still
  inlines `bulkUpdateProjects(...).then(...).catch(...)`; extract next to
  `persistIssueSwap` (matches the D2 pattern).

Test-gap closures in this pass: move-commit under non-`sort_order` sort (B1 regression),
swap no-op under non-`sort_order` (EC1), `isSyncingCountRef` return-to-zero on move
(EC3), `resolveColumnInsertIndex` null-on-card (EC4), mobile handle binding (E1).

## Pass-4 resolution status (2026-08-04)

Resolved this pass: **P4-B1**, **P4-E1**, **P4-BUG1**, **P4-BUG2**, **P4-DRY1**,
**P4-E2**, **P4-E3**, **P4-E4**, **P4-D2**, **P4-D3**, plus the EC1/EC3/EC4 test-gap
closures. Still deferred with **TO RESOLVE** markers: A2 (end-to-end integration test),
A3 (snapshot lifecycle ADR), KanbanContainer monolith split, dndPersisters extraction.

## Pass-5 review (2026-08-04): two independent reviewers — syncGuard + defensive gaps

Two independent reviewers scored 9.3–9.4/10. All findings below are recorded with
**TO RESOLVE** markers and resolved in this pass.

- **TO RESOLVE — `syncGuard` double-decrement on timeout-then-settle (P5-B1)**: when the
  10s timeout fires AND the promise later settles, both paths decrement the counter
  (+1/−2 drift → counter can go negative, silently disabling the `>0` gate for the next
  N drags). Fix: in the bound wrapper, skip `onSettled` when the timeout already fired
  (`if (timedOut) return;`). Regression test for the timeout-then-settle path.
- **TO RESOLVE — list-view same-status reorder under non-manual sort (P5-E1)**: the
  legacy hello-pangea adapter fires a same-status drop with an index under
  `!isManualSort`; the gate only checks `move.index === undefined`, so it writes a
  useless `status_id: to` (where `to === from`) and holds the sync gate for 10s. Fix:
  bail when same-status AND (`index === undefined` OR `!isManualSort`).
- **TO RESOLVE — `useDraggable` `[tabindex]` guard too broad (P5-E2)**: the exempt guard
  `closest('...[tabindex]')` matches the bound source root when the card is focusable
  (`tabIndex` prop), silently breaking drag. Fix: walk from `target` to `currentTarget`
  exclusive so the source root itself is exempt; regression test binding on a
  `tabindex="0"` root.
- **TO RESOLVE — move-preview clone attr strip incomplete (P5-E3)**: the clone strips 4 of
  6 source attrs (ghost strips all 6). Fix: extract a shared `SOURCE_DATA_ATTRS` list and
  use it from both `createGhost` and the clone effect.
- **TO RESOLVE — `destroy()` mid-drag detaches click swallower (P5-E4)**: `destroy()`
  runs `detachClickSwallower()`, so a synthetic click after a mid-drag unmount can
  navigate (react-arborist `handleActivate`). Fix: force `cancel()` first if a drag is in
  flight, preserving the "leave swallower attached" teardown contract. Regression test.
- **TO RESOLVE — clone positioning uses `useEffect` not `useLayoutEffect` (P5-E5)**: the
  cross-column clone can paint at a stale slot for one frame on fast sweeps. Fix: switch
  effect B (position) to `useLayoutEffect`; effect A (create) stays `useEffect`.
- **TO RESOLVE — duplicated `IssueDragLookup` type (P5-D1)**: `resolveDragEnd.ts` and
  `issueLookup.ts` define structurally identical `{id;project_id;status_id;sort_order}`
  types under two names. Fix: single source in `issueLookup.ts`, import into
  `resolveDragEnd.ts`.
- **TO RESOLVE — issue-swap fallback lacks sort-mode gate (P5-E6)**: SharedAppLayout's
  tree-only fallback calls `persistIssueSwap` without the `isManualSort` guard. Fix:
  defensive `isManualSort` check (or document unreachability) + align the swap error log
  format with `KanbanContainer`.

Test-gap closures in this pass: syncGuard timeout-then-settle (B1), list-view non-manual
(E1), tabindex-on-root (E2), destroy mid-drag (E4).

## Pass-5 resolution status (2026-08-04)

Resolved this pass: **P5-B1**, **P5-E1**, **P5-E2**, **P5-E3**, **P5-E4**, **P5-E5**,
**P5-D1**, **P5-E6**, plus the B1/E1/E2/E4 test-gap closures. Still deferred with
**TO RESOLVE** markers: A2 (end-to-end integration test), A3 (snapshot lifecycle ADR),
KanbanContainer monolith split, dndPersisters extraction.
