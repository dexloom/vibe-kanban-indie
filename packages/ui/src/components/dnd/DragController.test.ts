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
    });
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
    expect(document.body.style.userSelect).toBe('');
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
    window.dispatchEvent(mouseEvent('mouseup', 500, 500));

    expect(cb.onDrop).not.toHaveBeenCalled();
    // onDragEnd still fires on cancel.
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
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
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
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

  it('recomputes the candidate on scroll (invalidates the rect cache)', () => {
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

    window.dispatchEvent(mouseEvent('mousemove', 530, 15));
    flushRaf();

    const lastCandidate = cb.onCandidateChange.mock.calls.at(-1)?.[0];
    expect(lastCandidate).toEqual({
      targetId: 'project-1:status:todo',
      placement: 'on',
      index: null,
      sourceIssueId: 'issue-1',
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

  it('onDragEnd fires on ESC cancel during pressing', () => {
    const cb = makeCallbacks();
    const m = new DragController(cb as unknown as DragControllerCallbacks);
    installSourceElement();
    m.startPress(makeSource(), null, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cb.onDragEnd).toHaveBeenCalledTimes(1);
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
});
