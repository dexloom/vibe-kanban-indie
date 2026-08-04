/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDraggable } from './useDraggable';
import { DragControllerContext, type DragControllerValue } from './DragContext';
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
  const value: DragControllerValue = { controller };
  render(
    <DragControllerContext.Provider value={value}>
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

  it('does not throw when controller is present but null', () => {
    const out: RenderResult = { onMouseDown: null };
    render(
      <DragControllerContext.Provider value={{ controller: null }}>
        <HookHarness
          source={{ kind: 'issue-move', issueId: 'i1', projectId: 'p1' }}
          out={out}
        />
      </DragControllerContext.Provider>,
    );
    expect(out.onMouseDown).not.toBeNull();
    expect(() => out.onMouseDown!(fakeMouseEvent(0))).not.toThrow();
  });
});
