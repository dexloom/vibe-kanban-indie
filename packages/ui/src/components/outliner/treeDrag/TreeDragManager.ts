import type { DropResult } from '@hello-pangea/dnd';
import {
  DROP_THRESHOLD_PX,
  DRAG_THRESHOLD_PX,
  findBestCandidate,
  type TargetRect,
} from './geometry';

/**
 * Mirror of the subset of React.MouseEvent the manager needs. Decoupling
 * lets the hook pass `e.nativeEvent` (a real DOM `MouseEvent`) without
 * coupling the manager to React.
 */
export interface ManagerMouseEvent {
  clientX: number;
  clientY: number;
}

/**
 * `setDragState` is plumbed in by the layout-level provider so the manager
 * can flip a shared flag (e.g. a `dragState` slice) without owning React.
 * For the spec\'s use case the only consumer is the manager itself, which
 * already knows when it\'s promoting / dropping — but the hook signature
 * keeps the door open for consumers that want to render based on press-only
 * (no movement yet) state.
 */
export type SetDragState = (state: { isActive: boolean }) => void;

/**
 * Constructor callbacks for the manager.
 *
 *  - `onPromote` fires ONCE per drag when the press crosses the movement
 *    threshold and we lift the ghost. Layout uses it to flip the "drag
 *    active" boolean into the `DragActiveContext`.
 *  - `onCandidateChange` fires EVERY time the resolved candidate changes
 *    (including → `null` on drop or move-out-of-range). Layout feeds it
 *    straight into `DragCandidateContext` so tree status rows and kanban
 *    columns can paint their solid ring.
 *  - `onDrop` fires ONCE per drag at mouseup with a synthetic
 *    hello-pangea-shaped `DropResult`. Layout forwards it to
 *    `handleCrossSurfaceDragEnd → resolveDragEnd`.
 */
export interface TreeDragManagerCallbacks {
  onPromote: () => void;
  onCandidateChange: (id: string | null) => void;
  onDrop: (result: DropResult) => void;
}

/**
 * State machine: `idle → pressing → dragging → dropping / cancelled`.
 *
 * Pressing captures the source row + initial pointer coords and waits for
 * the user to either cross the movement threshold (promote) or release the
 * mouse (no-op click falls through). Once dragging, the manager owns a
 * pure-DOM ghost, a cached set of drop-target rects, and a rAF-throttled
 * mousemove handler that re-resolves the candidate on every move.
 *
 * No React. No hello-pangea. No external DnD library. The manager attaches
 * window listeners only while a drag is in flight and detaches them in
 * `cancel()` so a cancelled/finished drag leaves zero global state behind.
 */
export type ManagerState =
  | { kind: 'idle' }
  | { kind: 'pressing'; source: PressSource }
  | { kind: 'dragging'; source: PressSource };

export interface PressSource {
  issueId: string;
  projectId: string;
  startX: number;
  startY: number;
  ghost: HTMLElement | null;
}

interface TargetQueryResult {
  targets: TargetRect[];
}

export class TreeDragManager {
  private state: ManagerState = { kind: 'idle' };
  private callbacks: TreeDragManagerCallbacks;
  private candidateId: string | null = null;
  // Cached rects + DOM query results invalidated on scroll / promote.
  private targetCache: TargetQueryResult | null = null;
  // rAF token for the throttled mousemove handler.
  private rafHandle: number | null = null;
  // Latest pointer coords seen by the rAF callback (post-promote).
  private lastClientX = 0;
  private lastClientY = 0;
  // Captured listeners so `destroy()` can remove them even after a cancel.
  private attached: Array<{
    target: EventTarget;
    type: string;
    listener: EventListener;
    options?: AddEventListenerOptions | boolean;
  }> = [];
  // One-shot capture-phase click swallow, installed on promote.
  private clickSwallower: ((e: MouseEvent) => void) | null = null;

  constructor(callbacks: TreeDragManagerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Begin tracking a press. Returns immediately; the manager decides
   * whether to promote based on subsequent mousemove deltas.
   *
   * Guarded: a second call while a drag is active is ignored (returns
   * `false`) so a stray mousedown from a portal or nested tree node can\'t
   * preempt the in-flight drag.
   */
  startPress(
    issueId: string,
    projectId: string,
    e: ManagerMouseEvent,
    setDragState?: SetDragState,
  ): boolean {
    if (this.state.kind !== 'idle') return false;

    this.state = {
      kind: 'pressing',
      source: {
        issueId,
        projectId,
        startX: e.clientX,
        startY: e.clientY,
        ghost: null,
      },
    };

    // Attach window listeners while we wait for promotion / release.
    const onMouseMove = (ev: Event) => this.handleMove(ev as MouseEvent);
    const onMouseUp = (ev: Event) => this.handleMouseUp(ev as MouseEvent);
    const onKeyDown = (ev: Event) => this.handleKeyDown(ev as KeyboardEvent);
    const onScroll = () => this.invalidateTargets();

    this.addWindowListener('mousemove', onMouseMove);
    this.addWindowListener('mouseup', onMouseUp);
    this.addWindowListener('keydown', onKeyDown);
    this.addWindowListener('scroll', onScroll, { passive: true });

    // Surface press-only state (currently a no-op for downstream consumers,
    // but the contract is in place per the spec).
    setDragState?.({ isActive: false });
    return true;
  }

  /** Detach all listeners, drop ghost, restore user-select. Idempotent. */
  destroy(): void {
    this.teardown();
    this.removeAllListeners();
    this.state = { kind: 'idle' };
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private addWindowListener(
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ): void {
    window.addEventListener(type, listener, options);
    this.attached.push({ target: window, type, listener, options });
  }

  private removeAllListeners(): void {
    for (const entry of this.attached) {
      const opts =
        typeof entry.options === 'boolean' ? entry.options : undefined;
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
      const dx = clientX - this.state.source.startX;
      const dy = clientY - this.state.source.startY;
      if (
        Math.abs(dx) >= DRAG_THRESHOLD_PX ||
        Math.abs(dy) >= DRAG_THRESHOLD_PX
      ) {
        this.promote(this.state.source);
      }
      return;
    }

    if (this.state.kind === 'dragging') {
      // rAF-throttle: coalesce multiple mousemoves per frame.
      if (this.rafHandle !== null) return;
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        this.updateGhostPosition(this.lastClientX, this.lastClientY);
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
    // Run a final candidate pass at the release coords so the drop lands
    // exactly where the cursor is, not the last throttled position.
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.recomputeCandidate();
    const candidate = this.candidateId;
    if (candidate) {
      const result = this.buildDropResult(this.state.source, candidate);
      try {
        this.callbacks.onDrop(result);
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
    // ESC during pressing or dragging → cancel silently, no drop.
    this.cancel();
  }

  private promote(source: PressSource): void {
    this.state = { kind: 'dragging', source };
    document.body.style.userSelect = 'none';
    const ghost = this.createGhost(source.issueId);
    if (ghost) {
      source.ghost = ghost;
      // Park at the press origin so the first rAF tick slides it cleanly.
      ghost.style.transform = `translate3d(${source.startX}px, ${source.startY}px, 0)`;
    }
    // Install one-shot capture-phase click swallow: the browser fires a
    // synthetic click on mouseup after a real drag, and react-arborist\'s
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

    this.callbacks.onPromote();
  }

  private createGhost(issueId: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    const source = document.querySelector<HTMLElement>(
      `[data-tree-card="${cssEscape(issueId)}"]`,
    );
    if (!source) return null;
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.style.position = 'fixed';
    ghost.style.top = '0';
    ghost.style.left = '0';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    ghost.style.opacity = '0.85';
    ghost.style.willChange = 'transform';
    // Slight offset so the cursor doesn\'t sit under the ghost title.
    ghost.style.transformOrigin = 'top left';
    document.body.appendChild(ghost);
    return ghost;
  }

  private updateGhostPosition(x: number, y: number): void {
    if (this.state.kind !== 'dragging') return;
    const ghost = this.state.source.ghost;
    if (!ghost) return;
    // 8px horizontal offset keeps the cursor visible above the title.
    ghost.style.transform = `translate3d(${x + 8}px, ${y - 8}px, 0)`;
  }

  private invalidateTargets(): void {
    // Mark the cache as stale; the next collectTargets() call re-queries
    // getBoundingClientRect so scroll-driven layout shifts are picked up.
    // We do NOT call recomputeCandidate here — the listener can fire on
    // window scrolls that happen to occur in a position with no candidate
    // anyway, and an eager recompute would lock in stale rects before
    // any DOM mutation settles.
    this.targetCache = null;
  }

  private collectTargets(): TargetRect[] {
    if (this.targetCache) return this.targetCache.targets;
    if (this.state.kind !== 'dragging') return [];
    const projectId = this.state.source.projectId;
    if (typeof document === 'undefined') return [];

    const out: TargetRect[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      '[data-drop-target-id][data-drop-target-project]',
    );
    nodes.forEach((el) => {
      if (el.dataset.dropTargetProject !== projectId) return;
      const id = el.dataset.dropTargetId;
      if (!id) return;
      const rect = el.getBoundingClientRect();
      out.push({
        droppableId: id,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      });
    });
    this.targetCache = { targets: out };
    return out;
  }

  private recomputeCandidate(): void {
    const candidate = this.resolveCandidateAt(
      this.lastClientX,
      this.lastClientY,
    );
    if (candidate === this.candidateId) return;
    this.candidateId = candidate;
    this.callbacks.onCandidateChange(candidate);
  }

  private resolveCandidateAt(x: number, y: number): string | null {
    const targets = this.collectTargets();
    return findBestCandidate(x, y, targets, DROP_THRESHOLD_PX);
  }

  private buildDropResult(
    source: PressSource,
    candidateId: string,
  ): DropResult {
    return {
      draggableId: `issue:${source.issueId}`,
      type: 'DEFAULT',
      source: { droppableId: source.issueId, index: 0 },
      destination: { droppableId: candidateId, index: 0 },
      combine: null,
      reason: 'DROP',
      mode: 'FLUID',
    };
  }

  /**
   * Single point of teardown for cancel / drop. Restores `user-select` in a
   * try/finally so a thrown consumer callback (e.g. `onDrop`) can\'t leave
   * the page unselectable.
   */
  private cancel(): void {
    try {
      this.teardown();
    } finally {
      this.removeAllListeners();
      this.state = { kind: 'idle' };
      // Detach any stray click swallower if we never promoted.
      if (this.clickSwallower) {
        document.removeEventListener('click', this.clickSwallower, {
          capture: true,
        } as EventListenerOptions);
        this.clickSwallower = null;
      }
    }
  }

  private teardown(): void {
    // Remove ghost.
    if (this.state.kind === 'dragging' && this.state.source.ghost) {
      this.state.source.ghost.remove();
    }
    if (this.state.kind === 'pressing') {
      // No ghost exists in pressing.
    }
    if (this.state.kind === 'dragging') {
      // Restore selection cursor.
      document.body.style.userSelect = '';
    }
    // Cancel any pending rAF.
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    // Clear candidate via callback.
    if (this.candidateId !== null) {
      this.candidateId = null;
      this.callbacks.onCandidateChange(null);
    }
    // Drop rect cache.
    this.targetCache = null;
  }
}

// CSS.escape polyfill for querySelector attribute strings. Modern browsers
// ship it on the global `CSS` namespace; jsdom omits it in some configs.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
