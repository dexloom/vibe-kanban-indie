import { cleanup, render, screen } from '@testing-library/react';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusNodeRow } from './StatusNodeRow';
import { DragActiveProvider, DragCandidateProvider } from './dragState';
import { makeStatusNodeId, type StatusNode } from './types';

afterEach(cleanup);

function withDragState(
  node: React.ReactNode,
  isDragActive: boolean,
  candidateId: string | null = null,
) {
  return (
    <DragActiveProvider value={isDragActive}>
      <DragCandidateProvider value={candidateId}>{node}</DragCandidateProvider>
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
      <StatusNodeRow node={statusNode()} style={{}} />,
    );

    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    const dot = container.querySelector('.rounded-full');
    expect(dot).toBeTruthy();
    expect((dot as HTMLElement).style.backgroundColor).toBe(
      'rgb(64, 128, 191)',
    );
  });

  it('tags the wrapper with data-drop-target-id + project + accept-kinds for the drag controller', () => {
    const { container } = render(
      <StatusNodeRow node={statusNode()} style={{}} />,
    );
    const expectedId = makeStatusNodeId('project-1', 'todo');
    const target = container.querySelector(
      `[data-drop-target-id="${expectedId}"]`,
    );
    expect(target).toBeTruthy();
    expect(target?.getAttribute('data-drop-target-project')).toBe('project-1');
    expect(target?.getAttribute('data-drop-target-accept-kinds')).toBe(
      'issue-move',
    );
  });

  it('does NOT render a hello-pangea Droppable wrapper', () => {
    const { container } = render(
      <StatusNodeRow node={statusNode()} style={{}} />,
    );
    expect(container.querySelector('[data-rfd-droppable-id]')).toBeNull();
  });

  it('fills the status row with a subtle tertiary background while a drag is active', () => {
    const { container } = render(
      withDragState(<StatusNodeRow node={statusNode()} style={{}} />, true),
    );
    const row = container.querySelector('.bg-tertiary\\/40');
    expect(row).toBeTruthy();
    expect(row?.classList.contains('rounded-sm')).toBe(true);
    expect(row?.classList.contains('bg-brand\\/20')).toBe(false);
  });

  it('fills the status row with a stronger brand background when this row is the candidate', () => {
    const expectedId = makeStatusNodeId('project-1', 'todo');
    const { container } = render(
      withDragState(
        <StatusNodeRow node={statusNode()} style={{}} />,
        true,
        expectedId,
      ),
    );
    const row = container.querySelector('.bg-brand\\/20');
    expect(row).toBeTruthy();
    expect(row?.classList.contains('rounded-sm')).toBe(true);
    expect(row?.classList.contains('bg-tertiary\\/40')).toBe(false);
  });

  it('shows the subtle tertiary fill when another row is the candidate', () => {
    const { container } = render(
      withDragState(
        <StatusNodeRow node={statusNode()} style={{}} />,
        true,
        'project-1:status:done',
      ),
    );
    expect(container.querySelector('.bg-tertiary\\/40')).toBeTruthy();
    expect(container.querySelector('.bg-brand\\/20')).toBeNull();
  });

  it('renders no drop-target fill when no drag is active', () => {
    const { container } = render(
      withDragState(<StatusNodeRow node={statusNode()} style={{}} />, false),
    );
    expect(container.querySelector('.bg-tertiary\\/40')).toBeNull();
    expect(container.querySelector('.bg-brand\\/20')).toBeNull();
  });
});
