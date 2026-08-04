/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useTreeCardDrag } from './useTreeCardDrag';
import {
  TreeDragControllerContext,
  type TreeDragControllerValue,
} from './TreeDragControllerContext';
import type { TreeDragManager } from './TreeDragManager';

afterEach(cleanup);

interface RenderResult {
  onMouseDown: ((e: React.MouseEvent<HTMLDivElement>) => void) | null;
}

function HookHarness({
  issueId,
  projectId,
  isMultiSelectActive,
  manager,
  out,
}: {
  issueId: string;
  projectId: string;
  isMultiSelectActive: boolean;
  manager: TreeDragManager | null;
  out: RenderResult;
}) {
  const { onMouseDown } = useTreeCardDrag(
    issueId,
    projectId,
    isMultiSelectActive,
  );
  out.onMouseDown = onMouseDown;
  return <div data-testid="probe" />;
}

function renderWithController(
  manager: TreeDragManager | null,
  props: {
    issueId: string;
    projectId: string;
    isMultiSelectActive: boolean;
  },
): RenderResult {
  const out: RenderResult = { onMouseDown: null };
  const setDragState = vi.fn();
  const value: TreeDragControllerValue = { manager, setDragState };
  render(
    <TreeDragControllerContext.Provider value={value}>
      <HookHarness {...props} manager={manager} out={out} />
    </TreeDragControllerContext.Provider>,
  );
  return out;
}

function fakeMouseEvent(
  button: number,
  target: Element | null = null,
): React.MouseEvent<HTMLDivElement> {
  // Real React.MouseEvent has a `nativeEvent` field that\'s a real DOM
  // MouseEvent. We build the nativeEvent first so the hook can pass it
  // through to manager.startPress.
  const native = new MouseEvent('mousedown', { button });
  return {
    button,
    target,
    nativeEvent: native,
  } as unknown as React.MouseEvent<HTMLDivElement>;
}

describe('useTreeCardDrag', () => {
  it('returns null onMouseDown when no controller is mounted', () => {
    const out: RenderResult = { onMouseDown: () => undefined };
    render(
      <HookHarness
        issueId="i1"
        projectId="p1"
        isMultiSelectActive={false}
        manager={null}
        out={out}
      />,
    );
    expect(out.onMouseDown).toBeNull();
  });

  it('calls manager.startPress on a primary mousedown', () => {
    const startPress = vi.fn();
    const manager = {
      startPress,
    } as unknown as TreeDragManager;
    const out = renderWithController(manager, {
      issueId: 'i1',
      projectId: 'p1',
      isMultiSelectActive: false,
    });
    expect(out.onMouseDown).not.toBeNull();
    out.onMouseDown!(fakeMouseEvent(0));
    expect(startPress).toHaveBeenCalledWith(
      'i1',
      'p1',
      expect.any(MouseEvent),
      expect.any(Function),
    );
  });

  it('no-op when isMultiSelectActive is true', () => {
    const startPress = vi.fn();
    const manager = {
      startPress,
    } as unknown as TreeDragManager;
    const out = renderWithController(manager, {
      issueId: 'i1',
      projectId: 'p1',
      isMultiSelectActive: true,
    });
    out.onMouseDown!(fakeMouseEvent(0));
    expect(startPress).not.toHaveBeenCalled();
  });

  it('no-op when mousedown originated on a <button> (caret click)', () => {
    const startPress = vi.fn();
    const manager = {
      startPress,
    } as unknown as TreeDragManager;
    const out = renderWithController(manager, {
      issueId: 'i1',
      projectId: 'p1',
      isMultiSelectActive: false,
    });
    const button = document.createElement('button');
    document.body.appendChild(button);
    out.onMouseDown!(fakeMouseEvent(0, button));
    expect(startPress).not.toHaveBeenCalled();
    button.remove();
  });

  it('no-op for non-primary mouse button (right click)', () => {
    const startPress = vi.fn();
    const manager = {
      startPress,
    } as unknown as TreeDragManager;
    const out = renderWithController(manager, {
      issueId: 'i1',
      projectId: 'p1',
      isMultiSelectActive: false,
    });
    out.onMouseDown!(fakeMouseEvent(2));
    expect(startPress).not.toHaveBeenCalled();
  });

  it('does not throw when controller is present but manager is null', () => {
    const out: RenderResult = { onMouseDown: null };
    const setDragState = vi.fn();
    render(
      <TreeDragControllerContext.Provider
        value={{ manager: null, setDragState }}
      >
        <HookHarness
          issueId="i1"
          projectId="p1"
          isMultiSelectActive={false}
          manager={null}
          out={out}
        />
      </TreeDragControllerContext.Provider>,
    );
    expect(out.onMouseDown).not.toBeNull();
    // No throw on call.
    expect(() => out.onMouseDown!(fakeMouseEvent(0))).not.toThrow();
  });
});
