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

function makeSource(issueId = 'issue-1', projectId = 'project-1'): DragSource {
  return { kind: 'issue-move', issueId, projectId };
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

function installDropTarget(
  id: string,
  projectId: string,
  rect: { left: number; top: number; right: number; bottom: number },
  acceptKinds = 'issue-move',
): HTMLElement {
  const target = document.createElement('div');
  target.setAttribute('data-drop-target-id', id);
  target.setAttribute('data-drop-target-project', projectId);
  target.setAttribute('data-drop-target-accept-kinds', acceptKinds);
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
      m.startPress(makeSource('issue-1'), element, { clientX: 0, clientY: 0 }),
    ).toBe(true);
    expect(
      m.startPress(makeSource('issue-2'), element, { clientX: 0, clientY: 0 }),
    ).toBe(false);
    m.destroy();
  });

  it('does not promote when movement is below DRAG_THRESHOLD_PX', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    const element = installSourceElement();
    m.startPress(makeSource(), element, { clientX: 100, clientY: 100 });

    window.dispatchEvent(
      mouseEvent('mousemove', 100 + DRAG_THRESHOLD_PX - 1, 100),
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
      sourceIssueId: 'issue-1',
      sourceProjectId: null,
    });
    m.destroy();
  });

  it('filters drop targets whose project does not match the source project', () => {
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

    expect(cb.onCandidateChange).not.toHaveBeenCalledWith({
      targetId: 'project-2:status:todo',
      placement: expect.anything(),
    });
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

    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
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
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    m.destroy();
    const types = removeSpy.mock.calls.map((c) => c[0]);
    // scroll/resize were only ever attached to invalidate a target
    // rect cache that no longer exists (round-4 #3).
    expect(types).toEqual(
      expect.arrayContaining(['mousemove', 'mouseup', 'keydown']),
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
      opts?: boolean | AddEventListenerOptions,
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
      (c) => c[0] === 'click',
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
      opts?: boolean | AddEventListenerOptions,
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
        (r) => r.listener === inst.listener && r.capture === inst.capture,
      );
      expect(
        matched,
        `click listener installed with capture=${inst.capture} was never removed`,
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
    });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
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
// Card insertion index resolution (kanban-column positional drops)
// ---------------------------------------------------------------------------

function installColumnCard(
  target: HTMLElement,
  issueId: string,
  top: number,
  bottom: number,
): HTMLElement {
  const card = document.createElement('div');
  card.setAttribute('data-dnd-card', '');
  card.setAttribute('data-dnd-card-issue-id', issueId);
  card.getBoundingClientRect = () =>
    ({
      left: 0,
      top,
      right: 200,
      bottom,
      width: 200,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  target.appendChild(card);
  return card;
}

const KANBAN_COL = '11111111-1111-4111-8111-111111111111';

function promoteOverColumn(
  m: DragController,
  column: HTMLElement,
  x: number,
  y: number,
): void {
  m.startPress(
    makeSource('issue-1'),
    document.querySelector('[data-source-id]'),
    {
      clientX: 0,
      clientY: 0,
    },
  );
  window.dispatchEvent(mouseEvent('mousemove', 5, 5));
  flushRaf();
  window.dispatchEvent(mouseEvent('mousemove', x, y));
  flushRaf();
}

describe('DragController card insertion index', () => {
  it('keeps index null for a tree-status target', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
    });
    promoteOverColumn(m, document.querySelector('div')!, 100, 100);
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      targetId: string;
      index: number | null;
    };
    expect(candidate.targetId).toBe('project-1:status:todo');
    expect(candidate.index).toBeNull();
    m.destroy();
  });

  it('computes index 0 when the pointer is above the first card midpoint', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const column = installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
    });
    installColumnCard(column, 'card-a', 100, 140); // midpoint 120
    promoteOverColumn(m, column, 100, 110); // above midpoint
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      index: number | null;
    };
    expect(candidate.index).toBe(0);
    m.destroy();
  });

  it('computes cards.length when the pointer is below the last card midpoint', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const column = installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
    });
    installColumnCard(column, 'card-a', 100, 140); // midpoint 120
    promoteOverColumn(m, column, 100, 130); // below midpoint
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      index: number | null;
    };
    expect(candidate.index).toBe(1);
    m.destroy();
  });

  it('computes 0 for an empty column', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
    });
    promoteOverColumn(m, document.querySelector('div')!, 100, 100);
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      index: number | null;
    };
    expect(candidate.index).toBe(0);
    m.destroy();
  });

  it('excludes the dragged source card from the count', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement('issue-1');
    const column = installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 400,
    });
    installColumnCard(column, 'issue-1', 100, 140); // the dragged source
    installColumnCard(column, 'card-b', 160, 200); // midpoint 180
    // pointer below card-b's midpoint → only card-b counted → index 1
    promoteOverColumn(m, column, 100, 190);
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      index: number | null;
    };
    expect(candidate.index).toBe(1);
    m.destroy();
  });

  it('passes the resolved index through to the drop completion', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const column = installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
    });
    installColumnCard(column, 'card-a', 100, 140);
    promoteOverColumn(m, column, 100, 110);
    window.dispatchEvent(mouseEvent('mouseup', 100, 110));
    const completion = cb.onDrop.mock.calls[0]?.[0] as DragCompletion;
    expect(completion.targetId).toBe(KANBAN_COL);
    expect(completion.index).toBe(0);
    m.destroy();
  });

  it('resolves midpoint-slot index across a 3-card column', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const column = installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 400,
    });
    // card-1 midpoint 120, card-2 midpoint 180, card-3 midpoint 240.
    installColumnCard(column, 'card-1', 100, 140);
    installColumnCard(column, 'card-2', 160, 200);
    installColumnCard(column, 'card-3', 220, 260);
    // Pointer between card-1 and card-2 midpoints → slot 1.
    promoteOverColumn(m, column, 100, 150);
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      index: number | null;
    };
    expect(candidate.index).toBe(1);
    m.destroy();
  });

  it('regression: resolveCardIndex reads the column element from the cached element map, NOT a fresh document.querySelector', () => {
    // Round-3 finding #14: prior to the fix, `resolveCardIndex` ran a
    // second `document.querySelector('[data-drop-target-id=…]')` per
    // rAF frame (the first pass lived in `collectTargets`). Now the
    // element map is cached alongside the rects. Spy on querySelector
    // and verify it is NOT called for the column lookup.
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    const column = installDropTarget(KANBAN_COL, 'project-1', {
      left: 0,
      top: 0,
      right: 200,
      bottom: 300,
    });
    installColumnCard(column, 'card-a', 100, 140);
    const querySpy = vi.spyOn(document, 'querySelector');

    promoteOverColumn(m, column, 100, 110);

    // After the drag, NO querySelector call should have targeted the
    // column element. The cached map in collectTargets is the SoT.
    const columnLookups = querySpy.mock.calls.filter((call) => {
      const sel = call[0];
      return (
        typeof sel === 'string' &&
        sel.includes(`[data-drop-target-id="${KANBAN_COL}"]`)
      );
    });
    expect(columnLookups).toHaveLength(0);

    // Sanity: the index was still resolved correctly.
    const candidate = cb.onCandidateChange.mock.calls.at(-1)?.[0] as {
      index: number | null;
    };
    expect(candidate.index).toBe(0);

    querySpy.mockRestore();
    m.destroy();
  });
});
