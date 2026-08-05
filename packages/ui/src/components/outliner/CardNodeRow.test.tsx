import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardNodeRow } from './CardNodeRow';
import { DragControllerContext } from '../dnd';
import type { DragController } from '../dnd';
import type { CardNode } from './types';

afterEach(cleanup);

function withController(
  node: React.ReactNode,
  controller: DragController | null = null
) {
  return (
    <DragControllerContext.Provider value={controller}>
      {node}
    </DragControllerContext.Provider>
  );
}

function cardNode(
  overrides: Partial<CardNode['issue']> = {},
  children: CardNode[] = [],
  isOpen = false
) {
  const activate = vi.fn();
  const toggle = vi.fn();
  const node = {
    data: {
      id: 'issue-1',
      type: 'card',
      issue: {
        id: 'issue-1',
        title: 'Fix auth',
        priority: null,
        statusId: 'todo',
        projectId: 'project-1',
        parentIssueId: null,
        ...overrides,
      },
      children,
    },
    isOpen,
    activate,
    toggle,
    tree: { indent: 12 },
  } as unknown as NodeApi<CardNode>;
  return { node, activate, toggle };
}

describe('CardNodeRow', () => {
  it('renders the issue title', () => {
    const { container } = render(
      withController(
        <CardNodeRow node={cardNode().node} style={{ paddingLeft: 36 }} />
      )
    );

    expect(container.textContent).toBe('Fix auth');
    expect(screen.getByText('Fix auth')).toBeTruthy();
  });

  it('marks the active issue as the current page with semibold text', () => {
    const { container } = render(
      withController(
        <CardNodeRow
          node={cardNode().node}
          style={{}}
          activeIssueId="issue-1"
        />
      )
    );

    const row = container.querySelector('[aria-current]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(row.className).toContain('font-semibold');
  });

  it('does not toggle or activate when a leaf card row is clicked', () => {
    const { node, activate, toggle } = cardNode();
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />)
    );

    const row = container.querySelector('.cursor-pointer') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.click(row);

    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('shows an isolated caret toggle for cards with sub-issues', () => {
    const child = cardNode({ id: 'issue-2' }).node.data;
    const { node, activate, toggle } = cardNode({}, [child], true);
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />)
    );

    const caret = container.querySelector('button') as HTMLButtonElement;
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.getAttribute('aria-label')).toBe('sidebar.collapse');
    fireEvent.click(caret);

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it('renders leaf cards without a caret or aria-expanded', () => {
    const { node, activate, toggle } = cardNode();
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />)
    );

    expect(container.querySelector('button')).toBeNull();
    const row = container.querySelector('.cursor-pointer') as HTMLElement;
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(row);
    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('forwards pointerdown to the controller via the drag hook', () => {
    const startPress = vi.fn();
    const controller = { startPress } as unknown as DragController;
    const { container } = render(
      withController(
        <CardNodeRow node={cardNode().node} style={{}} />,
        controller
      )
    );
    const row = container.querySelector('.cursor-pointer') as HTMLElement;
    fireEvent.pointerDown(row, { button: 0 });
    expect(startPress).toHaveBeenCalledWith(
      {
        kind: 'issue-move',
        issueId: 'issue-1',
        projectId: 'project-1',
        statusId: 'todo',
      },
      row,
      expect.any(PointerEvent)
    );
  });

  it('does NOT start a drag when isMultiSelectActive is true', () => {
    const startPress = vi.fn();
    const controller = { startPress } as unknown as DragController;
    const { container } = render(
      withController(
        <CardNodeRow node={cardNode().node} style={{}} isMultiSelectActive />,
        controller
      )
    );
    const row = container.querySelector('.cursor-pointer') as HTMLElement;
    fireEvent.pointerDown(row, { button: 0 });
    expect(startPress).not.toHaveBeenCalled();
  });

  it('does NOT start a drag when pointerdown originated on a caret <button>', () => {
    const startPress = vi.fn();
    const controller = { startPress } as unknown as DragController;
    const child = cardNode({ id: 'issue-2' }).node.data;
    const { node } = cardNode({}, [child], true);
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />, controller)
    );
    const caret = container.querySelector('button') as HTMLButtonElement;
    expect(caret).toBeTruthy();
    fireEvent.pointerDown(caret, { button: 0 });
    expect(startPress).not.toHaveBeenCalled();
  });

  it('sets inline style.touchAction === "none" on the row root (P3-B2)', () => {
    // Pointer Events without `touch-action: none` let the browser absorb
    // the gesture into scrolling on touch, so pointermove never reaches
    // the controller. The row root must carry the override (inline style
    // merged over arborist's positional style via TreeRow's
    // outerProps.style → outerStyle spread).
    const { container } = render(
      withController(<CardNodeRow node={cardNode().node} style={{}} />)
    );
    const row = container.querySelector('.cursor-pointer') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.touchAction).toBe('none');
  });
});
