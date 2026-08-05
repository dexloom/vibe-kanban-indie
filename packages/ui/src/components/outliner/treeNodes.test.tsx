import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeNodeRouter } from './treeNodes';
import {
  DragActiveContext,
  DragCandidateContext,
  DragSourceProjectContext,
} from './dragState';
import { DragControllerContext } from '../dnd';
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

function renderNode(
  data: SidebarTreeNode,
  overrides: Record<string, unknown> = {}
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
  it('CardNodeRow tags the row with the cursor-pointer shell (custom drag controller reads it via the captured element)', () => {
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
    // No hello-pangea Draggable wrapper; the row is a plain cursor-pointer shell.
    expect(container.querySelector('[data-rfd-draggable-id]')).toBeNull();
    expect(container.querySelector('.cursor-pointer')).toBeTruthy();
  });

  it('StatusNodeRow tags a wrapper with data-drop-target-id for the shared drag controller', () => {
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
        '[data-drop-target-id="project-1:status:00000000-0000-4000-8000-000000000010"]'
      )
    ).toBeTruthy();
    // No hello-pangea Droppable wrapper anymore.
    expect(container.querySelector('[data-rfd-droppable-id]')).toBeNull();
  });

  it('ProjectTreeNode does NOT render a hello-pangea Draggable/Droppable', () => {
    const project = {
      id: 'project-1',
      type: 'project',
      name: 'Project One',
      color: '210 50% 50%',
      parentId: null,
      sortOrder: 0,
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

// ---------------------------------------------------------------------------
// project-reorder (ADR-012 amendment)
// ---------------------------------------------------------------------------
//
// Renders the project node behind the same provider stack the live
// `DragProvider` exposes (`DragControllerContext` + drag-state contexts).
// The controller is left null here — `useDraggable` degrades to
// `{ onPointerDown: null }` (no press handler) but the drop-target data
// attributes still render, which is what these assertions exercise.

interface ProjectDnDContextOverrides {
  controller?: unknown;
  isDragActive?: boolean;
  candidateId?: string | null;
  sourceProjectId?: string | null;
}

function renderProjectWithDndContext(
  projectId: string,
  overrides: ProjectDnDContextOverrides = {}
) {
  const {
    controller = null,
    isDragActive = false,
    candidateId = null,
    sourceProjectId = null,
  } = overrides;
  const project: ProjectNode = {
    id: projectId,
    type: 'project',
    name: 'Demo',
    color: '210 50% 50%',
    parentId: null,
    sortOrder: 0,
    children: [],
  };
  const node = {
    data: project,
    isOpen: false,
    toggle: vi.fn(),
    activate: vi.fn(),
    tree: { indent: 12 },
  } as unknown as NodeApi<ProjectNode>;
  const props = {
    node,
    style: {},
    tree: node.tree,
    dragHandle: undefined,
    preview: null,
    onSelectProject: vi.fn(),
    onCreateChildBoard: vi.fn(),
    activeProjectId: null,
    activeWorkspaceId: null,
    activeIssueId: null,
    onSelectIssue: vi.fn(),
  } as unknown as NodeRendererProps<SidebarTreeNode> & {
    onSelectProject: (id: string) => void;
    onCreateChildBoard: (parentId: string) => void;
    activeProjectId: string | null;
    activeWorkspaceId: string | null;
    activeIssueId: string | null;
    onSelectIssue: (projectId: string, issueId: string) => void;
  };
  const stack: ReactNode = (
    <DragControllerContext.Provider value={controller as never}>
      <DragActiveContext.Provider value={isDragActive}>
        <DragSourceProjectContext.Provider value={sourceProjectId}>
          <DragCandidateContext.Provider value={candidateId}>
            <TreeNodeRouter {...props} />
          </DragCandidateContext.Provider>
        </DragSourceProjectContext.Provider>
      </DragActiveContext.Provider>
    </DragControllerContext.Provider>
  );
  return render(stack);
}

describe('TreeNodeRouter project-reorder wrapping', () => {
  it('ProjectTreeNode tags the row with data-drop-target-accept-kinds="project-reorder" and data-drop-target-id=project.id', () => {
    const { container } = renderProjectWithDndContext('project-1');
    const row = container.querySelector('[data-drop-target-id="project-1"]');
    expect(row).toBeTruthy();
    expect(row!.getAttribute('data-drop-target-project')).toBe('project-1');
    expect(row!.getAttribute('data-drop-target-accept-kinds')).toBe(
      'project-reorder'
    );
  });

  it('ProjectTreeNode (unassigned) does NOT tag the row with drop-target attributes (drag disabled)', () => {
    const { container } = renderProjectWithDndContext('unassigned');
    // Unassigned pseudo-project is inert: the controller disables its
    // drag handle and outerProps spread no `dropTargetAttrs`. Only the
    // OWN-id-equality fallback would land an attribute, so assert none.
    expect(
      container.querySelector('[data-drop-target-id="unassigned"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-drop-target-accept-kinds]')
    ).toBeNull();
  });

  it('ProjectTreeNode dims the source row (opacity-50) when DragSourceProjectContext matches', () => {
    const { container } = renderProjectWithDndContext('project-dragged', {
      sourceProjectId: 'project-dragged',
    });
    const row = container.querySelector('.cursor-pointer');
    expect(row).toBeTruthy();
    expect(row!.className).toContain('opacity-50');
  });

  it('ProjectTreeNode does NOT dim a non-source row even when another project is being dragged', () => {
    const { container } = renderProjectWithDndContext('project-other', {
      sourceProjectId: 'project-dragged',
    });
    const row = container.querySelector('.cursor-pointer');
    expect(row).toBeTruthy();
    expect(row!.className).not.toContain('opacity-50');
  });

  it('ProjectTreeNode row root carries style.touchAction === "none" (P3-B2)', () => {
    // Pointer Events on touch need touch-action: none on the source
    // element, otherwise the browser absorbs the gesture into scroll
    // and pointermove never reaches the controller. The project row
    // passes it via outerProps.style; TreeRow merges that over
    // arborist's positional style.
    const { container } = renderProjectWithDndContext('project-1');
    const row = container.querySelector(
      '[data-drop-target-id="project-1"]'
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.touchAction).toBe('none');
  });
});

// ============================================================================
// ADR-015: row-click semantics + child-board "+" button
// ============================================================================
//
// 1. Row click on a project row no longer toggles expand/collapse — it
//    navigates via onActivate (already wired by TreeNodeRouter). The caret
//    still toggles.
// 2. ArrowSquareOutIcon is removed from every project row.
// 3. A "+" button is rendered on every non-Unassigned project row; clicking
//    it invokes `onCreateChildBoard(project.id)` and does NOT navigate or
//    toggle.
// 4. The Unassigned row has neither "+" nor ArrowSquareOutIcon.

describe('TreeNodeRouter ADR-015 row interactions', () => {
  it('renders a "+" button on every non-Unassigned project row', () => {
    const { container } = renderProjectWithDndContext('project-1');
    const addBtn = container.querySelector(
      'button[aria-label="sidebar.createChildBoard"]'
    );
    expect(addBtn).toBeTruthy();
  });

  it('does NOT render ArrowSquareOutIcon on project rows (ADR-015)', () => {
    const { container } = renderProjectWithDndContext('project-1');
    // phosphor icon renders an <svg> with class containing the icon name or
    // a generic class; confirm no "openProjectKanban" aria-label exists.
    expect(
      container.querySelector('button[aria-label="sidebar.openProjectKanban"]')
    ).toBeNull();
  });

  it('"+" click on a project row fires onCreateChildBoard(project.id) and does NOT toggle', () => {
    const onCreateChildBoard = vi.fn();
    const project: ProjectNode = {
      id: 'project-1',
      type: 'project',
      name: 'Demo',
      color: '210 50% 50%',
      parentId: null,
      sortOrder: 0,
      children: [],
    };
    const node = {
      data: project,
      isOpen: false,
      toggle: vi.fn(),
      activate: vi.fn(),
      tree: { indent: 12 },
    } as unknown as NodeApi<ProjectNode>;
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
      onCreateChildBoard,
    } as unknown as NodeRendererProps<SidebarTreeNode> & {
      onSelectProject: (id: string) => void;
      activeProjectId: string | null;
      activeWorkspaceId: string | null;
      activeIssueId: string | null;
      onSelectIssue: (projectId: string, issueId: string) => void;
      onCreateChildBoard: (parentId: string) => void;
    };
    const { container } = render(<TreeNodeRouter {...props} />);
    const addBtn = container.querySelector(
      'button[aria-label="sidebar.createChildBoard"]'
    ) as HTMLButtonElement;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn);
    expect(onCreateChildBoard).toHaveBeenCalledWith('project-1');
    expect(node.toggle).not.toHaveBeenCalled();
  });

  it('Unassigned project row does NOT render a "+" button (ADR-015)', () => {
    const { container } = renderProjectWithDndContext('unassigned');
    expect(
      container.querySelector('button[aria-label="sidebar.createChildBoard"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="sidebar.openProjectKanban"]')
    ).toBeNull();
  });
});
