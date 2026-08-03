import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, ProjectStatus } from 'shared/remote-types';
import { SidebarProjectTree } from './SidebarProjectTree';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'sidebar.tasksSection': 'Tasks',
        'sidebar.workspacesSection': 'Workspaces',
        'sidebar.openProjectKanban': 'Open project kanban',
        'workspaces.outliner.attention': 'Attention',
        'workspaces.running': 'Running',
        'workspaces.idle': 'Idle',
        'workspaces.archived': 'Archived',
      })[key] ?? key,
  }),
}));

vi.mock('./outliner/useContainerHeight', () => ({
  useContainerHeight: () => ({
    containerRef: vi.fn(),
    width: 256,
    height: 800,
  }),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MemoryStorage {
  private store = new Map<string, string>();

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

globalThis.ResizeObserver = ResizeObserverMock as never;

const status: ProjectStatus = {
  id: 'todo',
  project_id: 'project-1',
  name: 'Todo',
  color: '210 50% 50%',
  sort_order: 0,
  hidden: false,
  created_at: '2026-08-03T00:00:00.000Z',
};

const issue: Issue = {
  id: 'issue-1',
  project_id: 'project-1',
  issue_number: 1,
  simple_id: 'PROJ-1',
  status_id: 'todo',
  title: 'Fix auth',
  description: 'Must not render in sidebar',
  priority: 'high',
  start_date: null,
  target_date: null,
  completed_at: null,
  sort_order: 0,
  parent_issue_id: null,
  parent_issue_sort_order: null,
  extension_metadata: {},
  creator_user_id: null,
  created_at: '2026-08-03T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
};

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
});
afterEach(cleanup);

function renderTree(
  overrides: {
    onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
    onSelectIssue?: (projectId: string, issueId: string) => void;
  } = {},
) {
  return render(
    <SidebarProjectTree
      projects={[
        { id: 'project-1', name: 'Project One', color: '210 50% 50%' },
      ]}
      activeProjectId={null}
      workspaces={[]}
      membership={new Map()}
      activeWorkspaceId={null}
      onSelectWorkspace={vi.fn()}
      onSelectProject={vi.fn()}
      onProjectsReorder={vi.fn()}
      tasksByProject={
        new Map([['project-1', { statuses: [status], issues: [issue] }]])
      }
      loadingTasksProjectIds={new Set()}
      activeIssueId={null}
      onTasksExpansionChange={overrides.onTasksExpansionChange}
      onSelectIssue={overrides.onSelectIssue}
    />,
  );
}

function rowForText(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[role="treeitem"]');
  if (!row) throw new Error(`Missing tree row for ${text}`);
  return row as HTMLElement;
}

describe('SidebarProjectTree tasks integration', () => {
  it('renders Tasks above Workspaces within a project', () => {
    const { container } = renderTree();

    const tasks = screen.getByText('Tasks');
    const workspaces = screen.getByText('Workspaces');
    expect(
      tasks.compareDocumentPosition(workspaces) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).not.toContain('Must not render in sidebar');
  });

  it('reports Tasks section open and closed state', async () => {
    const onTasksExpansionChange = vi.fn();
    renderTree({ onTasksExpansionChange });

    fireEvent.click(rowForText('Tasks'));
    await waitFor(() =>
      expect(onTasksExpansionChange).toHaveBeenLastCalledWith(
        'project-1',
        true,
      ),
    );

    fireEvent.click(rowForText('Tasks'));
    await waitFor(() =>
      expect(onTasksExpansionChange).toHaveBeenLastCalledWith(
        'project-1',
        false,
      ),
    );
  });

  it('selects an issue when its title row is clicked', async () => {
    const onSelectIssue = vi.fn();
    renderTree({ onSelectIssue });

    fireEvent.click(rowForText('Tasks'));
    fireEvent.click(await screen.findByText('Todo'));
    fireEvent.click(await screen.findByText('Fix auth'));

    await waitFor(() =>
      expect(onSelectIssue).toHaveBeenCalledWith('project-1', 'issue-1'),
    );
  });
});
