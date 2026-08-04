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
  onMouseDown: ((e: React.MouseEvent<HTMLDivElement>) => void) | null;
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
  const { onMouseDown } = useDraggable(source, { disabled });
  out.onMouseDown = onMouseDown;
  return <div data-testid="probe" />;
}

function renderWithController(
  controller: DragController | null,
  props: { source: DragSource; disabled?: boolean },
): RenderResult {
  const out: RenderResult = { onMouseDown: null };
  render(
    <DragControllerContext.Provider value={controller}>
      <HookHarness source={props.source} disabled={props.disabled} out={out} />
    </DragControllerContext.Provider>,
  );
  return out;
}

function fakeMouseEvent(
  button: number,
  target: Element | null = null,
  currentTarget: HTMLElement | null = null,
): React.MouseEvent<HTMLDivElement> {
  const native = new MouseEvent('mousedown', { button });
  return {
    button,
    target,
    currentTarget,
    nativeEvent: native,
    preventDefault: () => {},
  } as unknown as React.MouseEvent<HTMLDivElement>;
}

describe('useDraggable', () => {
  it('returns null onMouseDown when no controller is mounted', () => {
    const out: RenderResult = { onMouseDown: () => undefined };
    render(
      <HookHarness
        source={{ kind: 'issue-move', issueId: 'i1', projectId: 'p1' }}
        out={out}
      />,
    );
    expect(out.onMouseDown).toBeNull();
  });

  it('calls controller.startPress on a primary mousedown passing (source, currentTarget, nativeEvent)', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const source: DragSource = {
      kind: 'issue-move',
      issueId: 'i1',
      projectId: 'p1',
    };
    const out = renderWithController(controller, { source });
    expect(out.onMouseDown).not.toBeNull();
    const currentTarget = document.createElement('div');
    out.onMouseDown!(fakeMouseEvent(0, null, currentTarget));
    expect(startPress).toHaveBeenCalledWith(
      source,
      currentTarget,
      expect.any(MouseEvent),
    );
  });

  it('no-op when disabled is true', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: { kind: 'issue-move', issueId: 'i1', projectId: 'p1' },
      disabled: true,
    });
    out.onMouseDown!(fakeMouseEvent(0));
    expect(startPress).not.toHaveBeenCalled();
  });

  it('no-op when mousedown target is inside a <button>', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: { kind: 'issue-move', issueId: 'i1', projectId: 'p1' },
    });
    const button = document.createElement('button');
    document.body.appendChild(button);
    out.onMouseDown!(fakeMouseEvent(0, button));
    expect(startPress).not.toHaveBeenCalled();
    button.remove();
  });

  it('no-op for non-primary mouse button (right click)', () => {
    const startPress = vi.fn();
    const controller = {
      startPress,
    } as unknown as DragController;
    const out = renderWithController(controller, {
      source: { kind: 'issue-move', issueId: 'i1', projectId: 'p1' },
    });
    out.onMouseDown!(fakeMouseEvent(2));
    expect(startPress).not.toHaveBeenCalled();
  });

  it('returns null onMouseDown when the context value is null (no controller mounted)', () => {
    const out: RenderResult = { onMouseDown: () => undefined };
    render(
      <DragControllerContext.Provider value={null}>
        <HookHarness
          source={{ kind: 'issue-move', issueId: 'i1', projectId: 'p1' }}
          out={out}
        />
      </DragControllerContext.Provider>,
    );
    expect(out.onMouseDown).toBeNull();
  });

  it('keeps the onMouseDown callback ref-stable across renders with fresh source literals (virtualized row scroll)', () => {
    // Round-3 finding #15: callers (KanbanCards row map) pass fresh
    // `{kind, issueId, projectId}` literals on every render. Before the
    // fix, `useCallback([..., source])` re-bound the callback each paint
    // — which forced every virtualized row to re-attach its mousedown
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
    };
    const out: RenderResult = { onMouseDown: null };
    const { rerender } = render(
      <DragControllerContext.Provider value={controller}>
        <HookHarness source={initial} out={out} />
      </DragControllerContext.Provider>,
    );
    const firstHandler = out.onMouseDown;

    rerender(
      <DragControllerContext.Provider value={controller}>
        <HookHarness
          source={{ kind: 'issue-move', issueId: 'i1', projectId: 'p1' }}
          out={out}
        />
      </DragControllerContext.Provider>,
    );
    expect(out.onMouseDown).toBe(firstHandler);

    // The handler still dispatches the LATEST source through the ref.
    const currentTarget = document.createElement('div');
    out.onMouseDown!(fakeMouseEvent(0, null, currentTarget));
    expect(startPress).toHaveBeenCalledWith(
      { kind: 'issue-move', issueId: 'i1', projectId: 'p1' },
      currentTarget,
      expect.any(MouseEvent),
    );
  });
});
