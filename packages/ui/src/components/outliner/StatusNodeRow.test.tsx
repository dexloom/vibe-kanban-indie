import { cleanup, render, screen } from '@testing-library/react';
import { DragDropContext } from '@hello-pangea/dnd';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusNodeRow } from './StatusNodeRow';
import { DragActiveProvider } from './dragState';
import { makeStatusNodeId, type StatusNode } from './types';

afterEach(cleanup);

function withDnd(node: React.ReactNode) {
  return <DragDropContext onDragEnd={() => {}}>{node}</DragDropContext>;
}

function withDragActive(node: React.ReactNode, isDragActive: boolean) {
  return (
    <DragActiveProvider value={isDragActive}>
      {withDnd(node)}
    </DragActiveProvider>
  );
}

function statusNode(): NodeApi<StatusNode> {
  return {
    data: {
      id: makeStatusNodeId('project-1', 'todo'),
      type: 'status',
      projectId: 'project-1',
      statusId: 'todo',
      name: 'Todo',
      color: '210 50% 50%',
      children: [
        {
          id: 'project-1:card:issue-1',
          type: 'card',
          issue: {
            id: 'issue-1',
            title: 'Fix auth',
            priority: null,
            statusId: 'todo',
            projectId: 'project-1',
            parentIssueId: null,
          },
          children: [],
        },
      ],
    },
    isOpen: false,
    toggle: vi.fn(),
    isLeaf: false,
    level: 3,
    tree: { indent: 12 },
  } as unknown as NodeApi<StatusNode>;
}

describe('StatusNodeRow', () => {
  it('shows the status color dot, name, and child count', () => {
    const { container } = render(
      withDnd(<StatusNodeRow node={statusNode()} style={{}} />)
    );

    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    const dot = container.querySelector('.rounded-full');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.backgroundColor).toBe(
      'rgb(64, 128, 191)'
    );
  });

  it('wraps the row in a hello-pangea Droppable with the tree status id', () => {
    const { container } = render(
      withDnd(<StatusNodeRow node={statusNode()} style={{}} />)
    );
    const expectedId = makeStatusNodeId('project-1', 'todo');
    const droppable = container.querySelector(
      `[data-rfd-droppable-id="${expectedId}"]`
    );
    expect(droppable).toBeTruthy();
  });

  it('outlines the status row as a drop target while a drag is active', () => {
    const { container } = render(
      withDragActive(<StatusNodeRow node={statusNode()} style={{}} />, true)
    );
    const row = container.querySelector('.ring-1');
    expect(row).toBeTruthy();
  });

  it('renders no drop-target outline when no drag is active', () => {
    const { container } = render(
      withDragActive(<StatusNodeRow node={statusNode()} style={{}} />, false)
    );
    expect(container.querySelector('.ring-1')).toBeNull();
    expect(container.querySelector('.ring-2')).toBeNull();
  });
});
