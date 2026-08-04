import {
  DROP_THRESHOLD_PX,
  DRAG_THRESHOLD_PX,
  findBestCandidate,
  computeInsertIndex,
  type TargetRect,
  type CardRect,
} from './geometry';
import type { Candidate, DragCompletion, DragSource } from './types';

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

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
  /** Fires ONCE per drag, at cancel OR drop. The provider uses this to
   * reset its active flag (the promote bit is set on press, the end bit is
   * set on drop/cancel). */
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

interface TargetQueryResult {
  targets: TargetRect[];
}

/**
 * State machine: `idle → pressing → dragging → dropping / cancelled`.
 *
 * Pressing captures the source element + initial pointer coords and waits
 * for the user to either cross the movement threshold (promote) or release
 * the mouse (no-op click falls through). Once dragging, the controller
 * owns a pure-DOM ghost, a cached set of drop-target rects, and a
 * rAF-throttled mousemove handler that re-resolves the candidate on every
 * move.
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
    sourceIssueId: null,
  };
  private targetCache: TargetQueryResult | null = null;
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
    e: ManagerMouseEvent,
  ): boolean {
    if (this.state.kind !== 'idle') return false;

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
    const onScroll = () => this.invalidateTargets();

    this.addWindowListener('mousemove', onMouseMove);
    this.addWindowListener('mouseup', onMouseUp);
    this.addWindowListener('keydown', onKeyDown);
    this.addWindowListener('scroll', onScroll, { passive: true });

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
    this.recomputeCandidate();
    const candidate = this.candidate;
    if (candidate.targetId) {
      const completion = this.buildDragCompletion(
        this.state.source,
        candidate.targetId,
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
    const ghost = this.createGhost(element);
    if (ghost) {
      if (this.state.kind === 'dragging') {
        this.state.ghost = ghost;
      }
      ghost.style.transform = `translate3d(${startX}px, ${startY}px, 0)`;
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
    ghost.style.zIndex = '9999';
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
    ghost.style.transform = `translate3d(${x + 8}px, ${y - 8}px, 0)`;
  }

  private invalidateTargets(): void {
    this.targetCache = null;
  }

  private collectTargets(): TargetRect[] {
    if (this.targetCache) return this.targetCache.targets;
    if (this.state.kind !== 'dragging') return [];
    const source = this.state.source;
    if (typeof document === 'undefined') return [];

    const out: TargetRect[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      '[data-drop-target-id][data-drop-target-project][data-drop-target-accept-kinds]',
    );
    nodes.forEach((el) => {
      if (el.dataset.dropTargetProject !== source.projectId) return;
      const acceptKinds = (el.dataset.dropTargetAcceptKinds ?? '').split(',');
      if (!acceptKinds.includes(source.kind)) return;
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
    if (
      candidate.targetId === this.candidate.targetId &&
      candidate.placement === this.candidate.placement &&
      candidate.index === this.candidate.index
    ) {
      return;
    }
    this.candidate = candidate;
    this.callbacks.onCandidateChange(candidate);
  }

  private resolveCandidateAt(x: number, y: number): Candidate {
    const targets = this.collectTargets();
    const candidate = findBestCandidate(x, y, targets, DROP_THRESHOLD_PX);
    candidate.sourceIssueId =
      this.state.kind === 'dragging' && this.state.source.kind === 'issue-move'
        ? this.state.source.issueId
        : null;
    if (
      this.state.kind === 'dragging' &&
      this.state.source.kind === 'issue-move' &&
      candidate.targetId &&
      !candidate.targetId.includes(':status:')
    ) {
      candidate.index = this.resolveCardIndex(candidate.targetId, y);
    }
    return candidate;
  }

  private resolveCardIndex(targetId: string, pointerY: number): number | null {
    if (typeof document === 'undefined') return null;
    const column = document.querySelector<HTMLElement>(
      `[data-drop-target-id="${cssEscape(targetId)}"]`,
    );
    if (!column) return null;
    const sourceIssueId =
      this.state.kind === 'dragging' ? this.state.source.issueId : null;
    const rects: CardRect[] = [];
    column.querySelectorAll<HTMLElement>('[data-dnd-card]').forEach((el) => {
      if (el.dataset.dndCardIssueId === sourceIssueId) return;
      const rect = el.getBoundingClientRect();
      rects.push({ top: rect.top, bottom: rect.bottom });
    });
    rects.sort((a, b) => a.top - b.top);
    return computeInsertIndex(pointerY, rects);
  }

  private buildDragCompletion(
    source: DragSource,
    targetId: string,
  ): DragCompletion {
    // issue-move always lands 'on'; future reorder kinds branch here.
    return { source, targetId, placement: 'on', index: this.candidate.index };
  }

  /** Single point of teardown for cancel / drop. Restores `user-select` and
   * fires `onDragEnd` so the provider can reset its active flag. */
  private cancel(): void {
    try {
      this.teardown();
    } finally {
      this.removeAllListeners();
      this.state = { kind: 'idle' };
      if (this.clickSwallower) {
        document.removeEventListener('click', this.clickSwallower, {
          capture: true,
        } as EventListenerOptions);
        this.clickSwallower = null;
      }
      this.callbacks.onDragEnd();
    }
  }

  private teardown(): void {
    if (this.state.kind === 'dragging' && this.state.ghost) {
      this.state.ghost.remove();
    }
    if (this.state.kind === 'dragging') {
      document.body.style.userSelect = '';
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
        sourceIssueId: null,
      };
      this.callbacks.onCandidateChange(this.candidate);
    }
    this.targetCache = null;
  }
}
