import { cleanup, render, screen } from '@testing-library/react';
import { DragDropContext } from '@hello-pangea/dnd';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusNodeRow } from './StatusNodeRow';
import { DragActiveProvider, DragCandidateProvider } from './dragState';
import { makeStatusNodeId, type StatusNode } from './types';

afterEach(cleanup);

function withDnd(node: React.ReactNode) {
  return <DragDropContext onDragEnd={() => {}}>{node}</DragDropContext>;
}

function withDragState(
  node: React.ReactNode,
  isDragActive: boolean,
  candidateId: string | null = null,
) {
  return (
    <DragActiveProvider value={isDragActive}>
      <DragCandidateProvider value={candidateId}>
        {withDnd(node)}
      </DragCandidateProvider>
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
      withDnd(<StatusNodeRow node={statusNode()} style={{}} />),
    );

    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    const dot = container.querySelector('.rounded-full');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.backgroundColor).toBe(
      'rgb(64, 128, 191)',
    );
  });

  it('wraps the row in a hello-pangea Droppable with the tree status id', () => {
    const { container } = render(
      withDnd(<StatusNodeRow node={statusNode()} style={{}} />),
    );
    const expectedId = makeStatusNodeId('project-1', 'todo');
    const droppable = container.querySelector(
      `[data-rfd-droppable-id="${expectedId}"]`,
    );
    expect(droppable).toBeTruthy();
  });

  it('tags the droppable wrapper with data-drop-target-id for the custom manager', () => {
    const { container } = render(
      withDnd(<StatusNodeRow node={statusNode()} style={{}} />),
    );
    const expectedId = makeStatusNodeId('project-1', 'todo');
    const target = container.querySelector(
      `[data-drop-target-id="${expectedId}"]`,
    );
    expect(target).toBeTruthy();
    expect(target?.getAttribute('data-drop-target-project')).toBe('project-1');
  });

  it('outlines the status row as a drop target while a hello-pangea drag is active', () => {
    const { container } = render(
      withDragState(<StatusNodeRow node={statusNode()} style={{}} />, true),
    );
    const row = container.querySelector('.ring-1');
    expect(row).toBeTruthy();
  });

  it('renders the solid brand ring when the custom manager picks this row as candidate', () => {
    const expectedId = makeStatusNodeId('project-1', 'todo');
    const { container } = render(
      withDragState(
        <StatusNodeRow node={statusNode()} style={{}} />,
        true,
        expectedId,
      ),
    );
    const row = container.querySelector('.ring-2');
    expect(row).toBeTruthy();
  });

  it('shows the subtle ring-1 when the custom manager picked a different row (this row is a possible target, not the active candidate)', () => {
    const { container } = render(
      withDragState(
        <StatusNodeRow node={statusNode()} style={{}} />,
        true,
        'project-1:status:done',
      ),
    );
    expect(container.querySelector('.ring-1')).toBeTruthy();
    expect(container.querySelector('.ring-2')).toBeNull();
  });

  it('renders no drop-target outline when no drag is active', () => {
    const { container } = render(
      withDragState(<StatusNodeRow node={statusNode()} style={{}} />, false),
    );
    expect(container.querySelector('.ring-1')).toBeNull();
    expect(container.querySelector('.ring-2')).toBeNull();
  });
});
