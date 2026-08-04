import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardNodeRow } from './CardNodeRow';
import {
  TreeDragControllerContext,
  type TreeDragControllerValue,
} from './treeDrag/TreeDragControllerContext';
import type { TreeDragManager } from './treeDrag/TreeDragManager';
import type { CardNode } from './types';

afterEach(cleanup);

// CardNodeRow no longer wraps the row in a hello-pangea <Droppable>/<Draggable>;
// it delegates drag to the custom TreeDragManager via the controller
// context. Tests wrap the row in a controller provider so the hook can
// locate a manager.

function withController(
  node: React.ReactNode,
  manager: TreeDragManager | null = null,
) {
  const setDragState = vi.fn();
  const value: TreeDragControllerValue = { manager, setDragState };
  return (
    <TreeDragControllerContext.Provider value={value}>
      {node}
    </TreeDragControllerContext.Provider>
  );
}

function cardNode(
  overrides: Partial<CardNode['issue']> = {},
  children: CardNode[] = [],
  isOpen = false,
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
        <CardNodeRow node={cardNode().node} style={{ paddingLeft: 36 }} />,
      ),
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
        />,
      ),
    );

    const row = container.querySelector('[aria-current]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(row.className).toContain('font-semibold');
  });

  it('does not toggle or activate when a leaf card row is clicked', () => {
    // Navigation happens on react-arborist\'s OUTER row (handleActivate); the
    // inner row must not double-fire it.
    const { node, activate, toggle } = cardNode();
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />),
    );

    const row = container.querySelector('[data-tree-card]') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.click(row);

    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('shows an isolated caret toggle for cards with sub-issues', () => {
    const child = cardNode({ id: 'issue-2' }).node.data;
    const { node, activate, toggle } = cardNode({}, [child], true);
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />),
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
      withController(<CardNodeRow node={node} style={{}} />),
    );

    expect(container.querySelector('button')).toBeNull();
    const row = container.querySelector('[data-tree-card]') as HTMLElement;
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(row);
    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('tags the row with data-tree-card so the drag manager can clone it for the ghost', () => {
    const { container } = render(
      withController(<CardNodeRow node={cardNode().node} style={{}} />),
    );
    const row = container.querySelector(
      '[data-tree-card="issue-1"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
  });

  it('forwards mousedown to the manager via the controller', () => {
    const startPress = vi.fn();
    const manager = { startPress } as unknown as TreeDragManager;
    const { container } = render(
      withController(
        <CardNodeRow node={cardNode().node} style={{}} />,
        manager,
      ),
    );
    const row = container.querySelector(
      '[data-tree-card="issue-1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(row, { button: 0 });
    expect(startPress).toHaveBeenCalledWith(
      'issue-1',
      'project-1',
      expect.any(MouseEvent),
      expect.any(Function),
    );
  });

  it('does NOT start a drag when isMultiSelectActive is true', () => {
    const startPress = vi.fn();
    const manager = { startPress } as unknown as TreeDragManager;
    const { container } = render(
      withController(
        <CardNodeRow node={cardNode().node} style={{}} isMultiSelectActive />,
        manager,
      ),
    );
    const row = container.querySelector(
      '[data-tree-card="issue-1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(row, { button: 0 });
    expect(startPress).not.toHaveBeenCalled();
  });

  it('does NOT start a drag when mousedown originated on a caret <button>', () => {
    const startPress = vi.fn();
    const manager = { startPress } as unknown as TreeDragManager;
    const child = cardNode({ id: 'issue-2' }).node.data;
    const { node } = cardNode({}, [child], true);
    const { container } = render(
      withController(<CardNodeRow node={node} style={{}} />, manager),
    );
    const caret = container.querySelector('button') as HTMLButtonElement;
    expect(caret).toBeTruthy();
    fireEvent.mouseDown(caret, { button: 0 });
    expect(startPress).not.toHaveBeenCalled();
  });
});
