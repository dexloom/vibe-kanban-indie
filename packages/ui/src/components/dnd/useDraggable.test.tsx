/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDraggable } from './useDraggable';
import { DragControllerContext } from './DragContext';
import type { DragController } from './DragController';
import { type DragSource } from './types';

afterEach(cleanup);

interface RenderResult {
  onPointerDown: ((e: React.PointerEvent<HTMLDivElement>) => void) | null;
}

function HookHarness({
  source,
  disabled,
  out,
}: {
  source: DragSource;
  disabled?: boolean;
  out: RenderResult;
}) {
  const { onPointerDown } = useDraggable(source, { disabled });
  out.onPointerDown = onPointerDown;
  return <div data-testid="probe" />;
}

function renderWithController(
  controller: DragController | null,
  props: { source: DragSource; disabled?: boolean },
): RenderResult {
  const out: RenderResult = { onPointerDown: null };
  render(
    <DragControllerContext.Provider value={controller}>
      <HookHarness source={props.source} disabled={props.disabled} out={out} />
    </DragControllerContext.Provider>,
  );
  return out;
}

function fakePointerEvent(
  button: number,
  target: Element | null = null,
  currentTarget: HTMLElement | null = null,
  pointerType = 'mouse',
): React.PointerEvent<HTMLDivElement> {
  const native = new PointerEvent('pointerdown', { button, pointerType });
  return {
    button,
    pointerType,
    target,
    currentTarget,
    nativeEvent: native,
    preventDefault: () => {},
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

describe('useDraggable', () => {
  it('returns null onPointerDown when no controller is mounted', () => {
    const out: RenderResult = { onPointerDown: () => undefined };
    render(
      <HookHarness
        source={{
          kind: 'issue-move',
          issueId: 'i1',
          projectId: 'p1',
          statusId: 's1',
        }}
        out={out}
      />,
    );
    expect(out.onPointerDown).toBeNull();
  });

  it('calls controller.startPress on a primary pointerdown passing (source, currentTarget, nativeEvent)', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const source: DragSource = {
      kind: 'issue-move',
      issueId: 'i1',
      projectId: 'p1',
      statusId: 's1',
    };
    const out = renderWithController(controller, { source });
    expect(out.onPointerDown).not.toBeNull();
    const currentTarget = document.createElement('div');
    out.onPointerDown!(fakePointerEvent(0, null, currentTarget));
    expect(startPress).toHaveBeenCalledWith(
      source,
      currentTarget,
      expect.any(PointerEvent),
    );
  });

  it('no-op when disabled is true', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
      disabled: true,
    });
    out.onPointerDown!(fakePointerEvent(0));
    expect(startPress).not.toHaveBeenCalled();
  });

  it('no-op when pointerdown target is inside a <button>', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    const button = document.createElement('button');
    document.body.appendChild(button);
    out.onPointerDown!(fakePointerEvent(0, button));
    expect(startPress).not.toHaveBeenCalled();
    button.remove();
  });

  it('P4-E2: no-op for interactive children (a, input, textarea, select, contenteditable, [tabindex])', () => {
    // P4-E2: the old guard (`closest('button')`) only excused <button> — a
    // link, input, or contenteditable element inside the drag source
    // would get `preventDefault` called on its pointerdown, which
    // suppresses focus on click. Broaden the exempt list to all
    // focusable / interactive descendants.
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    for (const tag of ['a', 'input', 'textarea', 'select']) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      out.onPointerDown!(fakePointerEvent(0, el));
      expect(startPress).not.toHaveBeenCalled();
      el.remove();
    }
    const contenteditable = document.createElement('div');
    contenteditable.setAttribute('contenteditable', 'true');
    document.body.appendChild(contenteditable);
    out.onPointerDown!(fakePointerEvent(0, contenteditable));
    expect(startPress).not.toHaveBeenCalled();
    contenteditable.remove();

    const tabindex = document.createElement('div');
    tabindex.setAttribute('tabindex', '0');
    document.body.appendChild(tabindex);
    out.onPointerDown!(fakePointerEvent(0, tabindex));
    expect(startPress).not.toHaveBeenCalled();
    tabindex.remove();
  });

  it('does NOT call preventDefault on a tabindex child (focus is preserved)', () => {
    // The user-facing symptom of the old guard: clicking a tabindex
    // element inside the drag source would have its focus blocked
    // because `e.preventDefault()` runs on the pointerdown. With the
    // broadened exempt list, the handler returns early without
    // touching preventDefault.
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    const preventDefault = vi.fn();
    const tabindex = document.createElement('div');
    tabindex.setAttribute('tabindex', '0');
    document.body.appendChild(tabindex);
    const fakeEv = {
      button: 0,
      pointerType: 'mouse',
      target: tabindex,
      currentTarget: document.createElement('div'),
      nativeEvent: new PointerEvent('pointerdown'),
      preventDefault,
    } as unknown as React.PointerEvent<HTMLDivElement>;
    out.onPointerDown!(fakeEv);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(startPress).not.toHaveBeenCalled();
    tabindex.remove();
  });

  it('calls preventDefault and startPress on a plain non-interactive child (drag still works)', () => {
    // Regression: the broadened guard must NOT swallow plain text /
    // div children — those still need to start a drag.
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    const preventDefault = vi.fn();
    const plainDiv = document.createElement('div');
    document.body.appendChild(plainDiv);
    const fakeEv = {
      button: 0,
      pointerType: 'mouse',
      target: plainDiv,
      currentTarget: document.createElement('div'),
      nativeEvent: new PointerEvent('pointerdown'),
      preventDefault,
    } as unknown as React.PointerEvent<HTMLDivElement>;
    out.onPointerDown!(fakeEv);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(startPress).toHaveBeenCalledTimes(1);
    plainDiv.remove();
  });

  it('no-op for non-primary mouse button (right click)', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    out.onPointerDown!(fakePointerEvent(2));
    expect(startPress).not.toHaveBeenCalled();
  });

  it('returns null onPointerDown when the context value is null (no controller mounted)', () => {
    const out: RenderResult = { onPointerDown: () => undefined };
    render(
      <DragControllerContext.Provider value={null}>
        <HookHarness
          source={{
            kind: 'issue-move',
            issueId: 'i1',
            projectId: 'p1',
            statusId: 's1',
          }}
          out={out}
        />
      </DragControllerContext.Provider>,
    );
    expect(out.onPointerDown).toBeNull();
  });

  it('P5-E2: pointerdown directly on a focusable drag root (tabindex="0") still starts the drag', () => {
    // Regression: the P4-E2 `closest('button, a, ..., [tabindex]')`
    // guard matched the drag source ROOT itself when it was focusable
    // (e.g. `KanbanCard` renders `tabIndex?` on the root). A pointer
    // landing directly on the source root would be incorrectly skipped
    // → no drag → clicking a card with tabindex='0' did nothing. The
    // P5-E2 fix walks from target up to currentTarget EXCLUSIVE; the
    // root is exempt, its interactive descendants still match.
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    const preventDefault = vi.fn();
    const root = document.createElement('div');
    root.setAttribute('tabindex', '0');
    document.body.appendChild(root);
    const fakeEv = {
      button: 0,
      pointerType: 'mouse',
      target: root,
      currentTarget: root,
      nativeEvent: new PointerEvent('pointerdown'),
      preventDefault,
    } as unknown as React.PointerEvent<HTMLDivElement>;
    out.onPointerDown!(fakeEv);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(startPress).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it('P5-E2: focusable CHILD of a focusable root (nested tabindex) still cancels drag', () => {
    // The exclusivity cut must not let focusable DESCENDANTS escape
    // just because the root is also focusable. Walk up to currentTarget
    // exclusive — anything matching the selector BEFORE we hit the
    // root still bails out.
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
    });
    const root = document.createElement('div');
    root.setAttribute('tabindex', '0');
    const child = document.createElement('div');
    child.setAttribute('tabindex', '0');
    root.appendChild(child);
    document.body.appendChild(root);
    const fakeEv = {
      button: 0,
      pointerType: 'mouse',
      target: child,
      currentTarget: root,
      nativeEvent: new PointerEvent('pointerdown'),
      preventDefault: () => {},
    } as unknown as React.PointerEvent<HTMLDivElement>;
    out.onPointerDown!(fakeEv);
    expect(startPress).not.toHaveBeenCalled();
    root.remove();
  });

  it('keeps the onPointerDown callback ref-stable across renders with fresh source literals (virtualized row scroll)', () => {
    // Round-3 finding #15: callers (KanbanCards row map) pass fresh
    // `{kind, issueId, projectId}` literals on every render. Before the
    // fix, `useCallback([..., source])` re-bound the callback each paint
    // — which forced every virtualized row to re-attach its pointerdown
    // listener. Now `source` is read through a ref inside the callback
    // and the callback identity is stable across source-only re-renders.
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const initial: DragSource = {
      kind: 'issue-move',
      issueId: 'i1',
      projectId: 'p1',
      statusId: 's1',
    };
    const out: RenderResult = { onPointerDown: null };
    const { rerender } = render(
      <DragControllerContext.Provider value={controller}>
        <HookHarness source={initial} out={out} />
      </DragControllerContext.Provider>,
    );
    const firstHandler = out.onPointerDown;

    rerender(
      <DragControllerContext.Provider value={controller}>
        <HookHarness
          source={{
            kind: 'issue-move',
            issueId: 'i1',
            projectId: 'p1',
            statusId: 's1',
          }}
          out={out}
        />
      </DragControllerContext.Provider>,
    );
    expect(out.onPointerDown).toBe(firstHandler);

    // The handler still dispatches the LATEST source through the ref.
    const currentTarget = document.createElement('div');
    out.onPointerDown!(fakePointerEvent(0, null, currentTarget));
    expect(startPress).toHaveBeenCalledWith(
      {
        kind: 'issue-move',
        issueId: 'i1',
        projectId: 'p1',
        statusId: 's1',
      },
      currentTarget,
      expect.any(PointerEvent),
    );
  });
});
