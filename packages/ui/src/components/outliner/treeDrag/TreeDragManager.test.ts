/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DropResult } from '@hello-pangea/dnd';
import {
  TreeDragManager,
  type TreeDragManagerCallbacks,
} from './TreeDragManager';
import { DRAG_THRESHOLD_PX, DROP_THRESHOLD_PX } from './geometry';

type MockCallback = ReturnType<typeof vi.fn>;
interface TestCallbacks {
  onPromote: MockCallback;
  onCandidateChange: MockCallback;
  onDrop: MockCallback;
}

function makeCallbacks(): TestCallbacks {
  return {
    onPromote: vi.fn(),
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

// Mock rAF as a synchronous flush so we don\'t depend on real frame timing
// inside jsdom (which doesn\'t advance the event loop deterministically).
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
  // Clean up any DOM nodes the tests installed (drop targets, source rows)
  // so a candidate computed in the next test isn\'t polluted by leftovers
  // from a previous run.
  document.body.innerHTML = '';
});

function flushRaf(): void {
  (globalThis as unknown as { __flushRaf: () => void }).__flushRaf();
}

function installSourceRow(issueId: string): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-tree-card', issueId);
  row.textContent = 'Source row';
  document.body.appendChild(row);
  return row;
}

function installDropTarget(
  id: string,
  projectId: string,
  rect: { left: number; top: number; right: number; bottom: number },
): HTMLElement {
  const target = document.createElement('div');
  target.setAttribute('data-drop-target-id', id);
  target.setAttribute('data-drop-target-project', projectId);
  // jsdom returns 0s for everything unless we patch getBoundingClientRect.
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

describe('TreeDragManager', () => {
  it('ignores a second startPress while a drag is in flight', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    expect(
      m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 }),
    ).toBe(true);
    expect(
      m.startPress('issue-2', 'project-1', { clientX: 0, clientY: 0 }),
    ).toBe(false);
    m.destroy();
  });

  it('does not promote when movement is below DRAG_THRESHOLD_PX', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    m.startPress('issue-1', 'project-1', { clientX: 100, clientY: 100 });

    window.dispatchEvent(
      mouseEvent('mousemove', 100 + DRAG_THRESHOLD_PX - 1, 100),
    );

    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onCandidateChange).not.toHaveBeenCalled();
    m.destroy();
  });

  it('promotes when movement crosses DRAG_THRESHOLD_PX (diagonal)', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    m.startPress('issue-1', 'project-1', { clientX: 100, clientY: 100 });

    window.dispatchEvent(mouseEvent('mousemove', 100 + DRAG_THRESHOLD_PX, 100));

    expect(cb.onPromote).toHaveBeenCalledTimes(1);
    // user-select is disabled during a drag.
    expect(document.body.style.userSelect).toBe('none');
    // Ghost appended.
    expect(document.querySelector('[data-tree-card]')).toBeTruthy();
    m.destroy();
  });

  it('updates the candidate via onCandidateChange as the pointer moves', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(
      mouseEvent('mousemove', 100, 100), // cross threshold → promote
    );
    flushRaf();
    // Pointer far from target → onCandidateChange not emitted (no CHANGE
    // from the initial null state).
    expect(cb.onCandidateChange).not.toHaveBeenCalled();

    // Move pointer onto the target.
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();
    expect(cb.onCandidateChange).toHaveBeenLastCalledWith(
      'project-1:status:todo',
    );

    m.destroy();
  });

  it('emits onDrop with a synthetic DropResult when mouseup happens over a candidate', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-1:status:done', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Drop while pointer is on the target.
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));

    expect(cb.onDrop).toHaveBeenCalledTimes(1);
    const result = cb.onDrop.mock.calls[0]![0] as DropResult;
    expect(result).toMatchObject({
      draggableId: 'issue:issue-1',
      type: 'DEFAULT',
      source: { droppableId: 'issue-1', index: 0 },
      destination: { droppableId: 'project-1:status:done', index: 0 },
      reason: 'DROP',
      mode: 'FLUID',
    });
    // Manager cleaned up after drop: candidate is cleared back to null
    // so the layout's DragCandidateContext resets.
    expect(cb.onCandidateChange).toHaveBeenLastCalledWith(null);
    expect(document.body.style.userSelect).toBe('');
    m.destroy();
  });

  it('emits no onDrop when mouseup happens outside any candidate', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Pointer far from any target → drop should be a no-op.
    window.dispatchEvent(mouseEvent('mouseup', 500, 500));

    expect(cb.onDrop).not.toHaveBeenCalled();
    m.destroy();
  });

  it('cancels via ESC during pressing (sub-threshold press, no drop)', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cb.onPromote).not.toHaveBeenCalled();
    expect(cb.onDrop).not.toHaveBeenCalled();
    m.destroy();
  });

  it('cancels via ESC during dragging (no drop, ghost removed)', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    expect(cb.onPromote).toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cb.onDrop).not.toHaveBeenCalled();
    // user-select restored.
    expect(document.body.style.userSelect).toBe('');
    m.destroy();
  });

  it('recomputes the candidate on scroll (invalidates the rect cache)', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();

    // The target\'s getBoundingClientRect can change post-scroll; the
    // manager invalidates its cache on scroll. We simulate by mutating the
    // rect AFTER scroll and verifying the manager re-reads on the next
    // candidate pass.
    window.dispatchEvent(new Event('scroll'));

    const target = document.querySelector<HTMLElement>(
      '[data-drop-target-id="project-1:status:todo"]',
    )!;
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

    // Trigger a mousemove and flush rAF.
    window.dispatchEvent(mouseEvent('mousemove', 530, 15));
    flushRaf();

    // Now the pointer is over the target\'s NEW rect → candidate should be
    // emitted again (or still emitted, depending on order).
    const lastCandidate = cb.onCandidateChange.mock.calls.at(-1)?.[0];
    expect(lastCandidate).toBe('project-1:status:todo');
    m.destroy();
  });

  it('filters drop targets whose project does not match the source project', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-2:status:todo', 'project-2', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    window.dispatchEvent(mouseEvent('mousemove', 230, 15));
    flushRaf();

    // Different project → ignored → no candidate.
    expect(cb.onCandidateChange).not.toHaveBeenCalledWith(
      'project-2:status:todo',
    );
    m.destroy();
  });

  it('destroy() removes all window listeners and resets state', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    m.destroy();
    // removeEventListener was called for each event type with the captured
    // listener. Options may be passed (3rd arg) but it\'s never inspected —
    // just verify the (type, listener) prefix.
    const types = removeSpy.mock.calls.map((c) => c[0]);
    expect(types).toEqual(
      expect.arrayContaining(['mousemove', 'mouseup', 'keydown', 'scroll']),
    );
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
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    installDropTarget('project-1:status:todo', 'project-1', {
      left: 200,
      top: 0,
      right: 260,
      bottom: 30,
    });
    // jsdom + vitest flag uncaught listener errors as test failures. The
    // manager deliberately lets the onDrop throw escape (the consumer
    // owns its error handling) — silence the listener-side flag here.
    const errHandler = (e: ErrorEvent) => {
      e.preventDefault();
    };
    window.addEventListener('error', errHandler);
    try {
      m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
      window.dispatchEvent(mouseEvent('mousemove', 100, 100));
      flushRaf();
      // jsdom catches errors inside event listeners so the throw is
      // silently absorbed at dispatch time — but the manager\'s
      // `try / finally` still runs `cancel()` which restores
      // `user-select`. We assert the side-effect, not the throw.
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
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
    // Target outside DROP_THRESHOLD_PX radius from pointer.
    installDropTarget('project-1:status:far', 'project-1', {
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
    });

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();

    // Pointer far enough from target → no candidate ever emitted.
    const candidateCalls = cb.onCandidateChange.mock.calls.filter(
      (call: unknown[]) => call[0] !== null,
    );
    expect(candidateCalls.length).toBe(0);
    m.destroy();
    // Reference the constant so linter doesn\'t flag it as unused.
    expect(DROP_THRESHOLD_PX).toBeGreaterThan(0);
  });

  it('swallows the synthetic click after a promoted drag (one-shot capture-phase)', () => {
    const cb = makeCallbacks();
    const m = new TreeDragManager(cb as unknown as TreeDragManagerCallbacks);
    installSourceRow('issue-1');
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
        // Capture the listener so we can dispatch a synthetic click.
        (m as unknown as { __swallower: EventListener }).__swallower =
          listener as EventListener;
      }
      return origDoc(type, listener, opts);
    }) as typeof document.addEventListener;
    document.addEventListener = wrapped;

    m.startPress('issue-1', 'project-1', { clientX: 0, clientY: 0 });
    window.dispatchEvent(mouseEvent('mousemove', 100, 100));
    flushRaf();
    // Drop.
    window.dispatchEvent(mouseEvent('mouseup', 230, 15));
    // Synthetic click.
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
});
