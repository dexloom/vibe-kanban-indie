import {
  DROP_THRESHOLD_PX,
  DRAG_THRESHOLD_PX,
  computeCardInsertionIndex,
  findBestCandidate,
  type CardExtent,
  type TargetRect,
} from './geometry';
import { isColumnLikeTarget } from './targetKind';
import type { Candidate, DragCompletion, DragSource } from './types';

// Visual tuning for the drag ghost. Kept module-local so they survive any
// future theming pass and are easy to grep.
const GHOST_Z_INDEX = '9999';
const GHOST_OFFSET_X = 8;
const GHOST_OFFSET_Y = -8;

/** Mirror of the subset of React.MouseEvent the controller needs. Lets the
 * hook pass `e.nativeEvent` (a real DOM MouseEvent) without coupling the
 * controller to React. */
export interface ManagerMouseEvent {
  clientX: number;
  clientY: number;
}

export interface DragControllerCallbacks {
  /** Fires ONCE per drag when the press crosses the movement threshold and
   * the ghost is lifted. */
  onPromote: () => void;
  /** Fires ONCE per ACTUAL drag (a press that crossed the movement
   * threshold) at cancel OR drop. Does NOT fire for sub-threshold
   * releases or ESC during a press — those gestures were never a drag.
   * The provider uses this to reset its active flag. */
  onDragEnd: () => void;
  /** Fires every time the resolved candidate changes (targetId AND/OR
   * placement). Targets receive this via the provider's candidate context. */
  onCandidateChange: (candidate: Candidate) => void;
  /** Fires ONCE per drag at mouseup with the resolved completion. */
  onDrop: (completion: DragCompletion) => void;
}

type ControllerState =
  | { kind: 'idle' }
  | {
      kind: 'pressing';
      source: DragSource;
      element: HTMLElement | null;
      startX: number;
      startY: number;
      ghost: HTMLElement | null;
    }
  | {
      kind: 'dragging';
      source: DragSource;
      element: HTMLElement | null;
      startX: number;
      startY: number;
      ghost: HTMLElement | null;
    };

/**
 * State machine: `idle → pressing → dragging → dropping / cancelled`.
 *
 * Pressing captures the source element + initial pointer coords and waits
 * for the user to either cross the movement threshold (promote) or release
 * the mouse (no-op click falls through). Once dragging, the controller
 * owns a pure-DOM ghost and a rAF-throttled mousemove handler that
 * re-resolves the candidate on every move. Drop targets are re-queried
 * from the DOM each frame — a shape sync that adds a status column
 * mid-gesture is picked up on the next mousemove without a scroll event.
 *
 * No React. No hello-pangea. No external DnD library. The controller
 * attaches window listeners only while a drag is in flight and detaches
 * them in `cancel()` so a cancelled/finished drag leaves zero global
 * state behind.
 */
export class DragController {
  private state: ControllerState = { kind: 'idle' };
  private callbacks: DragControllerCallbacks;
  private candidate: Candidate = {
    targetId: null,
    placement: null,
    index: null,
    isCard: false,
    sourceIssueId: null,
    sourceProjectId: null,
  };
  /** Snapshot of the source column's card geometry taken at promote. The
   * visual swap preview reorders the DOM mid-gesture, which shifts every
   * card's live `getBoundingClientRect`; resolving card candidates against
   * this frozen snapshot keeps "the card under the pointer" stable, so the
   * swap preview never oscillates and any card in the column can be the
   * target (not just the one first hovered). */
  private sourceCardRects: Map<string, { left: number; top: number; right: number; bottom: number }> | null = null;
  /** Snapshot of the TARGET column's card extents for cross-column move
   * insertion-index resolution. Captured lazily when the candidate first
   * resolves to a given column; the move preview appends a clone into the
   * column, shifting its live rects, so the index must be computed against
   * this frozen layout to avoid oscillation. */
  private targetColumnRects: { columnId: string; cards: CardExtent[] } | null = null;
  private rafHandle: number | null = null;
  private lastClientX = 0;
  private lastClientY = 0;
  private attached: Array<{
    target: EventTarget;
    type: string;
    listener: EventListener;
    options?: AddEventListenerOptions | boolean;
  }> = [];
  private clickSwallower: ((e: MouseEvent) => void) | null = null;

  constructor(callbacks: DragControllerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Begin tracking a press. Returns immediately; the controller decides
   * whether to promote based on subsequent mousemove deltas.
   *
   * Guarded: a second call while a drag is active is ignored (returns
   * `false`) so a stray mousedown from a portal or nested tree node can't
   * preempt the in-flight drag.
   */
  startPress(
    source: DragSource,
    element: HTMLElement | null,
    e: ManagerMouseEvent
  ): boolean {
    if (this.state.kind !== 'idle') return false;

    // A new gesture is the only legitimate re-entry point. Tear down any
    // document-level swallower still attached from the previous drag —
    // by now the prior drag's mouseup click has either fired (and the
    // browser's `once:true` removed the listener) or never will (e.g.
    // user ESC'd mid-gesture, then started a fresh press). Leaving it
    // attached would let the stale swallower eat an arbitrary future
    // click. `detachClickSwallower` is a no-op when nothing is attached.
    this.detachClickSwallower();

    this.state = {
      kind: 'pressing',
      source,
      element,
      startX: e.clientX,
      startY: e.clientY,
      ghost: null,
    };

    const onMouseMove = (ev: Event) => this.handleMove(ev as MouseEvent);
    const onMouseUp = (ev: Event) => this.handleMouseUp(ev as MouseEvent);
    const onKeyDown = (ev: Event) => this.handleKeyDown(ev as KeyboardEvent);

    this.addWindowListener('mousemove', onMouseMove);
    this.addWindowListener('mouseup', onMouseUp);
    this.addWindowListener('keydown', onKeyDown);

    return true;
  }

  /** Detach all listeners, drop ghost, restore user-select. Idempotent. */
  destroy(): void {
    this.teardown();
    this.removeAllListeners();
    this.detachClickSwallower();
    this.state = { kind: 'idle' };
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private addWindowListener(
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean
  ): void {
    window.addEventListener(type, listener, options);
    this.attached.push({ target: window, type, listener, options });
  }

  private removeAllListeners(): void {
    for (const entry of this.attached) {
      // `removeEventListener` only matches on (type, listener, capture);
      // we deliberately preserve ONLY the capture flag — preserving
      // `passive`/`once` would not weaken correctness (the browser
      // ignores them on remove) but invites a future reader to "fix"
      // the asymmetry and accidentally change matching semantics.
      const opts: AddEventListenerOptions | boolean =
        typeof entry.options === 'boolean'
          ? entry.options
          : { capture: entry.options?.capture ?? false };
      try {
        entry.target.removeEventListener(entry.type, entry.listener, opts);
      } catch {
        // listener was already detached; ignore.
      }
    }
    this.attached = [];
  }

  private handleMove(e: MouseEvent): void {
    const { clientX, clientY } = e;
    this.lastClientX = clientX;
    this.lastClientY = clientY;

    if (this.state.kind === 'pressing') {
      const dx = clientX - this.state.startX;
      const dy = clientY - this.state.startY;
      if (
        Math.abs(dx) >= DRAG_THRESHOLD_PX ||
        Math.abs(dy) >= DRAG_THRESHOLD_PX
      ) {
        this.promote();
      }
      return;
    }

    if (this.state.kind === 'dragging') {
      if (this.rafHandle !== null) return;
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        this.updateGhostPosition(this.lastClientX, this.lastClientY);
        // Card candidates resolve against the promote-time geometry snapshot
        // (see `sourceCardRects`), so the DOM reorder caused by the swap
        // preview cannot feed back into the candidate — no freeze needed.
        this.recomputeCandidate();
      });
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (this.state.kind !== 'dragging') {
      // Sub-threshold release → no drag was lifted, fall through as a
      // plain click (the one-shot swallower is NOT installed).
      this.cancel();
      return;
    }
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    const savedCandidate = this.candidate;
    this.recomputeCandidate();
    // The visual swap preview may have reordered the DOM, causing the final
    // recompute to lose a previously-found CARD candidate. Restore it — but
    // never when the pointer sits on the dragged card itself (dropping on
    // yourself is a no-op). We do NOT restore a column candidate: returning
    // to the source column legitimately clears a cross-column move target
    // (the user changed their mind).
    if (
      !this.candidate.targetId &&
      savedCandidate.targetId &&
      savedCandidate.isCard &&
      !this.isPointerOverSource(this.lastClientX, this.lastClientY)
    ) {
      this.candidate = savedCandidate;
    }
    const candidate = this.candidate;
    if (candidate.targetId) {
      const completion = this.buildDragCompletion(
        this.state.source,
        candidate.targetId
      );
      try {
        this.callbacks.onDrop(completion);
      } finally {
        this.cancel();
      }
    } else {
      this.cancel();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (this.state.kind === 'idle') return;
    this.cancel();
  }

  private promote(): void {
    if (this.state.kind !== 'pressing') return;
    const { source, element, startX, startY } = this.state;
    this.state = {
      kind: 'dragging',
      source,
      element,
      startX,
      startY,
      ghost: null,
    };
    document.body.style.userSelect = 'none';
    // Toggling a class beats setting `document.body.style.cursor` because
    // the source card sits under the pointer during a drag and its
    // own `cursor` rule would win over an inline body style. The
    // `body.dnd-dragging *` wildcard override (global stylesheet)
    // re-asserts `grabbing` on every descendant.
    document.body.classList.add('dnd-dragging');
    const ghost = this.createGhost(element);
    if (ghost) {
      if (this.state.kind === 'dragging') {
        this.state.ghost = ghost;
      }
      // Apply the same per-frame cursor offset on the initial transform
      // — otherwise the ghost renders at (startX, startY) for one frame
      // and snaps to (startX+8, startY-8) on the first rAF. Apply the
      // offsets now so the ghost stays anchored to the cursor through
      // the entire gesture.
      ghost.style.transform = `translate3d(${startX + GHOST_OFFSET_X}px, ${
        startY + GHOST_OFFSET_Y
      }px, 0)`;
    }
    // Install one-shot capture-phase click swallow: the browser fires a
    // synthetic click on mouseup after a real drag, and react-arborist's
    // outer DefaultRow would route that click to handleActivate
    // (navigation). Swallow exactly one click.
    this.clickSwallower = (clickEvent: MouseEvent) => {
      clickEvent.stopPropagation();
      clickEvent.preventDefault();
      this.clickSwallower = null;
    };
    document.addEventListener('click', this.clickSwallower, {
      capture: true,
      once: true,
    });

    // Snapshot the source column's card geometry at promote time. The swap
    // preview reorders the DOM while dragging, so card candidates must be
    // resolved against this frozen layout — live rects would shift and the
    // candidate would oscillate. The source card element was captured at
    // press time; it itself carries `data-drop-target-id` (it's a card
    // target), so skip self and find the enclosing column div.
    if (typeof document !== 'undefined' && this.state.kind === 'dragging') {
      const sourceEl = this.state.element;
      const column = sourceEl
        ?.closest('[data-drop-target-id]')
        ?.parentElement?.closest('[data-drop-target-id]');
      const snapshot = new Map<
        string,
        { left: number; top: number; right: number; bottom: number }
      >();
      column
        ?.querySelectorAll<HTMLElement>('[data-drop-target-status]')
        .forEach((card) => {
          const id = card.dataset.dropTargetId;
          if (!id) return;
          const rect = card.getBoundingClientRect();
          snapshot.set(id, {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          });
        });
      this.sourceCardRects = snapshot;
    }

    this.callbacks.onPromote();
  }

  private createGhost(element: HTMLElement | null): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    if (!element) return null;
    const ghost = element.cloneNode(true) as HTMLElement;
    ghost.style.position = 'fixed';
    ghost.style.top = '0';
    ghost.style.left = '0';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = GHOST_Z_INDEX;
    ghost.style.opacity = '0.85';
    ghost.style.willChange = 'transform';
    ghost.style.transformOrigin = 'top left';
    document.body.appendChild(ghost);
    return ghost;
  }

  private updateGhostPosition(x: number, y: number): void {
    if (this.state.kind !== 'dragging') return;
    const ghost = this.state.ghost;
    if (!ghost) return;
    ghost.style.transform = `translate3d(${x + GHOST_OFFSET_X}px, ${
      y + GHOST_OFFSET_Y
    }px, 0)`;
  }

  private collectTargets(): TargetRect[] {
    if (this.state.kind !== 'dragging') {
      return [];
    }
    const source = this.state.source;
    if (typeof document === 'undefined') {
      return [];
    }

    const out: TargetRect[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      '[data-drop-target-id][data-drop-target-project][data-drop-target-accept-kinds]'
    );
    nodes.forEach((el) => {
      if (source.kind === 'project-reorder') {
        // Targets are OTHER project rows (each row's data-drop-target-project
        // is its OWN id, which never equals the dragged project's id, so the
        // equality filter would reject every peer). Exclude self so the
        // dragged row never becomes its own candidate.
        if (el.dataset.dropTargetId === source.projectId) return;
      } else {
        // Issue-move drags target either a same-column kanban card (swap)
        // or a different-column kanban column (move). Cards carry
        // `data-drop-target-status`; columns do not — attribute presence
        // is the discriminator.
        if (el.dataset.dropTargetStatus !== undefined) {
          if (el.dataset.dropTargetStatus !== source.statusId) return;
          if (el.dataset.dropTargetId === source.issueId) return;
        } else {
          if (el.dataset.dropTargetId === source.statusId) return;
          if (el.dataset.dropTargetProject !== source.projectId) return;
        }
      }
      const acceptKinds = (el.dataset.dropTargetAcceptKinds ?? '').split(',');
      if (!acceptKinds.includes(source.kind)) return;
      const id = el.dataset.dropTargetId;
      if (!id) return;
      // Resolve CARD targets against the promote-time snapshot (stable across
      // the swap preview's DOM reorder); columns/rows use live rects.
      const snap =
        el.dataset.dropTargetStatus !== undefined && this.sourceCardRects
          ? this.sourceCardRects.get(id)
          : null;
      const rect = snap
        ? { left: snap.left, top: snap.top, right: snap.right, bottom: snap.bottom }
        : el.getBoundingClientRect();
      out.push({
        droppableId: id,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        isCard: el.dataset.dropTargetStatus !== undefined,
      });
    });
    return out;
  }

  private recomputeCandidate(): void {
    const candidate = this.resolveCandidateAt(
      this.lastClientX,
      this.lastClientY
    );
    if (
      candidate.targetId === this.candidate.targetId &&
      candidate.placement === this.candidate.placement &&
      candidate.index === this.candidate.index &&
      candidate.sourceIssueId === this.candidate.sourceIssueId &&
      candidate.sourceProjectId === this.candidate.sourceProjectId
    ) {
      return;
    }
    this.candidate = candidate;
    this.callbacks.onCandidateChange(candidate);
  }

  private resolveCandidateAt(x: number, y: number): Candidate {
    const sourceIssueId =
      this.state.kind === 'dragging' && this.state.source.kind === 'issue-move'
        ? this.state.source.issueId
        : null;
    const sourceProjectId =
      this.state.kind === 'dragging' &&
      this.state.source.kind === 'project-reorder'
        ? this.state.source.projectId
        : null;
    // Pointer over the dragged element itself → no target. Dropping on
    // yourself is a no-op (the source card stays in the DOM, dimmed).
    if (this.isPointerOverSource(x, y)) {
      return {
        targetId: null,
        placement: null,
        index: null,
        isCard: false,
        sourceIssueId,
        sourceProjectId,
      };
    }
    const targets = this.collectTargets();
    const { targetId, placement, isCard } = findBestCandidate(
      x,
      y,
      targets,
      DROP_THRESHOLD_PX
    );
    // Cross-column move onto a kanban column: resolve the insertion slot
    // against the target column's promote-time card snapshot. Tree-status
    // rows and card (swap) targets carry no insertion index.
    const index =
      sourceIssueId !== null &&
      targetId !== null &&
      !isCard &&
      isColumnLikeTarget(targetId)
        ? this.resolveColumnInsertIndex(targetId, y)
        : null;
    return {
      targetId,
      placement,
      index,
      isCard,
      sourceIssueId,
      sourceProjectId,
    };
  }

  /** Insertion slot for a cross-column move: how many of the target column's
   * cards sit above the pointer's card slot (pointer above a card's midpoint
   * → before it; below → after). Snapshotted per column so the preview
   * clone's presence never shifts the resolved index. */
  private resolveColumnInsertIndex(columnId: string, y: number): number {
    const cards = this.getTargetColumnCards(columnId);
    return computeCardInsertionIndex(y, cards);
  }

  private getTargetColumnCards(columnId: string): CardExtent[] {
    if (
      this.targetColumnRects !== null &&
      this.targetColumnRects.columnId === columnId
    ) {
      return this.targetColumnRects.cards;
    }
    const cards: CardExtent[] = [];
    if (typeof document !== 'undefined') {
      document
        .querySelectorAll<HTMLElement>(`[data-drop-target-status="${columnId}"]`)
        .forEach((cardEl) => {
          const rect = cardEl.getBoundingClientRect();
          cards.push({ top: rect.top, bottom: rect.bottom });
        });
    }
    // The preview clone is NOT registered as a drop target (its
    // `data-drop-target-id` is stripped), so the live query sees only real
    // cards. Sort defensively top→bottom regardless.
    cards.sort((a, b) => a.top - b.top);
    this.targetColumnRects = { columnId, cards };
    return cards;
  }

  private isPointerOverSource(x: number, y: number): boolean {
    if (this.state.kind !== 'dragging') return false;
    const src = this.state.source;
    if (src.kind !== 'issue-move') return false;
    // Compare against the promote-time SNAPSHOT rect of the source card,
    // not the live DOM: the swap preview reorders children mid-gesture, so
    // the source card's live position is wherever the pointer dragged it.
    // Only a true "returned to my own slot" lands inside the snapshot.
    const rect = this.sourceCardRects?.get(src.issueId);
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private buildDragCompletion(
    source: DragSource,
    targetId: string
  ): DragCompletion {
    // issue-move always lands 'on'; future reorder kinds branch here.
    return { source, targetId, placement: 'on', index: this.candidate.index };
  }

  /** Single point of teardown for cancel / drop. Used by:
   *  - mouseup-after-promote (drop path),
   *  - ESC during pressing (gesture never lifted),
   *  - ESC during dragging (real drag cancelled),
   *  - sub-threshold mouseup (gesture never lifted).
   *
   *  `onDragEnd` fires only when an actual drag was lifted — a
   *  sub-threshold release or ESC during a press must NOT notify the
   *  provider, because from the provider's perspective no drag ever
   *  happened (the active flag was never set in the first place).
   */
  private cancel(): void {
    const wasDragging = this.state.kind === 'dragging';
    try {
      this.teardown();
    } finally {
      this.removeAllListeners();
      this.state = { kind: 'idle' };
      // The one-shot click swallower installed in `promote()` is registered
      // with `{ once: true, capture: true }` — the browser removes it
      // automatically after the first click. Eagerly detaching it here
      // would let a synthetic click fired after ESC navigate the row.
      if (wasDragging) {
        this.callbacks.onDragEnd();
      }
    }
  }

  private teardown(): void {
    this.sourceCardRects = null;
    this.targetColumnRects = null;
    if (this.state.kind === 'dragging' && this.state.ghost) {
      this.state.ghost.remove();
    }
    if (this.state.kind === 'dragging') {
      document.body.style.userSelect = '';
      document.body.classList.remove('dnd-dragging');
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (
      this.candidate.targetId !== null ||
      this.candidate.placement !== null ||
      this.candidate.index !== null
    ) {
      this.candidate = {
        targetId: null,
        placement: null,
        index: null,
        isCard: false,
        sourceIssueId: null,
        sourceProjectId: null,
      };
      this.callbacks.onCandidateChange(this.candidate);
    }
  }

  // Removes the one-shot capture-phase click swallower installed in
  // `promote()`. Called ONLY from `destroy()` and from `startPress()`
  // (the previous-drag re-entry guard). `cancel()` must leave it
  // attached so the synthetic click fired after an ESC'd drag is still
  // swallowed (the round-1 bug). Capture must match how it was added
  // (`{ capture: true }`) for the browser to find the right entry.
  private detachClickSwallower(): void {
    if (!this.clickSwallower) return;
    document.removeEventListener('click', this.clickSwallower, {
      capture: true,
    });
    this.clickSwallower = null;
  }
}
