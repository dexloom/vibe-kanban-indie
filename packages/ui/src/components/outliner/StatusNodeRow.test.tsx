import { cleanup, render, screen } from '@testing-library/react';
import { DragDropContext } from '@hello-pangea/dnd';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusNodeRow } from './StatusNodeRow';
import { makeStatusNodeId, type StatusNode } from './types';

afterEach(cleanup);

function withDnd(node: React.ReactNode) {
  return <DragDropContext onDragEnd={() => {}}>{node}</DragDropContext>;
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
});
