/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragController, type DragControllerCallbacks } from './DragController';
import { DRAG_THRESHOLD_PX, DROP_THRESHOLD_PX } from './geometry';
import type { DragSource, DragCompletion } from './types';

type MockCallback = ReturnType<typeof vi.fn>;
interface TestCallbacks {
  onPromote: MockCallback;
  onDragEnd: MockCallback;
  onCandidateChange: MockCallback;
  onDrop: MockCallback;
}

function makeCallbacks(): TestCallbacks {
  return {
    onPromote: vi.fn(),
    onDragEnd: vi.fn(),
    onCandidateChange: vi.fn(),
    onDrop: vi.fn(),
  };
}

function pointerEvent(
  type: string,
  x: number,
  y: number,
  pointerId: number = 1,
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId,
  });
}

function makeSource(
  issueId = 'issue-1',
  projectId = 'project-1',
  statusId = 'status-1',
): DragSource {
  return { kind: 'issue-move', issueId, projectId, statusId };
}

const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  let queue: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = vi.fn((handle: number) => {
    queue = queue.filter((_, i) => i + 1 !== handle);
  }) as unknown as typeof cancelAnimationFrame;
  (globalThis as unknown as { __flushRaf: () => void }).__flushRaf = () => {
    const drained = queue;
    queue = [];
    for (const cb of drained) cb(performance.now());
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  document.body.innerHTML = '';
  // Defensive: some tests polyfill `document.elementFromPoint` (jsdom
  // doesn't implement it). Forget the polyfill here so the next test
  // runs against the regular jsdom surface (the fallback branch in
  // `isPointerOverSource` must remain exercised).
  delete (document as unknown as { elementFromPoint?: unknown })
    .elementFromPoint;
});

function flushRaf(): void {
  (globalThis as unknown as { __flushRaf: () => void }).__flushRaf();
}

function installSourceElement(issueId = 'issue-1'): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-source-id', issueId);
  row.textContent = 'Source row';
  document.body.appendChild(row);
  return row;
}

/** Source card wired the way KanbanCard really is: nested in a column div,
 * carrying the card target attrs so the promote-time snapshot includes it. */
function installSourceCardInColumn(issueId = 'issue-1', statusId = 'status-1') {
  const column = document.createElement('div');
  column.setAttribute('data-drop-target-id', statusId);
  column.setAttribute('data-drop-target-project', 'project-1');
  column.setAttribute('data-drop-target-accept-kinds', 'issue-move');
  const card = document.createElement('div');
  card.setAttribute('data-dnd-card', '');
  card.setAttribute('data-dnd-card-issue-id', issueId);
  card.setAttribute('data-drop-target-id', issueId);
  card.setAttribute('data-drop-target-project', 'project-1');
  card.setAttribute('data-drop-target-accept-kinds', 'issue-move');
  card.setAttribute('data-drop-target-status', statusId);
  card.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 60,
      bottom: 30,
      width: 60,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  column.appendChild(card);
  document.body.appendChild(column);
  return { card, column };
}

function installDropTarget(
  id: string,
  projectId: string,
  rect: { left: number; top: number; right: number; bottom: number },
  acceptKinds = 'issue-move',
  statusId?: string,
): HTMLElement {
  const target = document.createElement('div');
  target.setAttribute('data-drop-target-id', id);
  target.setAttribute('data-drop-target-project', projectId);
  target.setAttribute('data-drop-target-accept-kinds', acceptKinds);
  if (statusId !== undefined) {
    target.setAttribute('data-drop-target-status', statusId);
  }
  target.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }) as DOMRect;
  document.body.appendChild(target);
  return target;
}

describe('DragController', () => {
  it('ignores a second startPress while a drag is in flight', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    expect(
      m.startPress(makeSource('issue-1'), element, {
        clientX: 0,
        clientY: 0,
        pointerId: 1,
      }),
    ).toBe(true);
    expect(
      m.startPress(makeSource('issue-2'), element, {
        clientX: 0,
        clientY: 0,
        pointerId: 1,
      }),
    ).toBe(false);
    m.destroy();
  });

  it('does not promote when movement is below DRAG_THRESHOLD_PX', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    m.startPress(makeSource(), element, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });

    window.dispatchEvent(
      pointerEvent('pointermove', 100 + DRAG_THRESHOLD_PX - 1, 100),
    );

    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onCandidateChange).not.toHaveBeenCalled();
    m.destroy();
  });

  it('promotes when movement crosses DRAG_THRESHOLD_PX (diagonal)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    m.startPress(makeSource(), element, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });

    window.dispatchEvent(
      pointerEvent('pointermove', 100 + DRAG_THRESHOLD_PX, 100),
    );

    expect(cb.onPromote).toHaveBeenCalledTimes(1);
    expect(document.body.style.userSelect).toBe('none');
    // Cursor is set via a body class (not an inline style) because the
    // source card sits under the pointer and a body-level inline cursor
    // loses to the card's own `cursor` rule.
    expect(document.body.classList.contains('dnd-dragging')).toBe(true);
    // Ghost is appended (clone of the captured source element). The clone
    // carries the same [data-source-id] but is a distinct node — assert by
    // pointer-events:none on the new fixed-position element.
    const fixed = document.body.querySelectorAll(
      'div[data-source-id="issue-1"]',
    );
    expect(fixed.length).toBe(2);
    const ghost = [...fixed].find(
      (el) => (el as HTMLElement).style.position === 'fixed',
    );
    expect(ghost).toBeTruthy();
    m.destroy();
    expect(document.body.classList.contains('dnd-dragging')).toBe(false);
  });

  it('P4-E3: ghost strips source data-dnd-* and data-drop-target-* attributes', () => {
    // The ghost is a clone of the source element. Before the fix it
    // carried the source's `data-dnd-card-issue-id` / `data-drop-target-*`
    // attrs, which means a stray ghost in `document.body` would be
    // picked up by `collectTargets` (the next pointermove re-queries
    // the DOM and would see the ghost as a candidate). The cloned
    // clone also collided with the live source's id when both
    // happened to share a namespace. The ghost must now strip
    // data-dnd-card, data-dnd-card-issue-id, data-drop-target-id,
    // data-drop-target-project, data-drop-target-status,
    // data-drop-target-accept-kinds.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const { card } = installSourceCardInColumn('issue-1', 'status-1');
    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    window.dispatchEvent(
      pointerEvent('pointermove', 100 + DRAG_THRESHOLD_PX, 100),
    );
    // The ghost is appended to document.body and is the fixed-position
    // clone — query `body > [style*="pointer-events: none"]` and check
    // the data attributes are absent.
    const ghost = document.body.querySelector<HTMLElement>(
      'body > [style*="pointer-events: none"]',
    );
    expect(ghost).toBeTruthy();
    expect(ghost!.hasAttribute('data-dnd-card')).toBe(false);
    expect(ghost!.hasAttribute('data-dnd-card-issue-id')).toBe(false);
    expect(ghost!.hasAttribute('data-drop-target-id')).toBe(false);
    expect(ghost!.hasAttribute('data-drop-target-project')).toBe(false);
    expect(ghost!.hasAttribute('data-drop-target-status')).toBe(false);
    expect(ghost!.hasAttribute('data-drop-target-accept-kinds')).toBe(false);
    m.destroy();
  });

  it('updates the candidate via onCandidateChange as the pointer moves', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Pointer far from target → onCandidateChange not emitted (no CHANGE
    // from the initial null state).
    expect(cb.onCandidateChange).not.toHaveBeenCalled();

    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();
    expect(cb.onCandidateChange).toHaveBeenLastCalledWith({
      targetId: 'project-1:status:todo',
      placement: 'on',
      index: null,
      isCard: false,
      sourceIssueId: 'issue-1',
      sourceProjectId: null,
    });

    m.destroy();
  });

  it('emits onDrop with a DragCompletion when pointerup happens over a candidate', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:done', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointerup', 230, 15));

    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    const completion = cb.onDrop.mock.calls[0]![0] as DragCompletion;
    expect(completion).toEqual({
      source: {
        kind: 'issue-move',
        issueId: 'issue-1',
        projectId: 'project-1',
        statusId: 'status-1',
      },
      targetId: 'project-1:status:done',
      placement: 'on',
      index: null,
    });
    // Manager cleaned up after drop: candidate is cleared back to null.
    expect(cb.onCandidateChange).toHaveBeenLastCalledWith({
      targetId: null,
      placement: null,
      index: null,
      isCard: false,
      sourceIssueId: null,
      sourceProjectId: null,
    });
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.classList.contains('dnd-dragging')).toBe(false);
    m.destroy();
  });

  it('emits no onDrop when pointerup happens outside any candidate', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // The pointermove at (100,100) crosses the 5px threshold, so this
    // IS a real drag. The pointerup at (500,500) is just outside any
    // candidate → no onDrop but cancel() still fires onDragEnd because
    // the gesture lifted.
    window.dispatchEvent(pointerEvent('pointerup', 500, 500));

    expect(cb.onDrop).not.toHaveBeenCalled();
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('dnd-dragging')).toBe(false);
    m.destroy();
  });

  it('cancels via ESC during pressing (sub-threshold press, no drop)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onDrop).not.toHaveBeenCalled();
    // ESC during a press: gesture never lifted, onDragEnd stays silent.
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    m.destroy();
  });

  it('cancels via ESC during dragging (no drop, ghost removed)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    expect(cb.onPromote).toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cb.onDrop).not.toHaveBeenCalled();
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.userSelect).toBe('');
    m.destroy();
  });

  it('cancels without a drop when pointercancel fires during dragging', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    expect(cb.onPromote).toHaveBeenCalledTimes(1);

    window.dispatchEvent(pointerEvent('pointercancel', 100, 100));

    expect(cb.onDrop).not.toHaveBeenCalled();
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('dnd-dragging')).toBe(false);
    m.destroy();
  });

  it('recomputes the candidate against live rects (no cache — re-queried every frame)', () => {
    // Round-4 finding #3: the controller used to cache target rects
    // and only invalidate on scroll/resize, leaving a target that
    // moved (or was just mounted) mid-gesture invisible until the
    // next scroll. Now collectTargets re-queries the DOM every call;
    // mutating a target rect is picked up on the very next pointermove
    // with no scroll event required.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const target = installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();

    // Mutate the rect mid-drag without firing scroll/resize.
    target.getBoundingClientRect = () =>
      ({
        left: 500,
        top: 0,
        right: 560,
        bottom: 30,
        width: 60,
        height: 30,
        x: 500,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    window.dispatchEvent(pointerEvent('pointermove', 530, 15));
    flushRaf();

    const lastCandidate = cb.onCandidateChange.mock.calls.at(-1)?.[0];
    expect(lastCandidate).toEqual({
      targetId: 'project-1:status:todo',
      placement: 'on',
      index: null,
      isCard: false,
      sourceIssueId: 'issue-1',
      sourceProjectId: null,
    });
    m.destroy();
  });

  it('picks up a target mounted mid-drag on the next pointermove (no scroll/resize needed)', () => {
    // Round-4 finding #3 regression guard: a shape sync that adds a
    // status column (or any lazily-rendered section) DURING a drag
    // must become a candidate on the next pointer move without any
    // scroll/resize event. The DOM re-query is fresh per frame.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    expect(cb.onCandidateChange).not.toHaveBeenCalled();

    // Mid-drag shape sync: install a NEW target without firing scroll
    // or resize events. The next pointermove must pick it up.
    installDropTarget('project-1:status:done', 'project-1', {
      left: 400,
      top: 0,
      right: 460,
      bottom: 30,
    });

    window.dispatchEvent(pointerEvent('pointermove', 430, 15));
    flushRaf();

    expect(cb.onCandidateChange).toHaveBeenLastCalledWith({
      targetId: 'project-1:status:done',
      placement: 'on',
      index: null,
      isCard: false,
      sourceIssueId: 'issue-1',
      sourceProjectId: null,
    });
    m.destroy();
  });

  it('filters cross-project non-card targets at the controller', () => {
    // Non-card targets (columns, tree-status rows) from a different
    // project are filtered out by the controller (data-drop-target-project
    // !== source.projectId). Cross-project rejection for card targets is
    // unnecessary (cards are status-scoped).
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-2:status:todo', 'project-2', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource('issue-1', 'project-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const callsWithCrossProject = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId ===
        'project-2:status:todo',
    );
    expect(callsWithCrossProject.length).toBe(0);
    m.destroy();
  });

  it('filters drop targets whose acceptKinds do not include the source kind', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'project-1:status:todo',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'other-kind',
    );

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    // Different acceptKinds → ignored → no candidate.
    // Assert that onCandidateChange was never called with a non-null targetId.
    const nonNullCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId !== null,
    );
    expect(nonNullCalls).toHaveLength(0);
    m.destroy();
  });

  it('destroy() removes all window listeners and resets state', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    m.destroy();
    const types = removeSpy.mock.calls.map((c) => c[0]);
    // scroll/resize attach only after promotion; this gesture stays pressing.
    expect(types).toEqual(
      expect.arrayContaining([
        'pointermove',
        'pointerup',
        'pointercancel',
        'keydown',
      ]),
    );
    expect(types).not.toContain('scroll');
    expect(types).not.toContain('resize');
    for (const call of removeSpy.mock.calls) {
      expect(typeof call[1]).toBe('function');
    }
    removeSpy.mockRestore();
  });

  it('restores user-select even if onDrop throws', () => {
    const cb = makeCallbacks();
    cb.onDrop.mockImplementation(() => {
      throw new Error('boom');
    });
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    const errHandler = (e: ErrorEvent) => {
      e.preventDefault();
    };
    window.addEventListener('error', errHandler);
    try {
      m.startPress(makeSource(), null, {
        clientX: 0,
        clientY: 0,
        pointerId: 1,
      });
      window.dispatchEvent(pointerEvent('pointermove', 100, 100));
      flushRaf();
      window.dispatchEvent(pointerEvent('pointerup', 230, 15));
    } finally {
      window.removeEventListener('error', errHandler);
    }
    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    expect(document.body.style.userSelect).toBe('');
    m.destroy();
  });

  it('respects DROP_THRESHOLD_PX (far-away target not picked)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:far', 'project-1', {
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();

    const candidateCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId !== null,
    );
    expect(candidateCalls.length).toBe(0);
    m.destroy();
    expect(DROP_THRESHOLD_PX).toBeGreaterThan(0);
  });

  it('swallows the synthetic click after a promoted drag (one-shot capture-phase)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    const stopSpy = vi.fn();
    const preventSpy = vi.fn();
    const captureClick = (): MouseEvent => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'stopPropagation', { value: stopSpy });
      Object.defineProperty(e, 'preventDefault', { value: preventSpy });
      return e;
    };
    const origDoc = document.addEventListener.bind(document);
    const wrapped: typeof document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'click') {
        (m as unknown as { __swallower: EventListener }).__swallower =
          listener as EventListener;
      }
      return origDoc(type, listener, opts);
    }) as typeof document.addEventListener;
    document.addEventListener = wrapped;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointerup', 230, 15));
    const click = captureClick();
    const swallower = (m as unknown as { __swallower: EventListener })
      .__swallower;
    expect(swallower).toBeTypeOf('function');
    swallower(click);

    expect(stopSpy).toHaveBeenCalled();
    expect(preventSpy).toHaveBeenCalled();
    document.addEventListener = origDoc;
    m.destroy();
  });

  it('P5-E4: destroy() during an in-flight drag fires onDragEnd exactly once and keeps the click swallower attached', () => {
    // Regression: the round-1 bug returned when a consumer unmounted
    // mid-drag. `destroy()` used to call `detachClickSwallower()`, so
    // the synthetic click fired after the synthetic pointerup reached
    // react-arborist and routed to navigation (handleActivate). The
    // P5-E4 contract: if a drag is in flight, `destroy()` first
    // `cancel()`s (preserves the click-swallower contract — cancel
    // never detaches), then tears down. The swallower stays attached
    // until the browser's `once:true` fires it on the next click, OR
    // until the next `startPress()`'s re-entry guard detaches it.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    let captured: EventListener | null = null;
    const origAdd = document.addEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'click' && !captured) {
        captured = listener as EventListener;
      }
      return origAdd(type, listener, opts);
    }) as typeof document.addEventListener;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    expect(captured).not.toBeNull();
    // Mid-drag destroy (consumer unmounted). onDragEnd fires exactly
    // once. The click swallower stays attached — the next synthetic
    // click MUST be swallowed.
    m.destroy();
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    const removedClickCalls = removeDocSpy.mock.calls.filter(
      (c) => c[0] === 'click',
    );
    expect(removedClickCalls.length).toBe(0);
    // The captured swallower still swallows a synthetic click fired
    // after destroy(): the round-1 bug would let it fall through.
    const stopSpy = vi.fn();
    const preventSpy = vi.fn();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(click, 'stopPropagation', { value: stopSpy });
    Object.defineProperty(click, 'preventDefault', { value: preventSpy });
    captured!(click);
    expect(stopSpy).toHaveBeenCalled();
    expect(preventSpy).toHaveBeenCalled();

    document.addEventListener = origAdd;
    removeDocSpy.mockRestore();
  });

  it('destroy() after a completed drag keeps the click swallower attached (relies on once:true / next startPress to clean up)', () => {
    // After a clean drop (pointerup over target → cancel → state idle)
    // the swallower is STILL on document. `destroy()` no longer eagerly
    // detaches it (P5-E4). The browser's `once:true` will fire it on
    // the next click; if the controller is restarted before any click
    // happens, `startPress()`'s re-entry guard detaches the stale one.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    let captured: EventListener | null = null;
    const origAdd = document.addEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'click' && !captured) {
        captured = listener as EventListener;
      }
      return origAdd(type, listener, opts);
    }) as typeof document.addEventListener;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    expect(captured).not.toBeNull();
    window.dispatchEvent(pointerEvent('pointerup', 230, 15));
    m.destroy();
    // destroy() after a clean cancel must NOT eagerly detach the
    // swallower. The one-shot still swallows the synthetic click that
    // follows pointerup.
    const removedClickCalls = removeDocSpy.mock.calls.filter(
      (c) => c[0] === 'click',
    );
    expect(removedClickCalls.length).toBe(0);

    document.addEventListener = origAdd;
    removeDocSpy.mockRestore();
  });

  it('keeps the one-shot click swallower attached after cancel (so the eventual click is swallowed, not navigated)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');
    const origAdd = document.addEventListener.bind(document);
    let captured: EventListener | null = null;
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'click' && !captured) {
        captured = listener as EventListener;
      }
      return origAdd(type, listener, opts);
    }) as typeof document.addEventListener;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // ESC during a promoted drag — cancel() must NOT eagerly detach the
    // one-shot click swallower. The browser removes it after the first
    // click; if we removed it ourselves, the synthetic click fired on
    // pointerup could navigate.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(captured).not.toBeNull();
    const removedClickTypes = removeDocSpy.mock.calls
      .filter((c) => c[0] === 'click')
      .map((c) => c[0]);
    expect(removedClickTypes).toEqual([]);

    document.addEventListener = origAdd;
    removeDocSpy.mockRestore();
    m.destroy();
  });

  it('surfaces a "before" placement when the pointer is in the top third of a target', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Pointer at (230, 5) — inside the target, top third (height=30, topThird=10).
    window.dispatchEvent(pointerEvent('pointermove', 230, 5));
    flushRaf();

    expect(cb.onCandidateChange).toHaveBeenLastCalledWith({
      targetId: 'project-1:status:todo',
      placement: 'before',
      index: null,
      isCard: false,
      sourceIssueId: 'issue-1',
      sourceProjectId: null,
    });
    m.destroy();
  });

  it('always emits placement "on" on onDrop for issue-move (future reorder kinds consume "before"/"after")', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    // Tall target so the final pointer position lands in the middle third.
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 90,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Pointer well in the middle third (height=90, topThird=30, bottomThird=60).
    window.dispatchEvent(pointerEvent('pointerup', 230, 45));

    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    const completion = cb.onDrop.mock.calls[0]![0] as DragCompletion;
    expect(completion.placement).toBe('on');
    m.destroy();
  });

  it('onDragEnd does NOT fire on ESC cancel during pressing (no drag occurred)', () => {
    // Round-4 finding #4: cancel() used to fire onDragEnd for every
    // gesture, including sub-threshold releases and ESC-during-press
    // (no drag ever lifted). The provider's active flag must stay in
    // sync, so onDragEnd only fires for real drags.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    m.destroy();
  });

  it('onDragEnd fires on ESC cancel during dragging', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  it('onDragEnd fires after a successful drop', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointerup', 230, 15));
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  it('regression: starting a new drag after an ESC-cancelled drag does NOT leak a document-level click swallower (every install has a matching remove)', () => {
    // Round-3 finding #1: prior to the fix, promote() on the SECOND drag
    // overwrote `this.clickSwallower` with a fresh closure while the old
    // one stayed on `document`. Only the current field got removed by
    // destroy()/detachClickSwallower(), so the stale swallower would
    // eat an arbitrary future click. Spy on add/remove on document and
    // verify every install has a matching remove by (type, listener,
    // capture).
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    const addDocSpy = vi.spyOn(document, 'addEventListener');
    const removeDocSpy = vi.spyOn(document, 'removeEventListener');

    // First drag: press, promote via movement, ESC → cancel (swallower
    // intentionally NOT detached by cancel()).
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Second drag: startPress must eagerly detach the stale swallower
    // (the guard in startPress); promote installs a fresh one.
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Tear down mid-drag. P5-E4 contract: destroy() cancels the in-flight
    // drag (so onDragEnd fires exactly once) but does NOT eagerly
    // detach the click swallower — that is left to the browser's
    // `once:true` (on next click) or the next `startPress()`'s
    // re-entry guard. Verify the second install is NOT detached by
    // destroy(), but IS detached by the NEXT startPress() (no leak
    // in production).
    m.destroy();

    type Triple = { listener: EventListener; capture: boolean };
    const captureOf = (opts?: boolean | AddEventListenerOptions): boolean => {
      if (typeof opts === 'boolean') return opts;
      return !!opts?.capture;
    };
    const installed: Triple[] = [];
    for (const call of addDocSpy.mock.calls) {
      if (call[0] !== 'click') continue;
      installed.push({
        listener: call[1] as EventListener,
        capture: captureOf(call[2] as boolean | AddEventListenerOptions),
      });
    }
    const removed: Triple[] = [];
    for (const call of removeDocSpy.mock.calls) {
      if (call[0] !== 'click') continue;
      removed.push({
        listener: call[1] as EventListener,
        capture: captureOf(call[2] as boolean | AddEventListenerOptions),
      });
    }

    // The FIRST install (swallower1) MUST have a matching remove —
    // the second drag's startPress eagerly detached it. The SECOND
    // install (swallower2) has NO matching remove after destroy():
    // it stays attached and is cleaned by once:true / next startPress.
    // Verify exactly: first install matched, second install unmatched
    // at this point.
    expect(installed.length).toBeGreaterThanOrEqual(2);
    const firstInst = installed[0]!;
    const lastInst = installed[installed.length - 1]!;
    const firstMatched = removed.some(
      (r) =>
        r.listener === firstInst.listener && r.capture === firstInst.capture,
    );
    expect(firstMatched).toBe(true);
    const lastMatchedBeforeNextStart = removed.some(
      (r) => r.listener === lastInst.listener && r.capture === lastInst.capture,
    );
    expect(lastMatchedBeforeNextStart).toBe(false);

    // A third startPress must detach the stale swallower left by
    // destroy() — this is the production cleanup path when the user
    // starts a new drag before any synthetic click fires.
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    const removedAfter = (removeDocSpy.mock.calls as unknown[][])
      .filter((c) => c[0] === 'click')
      .map(
        (c) =>
          ({
            listener: c[1] as EventListener,
            capture: captureOf(c[2] as boolean | AddEventListenerOptions),
          }) as Triple,
      );
    const lastMatchedAfterNextStart = removedAfter.some(
      (r) => r.listener === lastInst.listener && r.capture === lastInst.capture,
    );
    expect(lastMatchedAfterNextStart).toBe(true);

    m.destroy();
    addDocSpy.mockRestore();
    removeDocSpy.mockRestore();
  });

  it('project-reorder source collects OTHER project rows as targets (peer included, self excluded)', () => {
    // Project rows register their OWN id as both `data-drop-target-id`
    // and `data-drop-target-project`. The per-node equality filter
    // (`data-drop-target-project === source.projectId`) would reject
    // every peer, so project-reorder swaps it for a self-id exclusion
    // (`data-drop-target-id !== source.projectId`). Verify: another
    // project row with a different id is collected; the dragged row
    // itself is NOT collected (no self-candidate).
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    // Peer project row (different id) — should be collected.
    installDropTarget(
      'project-OTHER',
      'project-OTHER',
      { left: 200, top: 0, right: 260, bottom: 30 },
      'project-reorder',
    );
    // Dragged source's own row — should be excluded via self-id check.
    installDropTarget(
      'project-1',
      'project-1',
      { left: 0, top: 0, right: 60, bottom: 30 },
      'project-reorder',
    );

    m.startPress({ kind: 'project-reorder', projectId: 'project-1' }, null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const callsWithNonNullTarget = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId !== null,
    );
    // Peer project row lands as a candidate (its id is `project-OTHER`).
    expect(callsWithNonNullTarget.length).toBeGreaterThan(0);
    expect(
      callsWithNonNullTarget.some(
        (c) =>
          (c[0] as { targetId: string | null }).targetId === 'project-OTHER',
      ),
    ).toBe(true);
    // Self row never appears as a candidate.
    expect(
      callsWithNonNullTarget.some(
        (c) => (c[0] as { targetId: string | null }).targetId === 'project-1',
      ),
    ).toBe(false);

    m.destroy();
  });

  it('project-reorder source sets candidate.sourceProjectId (and leaves sourceIssueId null)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'project-OTHER',
      'project-OTHER',
      { left: 200, top: 0, right: 260, bottom: 30 },
      'project-reorder',
    );

    m.startPress({ kind: 'project-reorder', projectId: 'project-1' }, null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const lastCandidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
      sourceIssueId: string | null;
      sourceProjectId: string | null;
    };
    expect(lastCandidate.targetId).toBe('project-OTHER');
    expect(lastCandidate.sourceProjectId).toBe('project-1');
    expect(lastCandidate.sourceIssueId).toBeNull();
    m.destroy();
  });

  it('issue-move source leaves candidate.sourceProjectId null', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const lastCandidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
      sourceIssueId: string | null;
      sourceProjectId: string | null;
    };
    expect(lastCandidate.targetId).toBe('project-1:status:todo');
    expect(lastCandidate.sourceProjectId).toBeNull();
    expect(lastCandidate.sourceIssueId).toBe('issue-1');
    m.destroy();
  });
});

// ---------------------------------------------------------------------------
// Self-exclusion: the dragged issue card is never a valid drop target for
// itself (collected targets must exclude the source id).
// ---------------------------------------------------------------------------

describe('DragController issue-move self-exclusion', () => {
  it('excludes the dragged source card from collected targets', () => {
    // The dragged card itself registers as a drop target (KanbanCard
    // wires `useDropTarget(source.issueId, source.projectId, …)`).
    // The controller must filter it out so a card never becomes its
    // own candidate — same pattern as the project-reorder branch.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const selfCard = installDropTarget(
      'issue-1',
      'project-1',
      {
        left: 0,
        top: 0,
        right: 60,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );
    // Move the self-card under the pointer so an unfiltered controller
    // would resolve it as the candidate.
    selfCard.getBoundingClientRect = () =>
      ({
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
        width: 60,
        height: 30,
        x: 200,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    m.startPress(makeSource('issue-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const callsWithSelf = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-1',
    );
    expect(callsWithSelf).toHaveLength(0);
    m.destroy();
  });

  it('still picks up other (peer) issue cards in the same project as candidates', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const callsWithPeer = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-2',
    );
    expect(callsWithPeer.length).toBeGreaterThan(0);
    m.destroy();
  });

  it('always passes index: null on onCandidateChange (no positional slot)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    for (const call of cb.onCandidateChange.mock.calls) {
      expect((call[0] as { index: unknown }).index).toBeNull();
    }
    m.destroy();
  });

  it('clears the candidate when the pointer is over the source card snapshot slot', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const { card } = installSourceCardInColumn('issue-1', 'status-1');
    // Peer card elsewhere in the same column.
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Pointer back over the source card's ORIGINAL slot (snapshot rect
    // [0,60]x[0,30]) → candidate resolves to null (drop-on-self no-op).
    // jsdom has no `document.elementFromPoint`, so the controller falls
    // back to the snapshot-rect test alone — exactly the case the
    // primary test must still cover.
    window.dispatchEvent(pointerEvent('pointermove', 30, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
    };
    expect(last.targetId).toBeNull();
    m.destroy();
  });

  it('keeps the candidate when the source slot is occupied by a NON-source card (swap preview) — elementFromPoint polyfilled', () => {
    // Backup for the primary test: after the swap preview reorders the
    // DOM, the source card's ORIGINAL slot is occupied by a different
    // card. The snapshot-rect test alone would falsely read a hover on
    // that slot as "over self". The secondary elementFromPoint test
    // checks the actual element under the pointer and keeps the
    // candidate. jsdom doesn't implement elementFromPoint, so we patch
    // it for the duration of this test.
    //
    // Scenario: the user is dragging peer card (issue-2) as the swap
    // target (a previous pointermove made the candidate = issue-2). At
    // pointerup, the pointer is over the source card's ORIGINAL swap
    // slot, but the swap preview has moved the source card away — the
    // peer card is now under the pointer. Without the fix, the
    // sticky-restore in `handleMouseUp` would refuse to restore the
    // saved candidate (since isPointerOverSource would return true via
    // the snapshot-rect check alone). With the fix, isPointerOverSource
    // returns false (snapshot rect check passes, but elementFromPoint
    // shows the peer card), and the saved candidate is restored — the
    // drop fires against the peer.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const { card } = installSourceCardInColumn('issue-1', 'status-1');
    // Move the source snapshot slot to (200, 0, 260, 30) so the
    // elementFromPoint call lands inside something controlled.
    card.getBoundingClientRect = () =>
      ({
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
        width: 60,
        height: 30,
        x: 200,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    // Peer card with snapshot rect (0, 0, 60, 30) — a previous pointermove
    // over the peer establishes a card candidate.
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 0,
        top: 0,
        right: 60,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    // Polyfill elementFromPoint: at (200, 0)–(260, 30) return the
    // peer card (the element occupying the source's original snapshot
    // slot after swap preview reorder).
    const originalHadEFP = 'elementFromPoint' in document;
    const originalEFP = (
      document as unknown as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }
    ).elementFromPoint;
    let efpInstalled = false;
    (
      document as unknown as {
        elementFromPoint: (x: number, y: number) => Element | null;
      }
    ).elementFromPoint = (x: number) => {
      if (x >= 200 && x <= 260) {
        return document.querySelector('[data-dnd-card-issue-id="issue-2"]');
      }
      return null;
    };
    efpInstalled = true;

    try {
      m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
        clientX: 0,
        clientY: 0,
        pointerId: 1,
      });
      window.dispatchEvent(pointerEvent('pointermove', 100, 100));
      flushRaf();
      // Establishing pointermove: pointer over the peer card's snapshot
      // rect → candidate = issue-2.
      window.dispatchEvent(pointerEvent('pointermove', 30, 15));
      flushRaf();
      const before = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
        targetId: string | null;
      };
      expect(before.targetId).toBe('issue-2');

      // Mouseup at (230, 15) — inside the source card's snapshot rect
      // (lands on the slot the source card USED to occupy before the
      // swap preview moved it). Without the fix, isPointerOverSource
      // returns true (snapshot rect check alone) → the sticky-restore
      // refuses to restore the saved candidate → no drop. With the
      // fix, elementFromPoint shows the peer card → isPointerOverSource
      // returns false → the saved candidate is restored → onDrop fires
      // against the peer.
      window.dispatchEvent(pointerEvent('pointerup', 230, 15));
      expect(cb.onDrop).toHaveBeenCalledTimes(1);
      const completion = cb.onDrop.mock.calls[0]![0] as { targetId: string };
      expect(completion.targetId).toBe('issue-2');
    } finally {
      // Restore document.elementFromPoint so subsequent tests run without
      // the polyfill (the controller's fallback branch must remain
      // exercised in jsdom).
      if (efpInstalled) {
        if (originalHadEFP) {
          (
            document as unknown as { elementFromPoint: typeof originalEFP }
          ).elementFromPoint = originalEFP;
        } else {
          delete (document as unknown as { elementFromPoint?: unknown })
            .elementFromPoint;
        }
      }
      m.destroy();
    }
  });

  it('does NOT clear the candidate when the pointer leaves the source slot (swap preview moved the card)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const { card } = installSourceCardInColumn('issue-1', 'status-1');
    // Peer card in the same column — valid swap target.
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Pointer over the peer (NOT the source snapshot slot) → candidate stays.
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
    };
    expect(last.targetId).toBe('issue-2');
    m.destroy();
  });

  it('emits no onDrop when pointerup happens over the source card snapshot slot', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const { card } = installSourceCardInColumn('issue-1', 'status-1');
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Establish a peer candidate first.
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();
    expect(cb.onDrop).not.toHaveBeenCalled();
    // Release over the source card's snapshot slot → no drop.
    window.dispatchEvent(pointerEvent('pointerup', 30, 15));
    expect(cb.onDrop).not.toHaveBeenCalled();
    m.destroy();
  });

  it('emits onDrop when pointerup happens over a peer card (valid swap)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const { card } = installSourceCardInColumn('issue-1', 'status-1');
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();
    // Release over the peer → drop fires.
    window.dispatchEvent(pointerEvent('pointerup', 230, 15));
    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  it('P4-BUG2: when the source element is null at press time, sourceCardRects is empty → isPointerOverSource falls back to elementFromPoint and clears the candidate', () => {
    // Before the fix: source element = null at startPress → the
    // promote-time snapshot never captured the source card rect → the
    // primary `sourceCardRects?.get(src.issueId)` lookup returned
    // undefined → isPointerOverSource ALWAYS returned false
    // regardless of where the pointer was. Dropping on the source
    // card would fire onDrop (no self-hint). After the fix the
    // elementFromPoint fallback match against
    // `[data-dnd-card-issue-id="issue-1"]` clears the candidate, so
    // the drop is correctly suppressed.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    // Install the source card in a column so the DOM has a node
    // matching the dataset selector. The press will pass `null` as the
    // captured element, so no promote-time snapshot is captured.
    installSourceCardInColumn('issue-1', 'status-1');
    // Peer card as a valid swap target.
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    // Polyfill elementFromPoint: at (30, 15) return the source card
    // (the snapshot rect path is bypassed because startPress was
    // called with element = null, so the controller's promote-time
    // capture found `sourceColumnEl = null` and `sourceCardRects`
    // stays empty).
    const originalHadEFP = 'elementFromPoint' in document;
    const originalEFP = (
      document as unknown as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }
    ).elementFromPoint;
    (
      document as unknown as {
        elementFromPoint: (x: number, y: number) => Element | null;
      }
    ).elementFromPoint = (x: number, y: number): Element | null => {
      if (x === 30 && y === 15) {
        return document.querySelector('[data-dnd-card-issue-id="issue-1"]');
      }
      return null;
    };

    try {
      m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
        clientX: 0,
        clientY: 0,
        pointerId: 1,
      });
      window.dispatchEvent(pointerEvent('pointermove', 100, 100));
      flushRaf();
      // Establish a peer candidate.
      window.dispatchEvent(pointerEvent('pointermove', 230, 15));
      flushRaf();
      const before = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
        targetId: string | null;
      };
      expect(before.targetId).toBe('issue-2');

      // Pointer now over the source card (per elementFromPoint) → the
      // elementFromPoint fallback in isPointerOverSource recognises
      // the self-hover and clears the candidate.
      window.dispatchEvent(pointerEvent('pointermove', 30, 15));
      flushRaf();
      const after = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
        targetId: string | null;
      };
      expect(after.targetId).toBeNull();

      // Release over the source — no drop.
      window.dispatchEvent(pointerEvent('pointerup', 30, 15));
      expect(cb.onDrop).not.toHaveBeenCalled();
    } finally {
      // Restore document.elementFromPoint so subsequent tests run
      // against the regular jsdom surface.
      if (originalHadEFP) {
        (
          document as unknown as { elementFromPoint: typeof originalEFP }
        ).elementFromPoint = originalEFP;
      } else {
        delete (document as unknown as { elementFromPoint?: unknown })
          .elementFromPoint;
      }
      m.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Vertical-only swap + cross-column move: target filtering for issue-move
// drags is now driven by `data-drop-target-status` (presence on cards only)
// and `data-drop-target-id` (for columns). Same column = swap; different
// column = move.
// ---------------------------------------------------------------------------

describe('DragController issue-move target filtering by statusId', () => {
  it('includes a same-column card (matching data-drop-target-status)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const peerCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-2',
    );
    expect(peerCalls.length).toBeGreaterThan(0);
    m.destroy();
  });

  it('excludes a different-column card (mismatched data-drop-target-status)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-2',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const peerCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-2',
    );
    expect(peerCalls).toHaveLength(0);
    m.destroy();
  });

  it('excludes a same-column column target (own status id)', () => {
    // KanbanCards registers with id=source.statusId and no
    // data-drop-target-status attr. The filter must treat it as a
    // column and reject when the id equals the source's status.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('status-1', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const sameColumnCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'status-1',
    );
    expect(sameColumnCalls).toHaveLength(0);
    m.destroy();
  });

  it('includes a different-column column target as a move candidate', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('status-2', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const moveCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'status-2',
    );
    expect(moveCalls.length).toBeGreaterThan(0);
    m.destroy();
  });

  it('resolves the insertion index for a cross-column column target from the column card slots', () => {
    // Cards in status-2 at [0,30], [60,90] → midpoints 15, 75. Pointer at
    // y=80 lands between the first midpoint and the second → index 1.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    // Column spans the full card range.
    installDropTarget('status-2', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 90,
    });
    // Cards registered as drop targets in the TARGET column (different
    // status) — the controller reads these for the insertion index.
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
      },
      'issue-move',
      'status-2',
    );
    installDropTarget(
      'issue-3',
      'project-1',
      {
        left: 200,
        top: 60,
        right: 260,
        bottom: 90,
      },
      'issue-move',
      'status-2',
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Pointer over the target column at y=70 → past first card's midpoint
    // (15), at/below second's midpoint (75) → index 1.
    window.dispatchEvent(pointerEvent('pointermove', 230, 70));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
      index: number | null;
    };
    expect(last.targetId).toBe('status-2');
    expect(last.index).toBe(1);
    m.destroy();
  });

  it('does not resolve an insertion index for a tree-status target', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:status-2', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
      index: number | null;
    };
    expect(last.targetId).toBe('project-1:status:status-2');
    expect(last.index).toBeNull();
    m.destroy();
  });

  it('EC4: resolveColumnInsertIndex returns null when the matching id resolves to a CARD (isCardTarget true)', () => {
    // P4 test-gap: `resolveColumnInsertIndex` queries by
    // `[data-drop-target-id="..."]` and bails out with `null` when
    // the first match is a card element (has `data-drop-target-status`).
    // This is the defensive guard against a shared-namespace collision:
    // a card whose id matches a column id. The controller's column
    // branch picks the column as the candidate (findBestCandidate
    // distinguishes by `isCard`), but the resolver's element lookup
    // can hit the card first. Without the `isCardTarget(el)` guard,
    // a meaningless card-slot index would leak into the resolver.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    // A CARD element with id matching a status column id. Headers
    // always appear first in the DOM.
    const card = document.createElement('div');
    card.setAttribute('data-drop-target-id', 'status-2');
    card.setAttribute('data-drop-target-project', 'project-1');
    card.setAttribute('data-drop-target-accept-kinds', 'issue-move');
    card.setAttribute('data-drop-target-status', 'status-2');
    card.getBoundingClientRect = () =>
      ({
        left: 200,
        top: 0,
        right: 260,
        bottom: 30,
        width: 60,
        height: 30,
        x: 200,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(card);
    // The COLUMN element with the same id, placed AFTER the card in
    // the DOM so document.querySelector returns the card first.
    // Without the resolver's `isCardTarget` guard, the resolver would
    // happily compute an index from the card's geometry even though
    // the candidate was the column.
    installDropTarget('status-2', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    window.dispatchEvent(pointerEvent('pointermove', 230, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
      index: number | null;
    };
    expect(last.targetId).toBe('status-2');
    // The resolver recognised the first matching element as a card
    // and bailed out → index is null.
    expect(last.index).toBeNull();
    m.destroy();
  });

  it('excludes both card and column targets in the same column (peer card ok, own column rejected)', () => {
    // Dragging within a column must pick up peer cards as swap candidates
    // but NEVER surface the source column itself as a move target.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(
      'issue-2',
      'project-1',
      {
        left: 100,
        top: 0,
        right: 160,
        bottom: 30,
      },
      'issue-move',
      'status-1',
    );
    installDropTarget('status-1', 'project-1', {
      left: 400,
      top: 0,
      right: 460,
      bottom: 30,
    });

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    // First move promotes (rAF NOT scheduled on the promote frame).
    window.dispatchEvent(pointerEvent('pointermove', 100, 100));
    flushRaf();
    // Second move lands inside issue-2's rect and triggers rAF.
    window.dispatchEvent(pointerEvent('pointermove', 130, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
    };
    expect(last.targetId).toBe('issue-2');
    // No emit with targetId=status-1 (same-column column filtered out).
    const ownColumnCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'status-1',
    );
    expect(ownColumnCalls).toHaveLength(0);
    m.destroy();
  });
});

// ---------------------------------------------------------------------------
// pointerId tracking (P3-B3): the controller captures the press's pointerId
// and ignores foreign pointers (a second finger, a pen+mouse combo) that
// would otherwise overwrite lastClientX/Y and end the drag on the wrong
// pointerup.
// ---------------------------------------------------------------------------

describe('DragController pointerId filtering', () => {
  it('ignores pointermove from a foreign pointerId (two-finger / pen+mouse)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    // Press with pointerId 1.
    m.startPress(makeSource(), element, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    // Foreign pointer (pointerId 2) crosses the threshold → must NOT promote.
    window.dispatchEvent(pointerEvent('pointermove', 100, 100, 2));
    expect(cb.onPromote).not.toHaveBeenCalled();
    // Active pointer (pointerId 1) crosses the threshold → promotes.
    window.dispatchEvent(pointerEvent('pointermove', 100, 100, 1));
    expect(cb.onPromote).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  it('foreign pointerup does NOT end the drag; matching pointerup does', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    m.startPress(makeSource(), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100, 1));
    flushRaf();
    // Establish candidate.
    window.dispatchEvent(pointerEvent('pointermove', 230, 15, 1));
    flushRaf();
    expect(cb.onPromote).toHaveBeenCalledTimes(1);
    // Foreign pointerup → ignored, drag continues.
    window.dispatchEvent(pointerEvent('pointerup', 230, 15, 2));
    expect(cb.onDrop).not.toHaveBeenCalled();
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    // Matching pointerup → drop fires.
    window.dispatchEvent(pointerEvent('pointerup', 230, 15, 1));
    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  it('foreign pointercancel does NOT cancel the drag', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    m.startPress(makeSource(), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointermove', 100, 100, 1));
    flushRaf();
    expect(cb.onPromote).toHaveBeenCalledTimes(1);
    // Foreign pointercancel → ignored.
    window.dispatchEvent(pointerEvent('pointercancel', 100, 100, 2));
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    expect(cb.onDrop).not.toHaveBeenCalled();
    // Matching pointerup → drop fires.
    window.dispatchEvent(pointerEvent('pointerup', 230, 15, 1));
    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    m.destroy();
  });

  it('pointercancel during pressing stays silent on onDragEnd (sub-threshold gesture never became a drag)', () => {
    // P3 test-gap closure: the existing pointercancel test only covers
    // during-dragging. Sub-threshold press + pointercancel must also
    // NOT fire onDragEnd (gesture never lifted).
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    // Pointermove below threshold — never promotes.
    window.dispatchEvent(pointerEvent('pointermove', 1, 1, 1));
    expect(cb.onPromote).not.toHaveBeenCalled();
    // pointercancel fires for the active pointerId.
    window.dispatchEvent(pointerEvent('pointercancel', 1, 1, 1));
    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    expect(cb.onDrop).not.toHaveBeenCalled();
    m.destroy();
  });

  it('foreign pointercancel during pressing does NOT cancel (no drag started)', () => {
    // Symmetric with the during-dragging test: a foreign pointer's
    // cancel must never cancel the active press, even sub-threshold.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    window.dispatchEvent(pointerEvent('pointercancel', 0, 0, 2));
    // Press still alive: matching pointerup below threshold is a no-op
    // (sub-threshold release falls through as a plain click).
    window.dispatchEvent(pointerEvent('pointerup', 0, 0, 1));
    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    m.destroy();
  });
});
