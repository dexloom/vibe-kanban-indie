import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DragDropContext } from '@hello-pangea/dnd';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardNodeRow } from './CardNodeRow';
import type { CardNode } from './types';

afterEach(cleanup);

// hello-pangea requires an ancestor <DragDropContext> for the
// cross-surface Droppable/Draggable wrappers around a card row.
function withDnd(node: React.ReactNode) {
  return <DragDropContext onDragEnd={() => {}}>{node}</DragDropContext>;
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
      withDnd(
        <CardNodeRow node={cardNode().node} style={{ paddingLeft: 36 }} />
      )
    );

    expect(container.textContent).toBe('Fix auth');
    expect(screen.getByText('Fix auth')).toBeTruthy();
  });

  it('marks the active issue as the current page with semibold text', () => {
    const { container } = render(
      withDnd(
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
    // Navigation happens on react-arborist's OUTER row (handleActivate); the
    // inner row must not double-fire it.
    const { node, activate, toggle } = cardNode();
    const { container } = render(
      withDnd(<CardNodeRow node={node} style={{}} />)
    );

    const row = container.querySelector(
      '[role="treeitem"], [data-rfd-draggable-id]'
    ) as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.click(row);

    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('shows an isolated caret toggle for cards with sub-issues', () => {
    const child = cardNode({ id: 'issue-2' }).node.data;
    const { node, activate, toggle } = cardNode({}, [child], true);
    const { container } = render(
      withDnd(<CardNodeRow node={node} style={{}} />)
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
      withDnd(<CardNodeRow node={node} style={{}} />)
    );

    expect(container.querySelector('button')).toBeNull();
    const row = container.querySelector(
      '[role="treeitem"], [data-rfd-draggable-id]'
    ) as HTMLElement;
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(row);
    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('renders a hello-pangea Draggable with draggableId="issue:<issueId>"', () => {
    const { container } = render(
      withDnd(<CardNodeRow node={cardNode().node} style={{}} />)
    );
    // hello-pangea sets data-rfd-draggable-id on the draggable element so
    // the mouse-based drag layer can find it.
    const draggable = container.querySelector(
      '[data-rfd-draggable-id="issue:issue-1"]'
    );
    expect(draggable).toBeTruthy();
  });

  it('renders a per-card Droppable with droppableId equal to the issue id', () => {
    const { container } = render(
      withDnd(<CardNodeRow node={cardNode().node} style={{}} />)
    );
    // hello-pangea tags the droppable's outer div with data-rfd-droppable-id.
    const droppable = container.querySelector(
      '[data-rfd-droppable-id="issue-1"]'
    );
    expect(droppable).toBeTruthy();
  });

  it('still renders the Draggable wrapper when isMultiSelectActive is true', () => {
    // hello-pangea gates drag start at runtime when isDragDisabled is true;
    // there is no exposed ARIA / style signal we can sniff across versions.
    // The contract we assert here is plumbing — the prop reaches the
    // <Draggable> wrapper without the row crashing or losing its markup.
    const { container } = render(
      withDnd(
        <CardNodeRow node={cardNode().node} style={{}} isMultiSelectActive />
      )
    );
    expect(
      container.querySelector('[data-rfd-draggable-id="issue:issue-1"]')
    ).toBeTruthy();
    expect(container.textContent).toContain('Fix auth');
  });
});
