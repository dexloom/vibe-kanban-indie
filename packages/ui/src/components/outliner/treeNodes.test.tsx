import { cleanup, render, screen } from '@testing-library/react';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeNodeRouter } from './treeNodes';
import type {
  CardNode,
  SidebarTreeNode,
  StatusNode,
  TasksSectionNode,
} from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function renderNode(data: SidebarTreeNode) {
  const node = {
    data,
    isOpen: false,
    toggle: vi.fn(),
    activate: vi.fn(),
    tree: { indent: 12 },
  } as unknown as NodeApi<SidebarTreeNode>;
  const props = {
    node,
    style: {},
    tree: node.tree,
    dragHandle: undefined,
    preview: null,
    onSelectProject: vi.fn(),
    activeProjectId: null,
    activeWorkspaceId: null,
    activeIssueId: null,
    onSelectIssue: vi.fn(),
  } as unknown as NodeRendererProps<SidebarTreeNode> & {
    onSelectProject: (id: string) => void;
    activeProjectId: string | null;
    activeWorkspaceId: string | null;
    activeIssueId: string | null;
    onSelectIssue: (projectId: string, issueId: string) => void;
  };
  return render(<TreeNodeRouter {...props} />);
}

describe('TreeNodeRouter task routing', () => {
  it('routes a tasks section by section kind', () => {
    renderNode({
      id: 'project-1:tasks',
      type: 'section',
      kind: 'tasks',
      projectId: 'project-1',
      label: 'Tasks',
      children: [],
    } satisfies TasksSectionNode);

    expect(screen.getByText('Tasks')).toBeTruthy();
    expect(screen.getByText('sidebar.tasksEmpty')).toBeTruthy();
  });

  it('routes status and card node types', () => {
    const status = {
      id: 'project-1:status:todo',
      type: 'status',
      projectId: 'project-1',
      statusId: 'todo',
      name: 'Todo',
      color: '210 50% 50%',
      children: [],
    } satisfies StatusNode;
    const card = {
      id: 'issue-1',
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
    } satisfies CardNode;

    const statusRender = renderNode(status);
    expect(screen.getByText('Todo')).toBeTruthy();
    statusRender.unmount();
    renderNode(card);
    expect(screen.getByText('Fix auth')).toBeTruthy();
  });
});
