import { cleanup, render, screen } from '@testing-library/react';
import type { NodeApi } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksSectionNode } from './TasksSectionNode';
import type { TasksSectionNode as TasksSectionNodeData } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'sidebar.tasksLoading' ? 'Loading tasks…' : key,
  }),
}));

afterEach(cleanup);

function node(isLoading: boolean): NodeApi<TasksSectionNodeData> {
  return {
    data: {
      id: 'project-1:tasks',
      type: 'section',
      kind: 'tasks',
      projectId: 'project-1',
      label: 'Tasks',
      isLoading,
      children: [
        {
          id: 'project-1:status:todo',
          type: 'status',
          projectId: 'project-1',
          statusId: 'todo',
          name: 'Todo',
          color: '210 50% 50%',
          children: [],
        },
      ],
    },
    isOpen: false,
    toggle: vi.fn(),
  } as unknown as NodeApi<TasksSectionNodeData>;
}

describe('TasksSectionNode', () => {
  it('shows a spinner instead of the status count while loading', () => {
    render(<TasksSectionNode node={node(true)} style={{}} />);

    expect(screen.getByLabelText('Loading tasks…')).toBeTruthy();
    expect(screen.queryByText('1')).toBeNull();
  });

  it('shows the visible status count when loading is complete', () => {
    render(<TasksSectionNode node={node(false)} style={{}} />);

    expect(screen.queryByLabelText('Loading tasks…')).toBeNull();
    expect(screen.getByText('1')).toBeTruthy();
  });
});
