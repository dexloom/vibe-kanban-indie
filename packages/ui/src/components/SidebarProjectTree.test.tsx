import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, ProjectStatus } from 'shared/remote-types';
import type { SidebarProject } from './outliner/types';
import { SidebarProjectTree } from './SidebarProjectTree';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'sidebar.tasksSection': 'Tasks',
        'sidebar.workspacesSection': 'Workspaces',
        'sidebar.openProjectKanban': 'Open project kanban',
        'sidebar.tasksEmpty': 'No statuses yet',
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

const statusTodo: ProjectStatus = {
  id: 'todo',
  project_id: 'project-1',
  name: 'Todo',
  color: '210 50% 50%',
  sort_order: 0,
  hidden: false,
  created_at: '2026-08-03T00:00:00.000Z',
};

const statusReview: ProjectStatus = {
  ...statusTodo,
  id: 'review',
  name: 'Review',
  sort_order: 1,
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

const subIssue: Issue = {
  ...issue,
  id: 'issue-2',
  title: 'Sub issue',
  sort_order: 1,
  parent_issue_id: 'issue-1',
  parent_issue_sort_order: 0,
};

const projectOne: SidebarProject = {
  id: 'project-1',
  name: 'Project One',
  color: '210 50% 50%',
};
const projectTwo: SidebarProject = {
  id: 'project-2',
  name: 'Project Two',
  color: '10 50% 50%',
};

const BLOB_KEY = 'vibe.ui.sidebarTree.openState';

function seedBlob(state: Record<string, boolean>): void {
  window.localStorage.setItem(BLOB_KEY, JSON.stringify({ v: 1, state }));
}

function readBlob(): Record<string, boolean> {
  const raw = window.localStorage.getItem(BLOB_KEY);
  if (!raw) return {};
  return (JSON.parse(raw) as { state: Record<string, boolean> }).state ?? {};
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
});
afterEach(cleanup);

function renderTree(
  overrides: {
    projects?: SidebarProject[];
    tasksByProject?: ReadonlyMap<
      string,
      { statuses: ProjectStatus[]; issues: Issue[] }
    >;
    onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
    onSelectIssue?: (projectId: string, issueId: string) => void;
    onSelectProject?: (id: string) => void;
  } = {}
) {
  return render(
    <SidebarProjectTree
      projects={overrides.projects ?? [projectOne]}
      activeProjectId={null}
      workspaces={[]}
      membership={new Map()}
      activeWorkspaceId={null}
      onSelectWorkspace={vi.fn()}
      onSelectProject={overrides.onSelectProject ?? vi.fn()}
      tasksByProject={
        overrides.tasksByProject ??
        new Map([
          [
            'project-1',
            {
              statuses: [statusTodo, statusReview],
              issues: [issue, subIssue],
            },
          ],
        ])
      }
      loadingTasksProjectIds={new Set()}
      activeIssueId={null}
      onTasksExpansionChange={overrides.onTasksExpansionChange}
      onSelectIssue={overrides.onSelectIssue}
    />
  );
}

function rowForText(text: string): HTMLElement {
  // Click the label itself so the event bubbles through TreeRow's toggle to
  // react-arborist's outer row (which handles select+activate).
  return screen.getByText(text);
}

function outerRowForText(text: string): HTMLElement {
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
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.textContent).not.toContain('Must not render in sidebar');
  });

  it('reports Tasks section open and closed state', async () => {
    const onTasksExpansionChange = vi.fn();
    renderTree({ onTasksExpansionChange });

    // Tasks defaults OPEN (owner decision); the first click collapses it.
    fireEvent.click(rowForText('Tasks'));
    await waitFor(() =>
      expect(onTasksExpansionChange).toHaveBeenLastCalledWith(
        'project-1',
        false
      )
    );

    fireEvent.click(rowForText('Tasks'));
    await waitFor(() =>
      expect(onTasksExpansionChange).toHaveBeenLastCalledWith('project-1', true)
    );
  });

  it('selects an issue when its title row is clicked', async () => {
    const onSelectIssue = vi.fn();
    renderTree({ onSelectIssue });

    // Tasks is open by default — no need to expand it first.
    fireEvent.click(await screen.findByText('Todo'));
    fireEvent.click(await screen.findByText('Fix auth'));

    await waitFor(() =>
      expect(onSelectIssue).toHaveBeenCalledWith('project-1', 'issue-1')
    );
  });

  it('navigates to a project exactly once and toggles it on row click', async () => {
    const onSelectProject = vi.fn();
    renderTree({ onSelectProject });

    // The project defaults open; clicking the row must navigate once AND
    // collapse it (toggle-on-click, navigation via handleActivate).
    await waitFor(() => expect(screen.getByText('Tasks')).toBeTruthy());
    fireEvent.click(rowForText('Project One'));

    await waitFor(() => expect(onSelectProject).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Tasks')).toBeNull());
  });

  it('renders a caret for statuses with cards and a bullet for empty statuses', async () => {
    renderTree();

    // Tasks is open by default — statuses are already visible.
    await waitFor(() => expect(screen.getByText('Todo')).toBeTruthy());

    const todoRow = outerRowForText('Todo');
    const reviewRow = outerRowForText('Review');

    // Non-empty status: expandable caret button.
    expect(todoRow.querySelector('button[aria-label]')).not.toBeNull();
    // Empty status: bullet, no caret button.
    expect(reviewRow.querySelector('button[aria-label]')).toBeNull();
  });
});

describe('SidebarProjectTree open-state persistence', () => {
  it('replays persisted status/card open state and survives a reload round-trip', async () => {
    seedBlob({
      'project-1': true,
      'project-1:workspaces': true,
      'project-1:tasks': true,
      'project-1:status:todo': true,
      'project-1:card:issue-1': true,
    });

    const { unmount } = renderTree();

    // Tasks section seeded open; replay opens the status, which reveals the
    // parent card, whose own open state reveals the sub-issue.
    await waitFor(() =>
      expect(outerRowForText('Todo').getAttribute('aria-expanded')).toBe('true')
    );
    await waitFor(() =>
      expect(outerRowForText('Fix auth').getAttribute('aria-expanded')).toBe(
        'true'
      )
    );
    expect(await screen.findByText('Sub issue')).toBeTruthy();

    // Simulate a page reload: unmount and remount against the same storage.
    unmount();
    renderTree();

    await waitFor(() =>
      expect(outerRowForText('Todo').getAttribute('aria-expanded')).toBe('true')
    );
    expect(await screen.findByText('Sub issue')).toBeTruthy();
  });

  it('keeps statuses the user closed closed after a reload', async () => {
    seedBlob({
      'project-1': true,
      'project-1:workspaces': true,
      'project-1:tasks': true,
      'project-1:status:todo': true,
      'project-1:card:issue-1': true,
    });

    const { unmount } = renderTree();
    await waitFor(() =>
      expect(outerRowForText('Todo').getAttribute('aria-expanded')).toBe('true')
    );

    // User collapses the status; the replay guard must not re-open it on the
    // remount (the blob now records it closed).
    fireEvent.click(rowForText('Todo'));
    await waitFor(() =>
      expect(outerRowForText('Todo').getAttribute('aria-expanded')).toBe(
        'false'
      )
    );

    unmount();
    renderTree();

    await waitFor(() =>
      expect(outerRowForText('Todo').getAttribute('aria-expanded')).toBe(
        'false'
      )
    );
  });

  it('auto-opens a project added mid-session including its Tasks section', async () => {
    const { rerender } = renderTree();
    expect(screen.getAllByText('Workspaces')).toHaveLength(1);

    rerender(
      <SidebarProjectTree
        projects={[projectOne, projectTwo]}
        activeProjectId={null}
        workspaces={[]}
        membership={new Map()}
        activeWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        onSelectProject={vi.fn()}
        tasksByProject={
          new Map([['project-1', { statuses: [statusTodo], issues: [issue] }]])
        }
        loadingTasksProjectIds={new Set()}
        activeIssueId={null}
      />
    );

    // New project + its Workspaces section auto-opened → a second Workspaces
    // row is now visible.
    await waitFor(() =>
      expect(screen.getAllByText('Workspaces')).toHaveLength(2)
    );
    // Tasks defaults OPEN, so the new project's Tasks section auto-opens too.
    const tasksRows = screen.getAllByText('Tasks');
    expect(tasksRows).toHaveLength(2);
    expect(
      (tasksRows[1] as HTMLElement)
        .closest('[role="treeitem"]')
        ?.getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('prunes persisted keys for projects removed while the app is open', async () => {
    const { rerender } = renderTree();

    // Toggle the Tasks section (default open → close) so a project-scoped
    // key lands in the blob.
    fireEvent.click(rowForText('Tasks'));
    await waitFor(() => expect(readBlob()['project-1:tasks']).toBe(false));

    // Remove the only project → prune effect drops all its keys.
    rerender(
      <SidebarProjectTree
        projects={[]}
        activeProjectId={null}
        workspaces={[]}
        membership={new Map()}
        activeWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        onSelectProject={vi.fn()}
        tasksByProject={new Map()}
        loadingTasksProjectIds={new Set()}
        activeIssueId={null}
      />
    );

    await waitFor(() => expect(Object.keys(readBlob())).toHaveLength(0));
  });
});
