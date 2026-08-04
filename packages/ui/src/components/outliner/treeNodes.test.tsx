import { cleanup, render, screen } from '@testing-library/react';
import { DragDropContext } from '@hello-pangea/dnd';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeNodeRouter } from './treeNodes';
import {
  makeCardNodeId,
  makeStatusNodeId,
  type BucketNode,
  type CardNode,
  type LeafNode,
  type ProjectNode,
  type SidebarTreeNode,
  type StatusNode,
  type TasksSectionNode,
} from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

// hello-pangea Draggable/Droppable components require a DragDropContext
// ancestor (useRequiredContext inside the package). Every render in this
// file is wrapped in one.
function withDnd(node: React.ReactNode) {
  return <DragDropContext onDragEnd={() => {}}>{node}</DragDropContext>;
}

function renderNode(
  data: SidebarTreeNode,
  overrides: Record<string, unknown> = {},
) {
  const node = {
    data,
    isOpen: false,
    toggle: vi.fn(),
    activate: vi.fn(),
    tree: { indent: 12 },
    ...overrides,
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
  return render(withDnd(<TreeNodeRouter {...props} />));
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
      id: makeStatusNodeId('project-1', 'todo'),
      type: 'status',
      projectId: 'project-1',
      statusId: 'todo',
      name: 'Todo',
      color: '210 50% 50%',
      children: [],
    } satisfies StatusNode;
    const card = {
      id: makeCardNodeId('project-1', 'issue-1'),
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

describe('TreeNodeRouter cross-surface DnD wrapping', () => {
  it('CardNodeRow tags the row with data-tree-card for the custom drag manager', () => {
    const card = {
      id: makeCardNodeId('project-1', '00000000-0000-4000-8000-000000000001'),
      type: 'card',
      issue: {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Fix auth',
        priority: null,
        statusId: '00000000-0000-4000-8000-000000000010',
        projectId: 'project-1',
        parentIssueId: null,
      },
      children: [],
    } satisfies CardNode;
    const { container } = renderNode(card);
    // Card rows are tagged with data-tree-card so the custom manager can
    // locate + clone the source row for the drag ghost. No hello-pangea
    // Draggable wrapper is rendered anymore (PLAN §6.3).
    expect(
      container.querySelector(
        '[data-tree-card="00000000-0000-4000-8000-000000000001"]',
      ),
    ).toBeTruthy();
    expect(container.querySelector('[data-rfd-draggable-id]')).toBeNull();
  });

  it('StatusNodeRow renders a hello-pangea Droppable with id <projectId>:status:<statusId>', () => {
    const status = {
      id: makeStatusNodeId('project-1', '00000000-0000-4000-8000-000000000010'),
      type: 'status',
      projectId: 'project-1',
      statusId: '00000000-0000-4000-8000-000000000010',
      name: 'Todo',
      color: '210 50% 50%',
      children: [],
    } satisfies StatusNode;
    const { container } = renderNode(status);
    expect(
      container.querySelector(
        '[data-rfd-droppable-id="project-1:status:00000000-0000-4000-8000-000000000010"]',
      ),
    ).toBeTruthy();
  });

  it('ProjectTreeNode does NOT render a hello-pangea Draggable/Droppable', () => {
    const project = {
      id: 'project-1',
      type: 'project',
      name: 'Demo',
      color: '210 50% 50%',
      children: [],
    } satisfies ProjectNode;
    const { container } = renderNode(project);
    expect(container.querySelector('[data-rfd-draggable-id]')).toBeNull();
    expect(container.querySelector('[data-rfd-droppable-id]')).toBeNull();
  });

  it('BucketNode / LeafNode do NOT render a hello-pangea Draggable/Droppable', () => {
    const bucket = {
      id: 'project-1:bucket:attention',
      type: 'bucket',
      bucketId: 'attention',
      name: 'Needs attention',
      children: [],
    } satisfies BucketNode;
    const { container: c1, unmount: u1 } = renderNode(bucket);
    expect(c1.querySelector('[data-rfd-draggable-id]')).toBeNull();
    expect(c1.querySelector('[data-rfd-droppable-id]')).toBeNull();
    u1();

    const leaf = {
      id: 'workspace-leaf-1',
      type: 'leaf',
      workspace: {
        id: 'workspace-leaf-1',
        name: 'ws-leaf',
        createdAt: '2025-01-01T00:00:00Z',
      },
    } satisfies LeafNode;
    const { container: c2 } = renderNode(leaf);
    expect(c2.querySelector('[data-rfd-draggable-id]')).toBeNull();
    expect(c2.querySelector('[data-rfd-droppable-id]')).toBeNull();
  });
});
