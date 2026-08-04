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

function mouseEvent(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
}

function makeSource(
  issueId = 'issue-1',
  projectId = 'project-1',
  statusId = 'status-1'
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
  statusId?: string
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
      m.startPress(makeSource('issue-1'), element, { clientX: 0, clientY: 0 })
    ).toBe(true);
    expect(
      m.startPress(makeSource('issue-2'), element, { clientX: 0, clientY: 0 })
    ).toBe(false);
    m.destroy();
  });

  it('does not promote when movement is below DRAG_THRESHOLD_PX', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    m.startPress(makeSource(), element, { clientX: 100, clientY: 100 });

    window.dispatchEvent(
      mouseEvent('mousemove', 100 + DRAG_THRESHOLD_PX - 1, 100)
    );

    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onCandidateChange).not.toHaveBeenCalled();
    m.destroy();
  });

  it('promotes when movement crosses DRAG_THRESHOLD_PX (diagonal)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    m.startPress(makeSource(), element, { clientX: 100, clientY: 100 });

    window.dispatchEvent(mouseEvent('mousemove', 100 + DRAG_THRESHOLD_PX, 100));

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
      'div[data-source-id="issue-1"]'
    );
    expect(fixed.length).toBe(2);
    const ghost = [...fixed].find(
      (el) => (el as HTMLElement).style.position === 'fixed'
    );
    expect(ghost).toBeTruthy();
    m.destroy();
    expect(document.body.classList.contains('dnd-dragging')).toBe(false);
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer far from target → onCandidateChange not emitted (no CHANGE
    // from the initial null state).
    expect(cb.onCandidateChange).not.toHaveBeenCalled();

    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
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

  it('emits onDrop with a DragCompletion when mouseup happens over a candidate', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:done', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));

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

  it('emits no onDrop when mouseup happens outside any candidate', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // The mousemove at (100,100) crosses the 5px threshold, so this
    // IS a real drag. The mouseup at (500,500) is just outside any
    // candidate → no onDrop but cancel() still fires onDragEnd because
    // the gesture lifted.
    window.dispatchEvent(mouseEvent('mouseup', 500, 500));

    expect(cb.onDrop).not.toHaveBeenCalled();
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('dnd-dragging')).toBe(false);
    m.destroy();
  });

  it('cancels via ESC during pressing (sub-threshold press, no drop)', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });

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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    expect(cb.onPromote).toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cb.onDrop).not.toHaveBeenCalled();
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.userSelect).toBe('');
    m.destroy();
  });

  it('recomputes the candidate against live rects (no cache — re-queried every frame)', () => {
    // Round-4 finding #3: the controller used to cache target rects
    // and only invalidate on scroll/resize, leaving a target that
    // moved (or was just mounted) mid-gesture invisible until the
    // next scroll. Now collectTargets re-queries the DOM every call;
    // mutating a target rect is picked up on the very next mousemove
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
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

    window.dispatchEvent(mouseEvent('mousemove', 530, 15));
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

  it('picks up a target mounted mid-drag on the next mousemove (no scroll/resize needed)', () => {
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    expect(cb.onCandidateChange).not.toHaveBeenCalled();

    // Mid-drag shape sync: install a NEW target without firing scroll
    // or resize events. The next mousemove must pick it up.
    installDropTarget('project-1:status:done', 'project-1', {
      left: 400,
      top: 0,
      right: 460,
      bottom: 30,
    });

    window.dispatchEvent(mouseEvent('mousemove', 430, 15));
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
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const callsWithCrossProject = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId ===
        'project-2:status:todo'
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
      'other-kind'
    );

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    // Different acceptKinds → ignored → no candidate.
    // Assert that onCandidateChange was never called with a non-null targetId.
    const nonNullCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId !== null
    );
    expect(nonNullCalls).toHaveLength(0);
    m.destroy();
  });

  it('destroy() removes all window listeners and resets state', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    m.destroy();
    const types = removeSpy.mock.calls.map((c) => c[0]);
    // scroll/resize were only ever attached to invalidate a target
    // rect cache that no longer exists (round-4 #3).
    expect(types).toEqual(
      expect.arrayContaining(['mousemove', 'mouseup', 'keydown'])
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
      m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
      window.dispatchEvent(mouseEvent('mousemove', 100, 100));
      flushRaf();
      window.dispatchEvent(mouseEvent('mouseup', 230, 15));
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();

    const candidateCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId !== null
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
      opts?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'click') {
        (m as unknown as { __swallower: EventListener }).__swallower =
          listener as EventListener;
      }
      return origDoc(type, listener, opts);
    }) as typeof document.addEventListener;
    document.addEventListener = wrapped;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));
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

  it('detaches the click swallower when destroy() runs (so the next click on a torn-down controller is not swallowed)', () => {
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
      opts?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'click' && !captured) {
        captured = listener as EventListener;
      }
      return origAdd(type, listener, opts);
    }) as typeof document.addEventListener;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    expect(captured).not.toBeNull();
    // drop the swallower via the same path that triggered installation
    // (promote), then tear the controller down. destroy() must remove the
    // document-level click listener that promote() added.
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));
    m.destroy();
    const removedClickCalls = removeDocSpy.mock.calls.filter(
      (c) => c[0] === 'click'
    );
    expect(removedClickCalls.length).toBeGreaterThanOrEqual(1);
    // The removed listener must be the one we installed (capture: true to
    // match how promote() added it).
    const removedOpts = removedClickCalls[0]?.[2];
    expect(removedOpts).toMatchObject({ capture: true });

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
      opts?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'click' && !captured) {
        captured = listener as EventListener;
      }
      return origAdd(type, listener, opts);
    }) as typeof document.addEventListener;

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // ESC during a promoted drag — cancel() must NOT eagerly detach the
    // one-shot click swallower. The browser removes it after the first
    // click; if we removed it ourselves, the synthetic click fired on
    // mouseup could navigate.
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer at (230, 5) — inside the target, top third (height=30, topThird=10).
    window.dispatchEvent(mouseEvent('mousemove', 230, 5));
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer well in the middle third (height=90, topThird=30, bottomThird=60).
    window.dispatchEvent(mouseEvent('mouseup', 230, 45));

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
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cb.onDragEnd).not.toHaveBeenCalled();
    m.destroy();
  });

  it('onDragEnd fires on ESC cancel during dragging', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
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
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));
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
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Second drag: startPress must eagerly detach the stale swallower
    // (the guard in startPress); promote installs a fresh one.
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Tear down. destroy() detaches the CURRENT swallower; we then
    // verify every document-level click install has a matching remove
    // with the same listener reference and capture flag.
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

    // Every install must have a matching remove (same listener ref +
    // capture flag). `once:true` is intentionally absent from remove
    // (the spec strips it — see round-3 #17 comment).
    for (const inst of installed) {
      const matched = removed.some(
        (r) => r.listener === inst.listener && r.capture === inst.capture
      );
      expect(
        matched,
        `click listener installed with capture=${inst.capture} was never removed`
      ).toBe(true);
    }

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
      'project-reorder'
    );
    // Dragged source's own row — should be excluded via self-id check.
    installDropTarget(
      'project-1',
      'project-1',
      { left: 0, top: 0, right: 60, bottom: 30 },
      'project-reorder'
    );

    m.startPress({ kind: 'project-reorder', projectId: 'project-1' }, null, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const callsWithNonNullTarget = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId !== null
    );
    // Peer project row lands as a candidate (its id is `project-OTHER`).
    expect(callsWithNonNullTarget.length).toBeGreaterThan(0);
    expect(
      callsWithNonNullTarget.some(
        (c) =>
          (c[0] as { targetId: string | null }).targetId === 'project-OTHER'
      )
    ).toBe(true);
    // Self row never appears as a candidate.
    expect(
      callsWithNonNullTarget.some(
        (c) => (c[0] as { targetId: string | null }).targetId === 'project-1'
      )
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
      'project-reorder'
    );

    m.startPress({ kind: 'project-reorder', projectId: 'project-1' }, null, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
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
      'status-1'
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

    m.startPress(makeSource('issue-1'), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const callsWithSelf = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-1'
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
      'status-1'
    );

    m.startPress(makeSource('issue-1'), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const callsWithPeer = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-2'
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
      'status-1'
    );

    m.startPress(makeSource('issue-1'), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
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
      'status-1'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer back over the source card's ORIGINAL slot (snapshot rect
    // [0,60]x[0,30]) → candidate resolves to null (drop-on-self no-op).
    window.dispatchEvent(mouseEvent('mousemove', 30, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
    };
    expect(last.targetId).toBeNull();
    m.destroy();
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
      'status-1'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer over the peer (NOT the source snapshot slot) → candidate stays.
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
    };
    expect(last.targetId).toBe('issue-2');
    m.destroy();
  });

  it('emits no onDrop when mouseup happens over the source card snapshot slot', () => {
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
      'status-1'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Establish a peer candidate first.
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();
    expect(cb.onDrop).not.toHaveBeenCalled();
    // Release over the source card's snapshot slot → no drop.
    window.dispatchEvent(mouseEvent('mouseup', 30, 15));
    expect(cb.onDrop).not.toHaveBeenCalled();
    m.destroy();
  });

  it('emits onDrop when mouseup happens over a peer card (valid swap)', () => {
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
      'status-1'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), card, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();
    // Release over the peer → drop fires.
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));
    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    m.destroy();
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
      'status-1'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const peerCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-2'
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
      'status-2'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const peerCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'issue-2'
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
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const sameColumnCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'status-1'
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
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const moveCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'status-2'
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
      'status-2'
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
      'status-2'
    );

    m.startPress(makeSource('issue-1', 'project-1', 'status-1'), null, {
      clientX: 0,
      clientY: 0,
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer over the target column at y=70 → past first card's midpoint
    // (15), at/below second's midpoint (75) → index 1.
    window.dispatchEvent(mouseEvent('mousemove', 230, 70));
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
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
      index: number | null;
    };
    expect(last.targetId).toBe('project-1:status:status-2');
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
      'status-1'
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
    });
    // First move promotes (rAF NOT scheduled on the promote frame).
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Second move lands inside issue-2's rect and triggers rAF.
    window.dispatchEvent(mouseEvent('mousemove', 130, 15));
    flushRaf();

    const last = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string | null;
    };
    expect(last.targetId).toBe('issue-2');
    // No emit with targetId=status-1 (same-column column filtered out).
    const ownColumnCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { targetId: string | null })?.targetId === 'status-1'
    );
    expect(ownColumnCalls).toHaveLength(0);
    m.destroy();
  });
});
