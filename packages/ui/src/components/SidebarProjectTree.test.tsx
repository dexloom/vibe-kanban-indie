import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, ProjectStatus } from 'shared/remote-types';
import type { OutlinerWorkspace, SidebarProject } from './outliner/types';
import { SidebarProjectTree } from './SidebarProjectTree';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'sidebar.tasksSection': 'Tasks',
        'sidebar.workspacesSection': 'Workspaces',
        'sidebar.orchestrator': 'Orchestrator',
        'sidebar.orchestratorPrompt': 'Orchestrator prompt',
        'sidebar.orchestratorPromptSet': 'Orchestrator prompt is set',
        'sidebar.addOrchestratorPrompt': 'Add orchestrator prompt',
        'sidebar.projectActions': 'Project actions',
        'sidebar.addChildBoard': 'Add board',
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
  parentId: null,
  sortOrder: 0,
};
const projectTwo: SidebarProject = {
  id: 'project-2',
  name: 'Project Two',
  color: '10 50% 50%',
  parentId: null,
  sortOrder: 1,
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
    workspaces?: OutlinerWorkspace[];
    membership?: Map<string, Set<string>>;
    onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
    onSelectIssue?: (projectId: string, issueId: string) => void;
    onOpenProjectPage?: (id: string) => void;
    onCreateChildBoard?: (parentId: string) => void;
    onSelectOrchestratorPrompt?: (projectId: string) => void;
  } = {}
) {
  return render(
    <SidebarProjectTree
      projects={overrides.projects ?? [projectOne]}
      activeProjectId={null}
      workspaces={overrides.workspaces ?? []}
      membership={overrides.membership ?? new Map()}
      activeWorkspaceId={null}
      onSelectWorkspace={vi.fn()}
      onOpenProjectPage={overrides.onOpenProjectPage}
      onCreateChildBoard={overrides.onCreateChildBoard}
      onSelectOrchestratorPrompt={overrides.onSelectOrchestratorPrompt}
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

/** Click a row's caret button (expand/collapse). Collapse-by-default
 * (2026-08-07): row click toggles too (handleActivate → node.toggle); the
 * caret is the keyboard/explicit-toggle affordance. */
function caretFor(text: string): HTMLButtonElement {
  const row = outerRowForText(text);
  const caret = row.querySelector('button[aria-label]') as HTMLButtonElement;
  if (!caret) throw new Error(`No caret button for ${text}`);
  return caret;
}

describe('SidebarProjectTree tasks integration', () => {
  it('renders Tasks above Workspaces within a project', () => {
    // Collapse-by-default: seed the project open so its sections render.
    seedBlob({ 'project-1': true });
    // ADR-015: roots render a Workspaces section only when the aggregate
    // is non-empty. Seed a workspace so the section appears.
    const membership = new Map<string, Set<string>>([
      ['ws-1', new Set(['project-1'])],
    ]);
    const { container } = renderTree({
      projects: [projectOne],
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          createdAt: '2026-08-03T00:00:00.000Z',
        },
      ],
      membership,
    });

    const tasks = screen.getByText('Tasks');
    const workspaces = screen.getByText('Workspaces');
    expect(
      tasks.compareDocumentPosition(workspaces) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.textContent).not.toContain('Must not render in sidebar');
  });

  it('reports Tasks section open and closed state', async () => {
    seedBlob({ 'project-1': true, 'project-1:tasks': true });
    const onTasksExpansionChange = vi.fn();
    renderTree({ onTasksExpansionChange });

    // Tasks is seeded OPEN; the first caret click collapses it.
    fireEvent.click(caretFor('Tasks'));
    await waitFor(() =>
      expect(onTasksExpansionChange).toHaveBeenLastCalledWith(
        'project-1',
        false
      )
    );

    fireEvent.click(caretFor('Tasks'));
    await waitFor(() =>
      expect(onTasksExpansionChange).toHaveBeenLastCalledWith('project-1', true)
    );
  });

  it('selects an issue when its title row is clicked', async () => {
    seedBlob({ 'project-1': true, 'project-1:tasks': true });
    const onSelectIssue = vi.fn();
    renderTree({ onSelectIssue });

    // Tasks is seeded open; the status 'Todo' has cards so its caret opens it.
    fireEvent.click(caretFor('Todo'));
    fireEvent.click(await screen.findByText('Fix auth'));

    await waitFor(() =>
      expect(onSelectIssue).toHaveBeenCalledWith('project-1', 'issue-1')
    );
  });

  it('row click toggles the project; the open-page icon navigates without toggling', async () => {
    seedBlob({ 'project-1': true }); // project open, Tasks closed (default)
    const onOpenProjectPage = vi.fn();
    renderTree({ onOpenProjectPage });

    await waitFor(() => expect(screen.getByText('Tasks')).toBeTruthy());
    // Row click toggles the project closed (children vanish).
    fireEvent.click(rowForText('Project One'));
    await waitFor(() => expect(screen.queryByText('Tasks')).toBeNull());

    // Re-open via caret, then the open-page icon navigates without toggling.
    fireEvent.click(caretFor('Project One'));
    await waitFor(() => expect(screen.getByText('Tasks')).toBeTruthy());
    // The project row's icon is the first open-page icon in DOM order
    // (the Tasks section also renders one).
    const icon = screen.getAllByLabelText('sidebar.openProjectPage')[0]!;
    fireEvent.click(icon);
    await waitFor(() =>
      expect(onOpenProjectPage).toHaveBeenCalledWith('project-1')
    );
    // Project stays open (icon did not toggle).
    expect(screen.getByText('Tasks')).toBeTruthy();
  });

  it('the caret toggles a project row open (collapse-by-default)', async () => {
    renderTree();

    // Default closed: Tasks NOT visible. The caret opens the project.
    await waitFor(() => expect(screen.queryByText('Tasks')).toBeNull());
    fireEvent.click(caretFor('Project One'));
    await waitFor(() => expect(screen.getByText('Tasks')).toBeTruthy());
  });

  it('renders a caret for non-empty statuses and hides empty statuses', async () => {
    seedBlob({ 'project-1': true, 'project-1:tasks': true });
    renderTree();

    // Tasks is seeded open — the non-empty status is visible.
    await waitFor(() => expect(screen.getByText('Todo')).toBeTruthy());

    const todoRow = outerRowForText('Todo');
    // Non-empty status: expandable caret button.
    expect(todoRow.querySelector('button[aria-label]')).not.toBeNull();
    // Empty status 'Review' is hidden entirely (empty-column filter).
    expect(screen.queryByText('Review')).toBeNull();
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

    // User collapses the status via its caret; the replay guard must not
    // re-open it on the remount (the blob now records it closed).
    fireEvent.click(caretFor('Todo'));
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

  it('a project added mid-session stays collapsed by default (collapse-by-default)', async () => {
    // project-1 seeded open with its Workspaces section open so the initial
    // render shows one Workspaces row.
    seedBlob({ 'project-1': true, 'project-1:workspaces': true });
    const initialMembership = new Map<string, Set<string>>([
      ['ws-1', new Set(['project-1'])],
    ]);
    const { rerender } = renderTree({
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws-1',
          createdAt: '2026-08-03T00:00:00.000Z',
        },
      ],
      membership: initialMembership,
    });
    expect(screen.getAllByText('Workspaces')).toHaveLength(1);

    const afterMembership = new Map<string, Set<string>>([
      ['ws-1', new Set(['project-1'])],
      ['ws-2', new Set(['project-2'])],
    ]);
    rerender(
      <SidebarProjectTree
        projects={[projectOne, projectTwo]}
        activeProjectId={null}
        workspaces={[
          {
            id: 'ws-1',
            name: 'ws-1',
            createdAt: '2026-08-03T00:00:00.000Z',
          },
          {
            id: 'ws-2',
            name: 'ws-2',
            createdAt: '2026-08-03T00:00:00.000Z',
          },
        ]}
        membership={afterMembership}
        activeWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        tasksByProject={
          new Map([['project-1', { statuses: [statusTodo], issues: [issue] }]])
        }
        loadingTasksProjectIds={new Set()}
        activeIssueId={null}
      />
    );

    // project-2 appears as a root row but stays collapsed — no second
    // Workspaces/Tasks row appears.
    await waitFor(() => expect(screen.getByText('Project Two')).toBeTruthy());
    expect(screen.getAllByText('Workspaces')).toHaveLength(1);
    expect(screen.getAllByText('Tasks')).toHaveLength(1);
  });

  it('prunes persisted keys for projects removed while the app is open', async () => {
    seedBlob({ 'project-1': true }); // project open so Tasks is reachable
    const { rerender } = renderTree();

    // Tasks defaults closed; open it so a project-scoped key lands in the blob.
    fireEvent.click(caretFor('Tasks'));
    await waitFor(() => expect(readBlob()['project-1:tasks']).toBe(true));

    // Remove the only project → prune effect drops all its keys.
    rerender(
      <SidebarProjectTree
        projects={[]}
        activeProjectId={null}
        workspaces={[]}
        membership={new Map()}
        activeWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        tasksByProject={new Map()}
        loadingTasksProjectIds={new Set()}
        activeIssueId={null}
      />
    );

    await waitFor(() => expect(Object.keys(readBlob())).toHaveLength(0));
  });

  it('preserves persisted status keys when Tasks data is not loaded (ADR-015 prune scope)', async () => {
    // Regression for the over-broad ADR-015 prune: status/card keys must
    // survive even when their project's Tasks section is closed (so no
    // status nodes exist in treeData). Seeding a closed Tasks section means
    // `tasksByProject` is absent → the live-tree full-id check must NOT drop
    // `project-1:status:todo`.
    seedBlob({
      'project-1': true,
      'project-1:tasks': false,
      'project-1:status:todo': true,
    });
    const { unmount } = renderTree({
      projects: [projectOne],
      tasksByProject: new Map(), // Tasks data never loads for closed section
    });
    await waitFor(() => expect(screen.queryByText('Todo')).toBeNull());
    unmount();
    expect(readBlob()['project-1:status:todo']).toBe(true);
    // Workspace structural keys are still pruned when the section is gone.
    seedBlob({ 'project-1': true, 'project-1:workspaces': true });
    const { unmount: unmount2 } = renderTree({ projects: [projectOne] });
    await waitFor(() =>
      expect(readBlob()['project-1:workspaces']).toBeUndefined()
    );
    unmount2();
  });

  it('Unassigned appears collapsed when it first appears mid-session (collapse-by-default)', async () => {
    // Start with no orphan workspaces: Unassigned absent.
    const { rerender } = renderTree({
      projects: [projectOne],
      workspaces: [],
      membership: new Map(),
    });
    expect(screen.queryByText('Orchestrator')).toBeNull();

    // A workspace loses its membership → Unassigned appears mid-session.
    rerender(
      <SidebarProjectTree
        projects={[projectOne]}
        activeProjectId={null}
        workspaces={[
          {
            id: 'ws-orphan',
            name: 'ws-orphan',
            createdAt: '2026-08-03T00:00:00.000Z',
          },
        ]}
        membership={new Map()}
        activeWorkspaceId={null}
        onSelectWorkspace={vi.fn()}
        tasksByProject={new Map()}
        loadingTasksProjectIds={new Set()}
        activeIssueId={null}
      />
    );

    // The pseudo-project row appears (labelled "Orchestrator") but stays
    // collapsed — bucket labels are NOT visible without an explicit expand.
    await waitFor(() => expect(screen.getByText('Orchestrator')).toBeTruthy());
    expect(screen.queryByText('Idle')).toBeNull();
  });

  /// ADR-016: the prompt row renders between Tasks and any child boards.
  /// Clicking the row invokes `onSelectOrchestratorPrompt`. The
  /// brand-coloured dot is shown only when `hasOrchestratorPrompt` is
  /// true (mirrors the wire `has_orchestrator_prompt` flag).
  it('renders the orchestrator-prompt row and fires onSelectOrchestratorPrompt', async () => {
    seedBlob({ 'project-1': true }); // project open so the prompt row renders
    const onSelectOrchestratorPrompt = vi.fn();
    renderTree({
      onSelectOrchestratorPrompt,
      projects: [
        {
          ...projectOne,
          hasOrchestratorPrompt: true,
        },
      ],
    });

    // Wait for the prompt row to render.
    const promptRow = await screen.findByText('Orchestrator prompt');
    expect(promptRow).toBeTruthy();

    // The brand-coloured dot is rendered.
    const dot = screen.getByTestId(`orchestrator-prompt-dot-${projectOne.id}`);
    expect(dot).toBeTruthy();

    // Click the OUTER tree row (react-arborist's wrapping <div
    // role="treeitem">). The row's onClick bubbles up to the activation
    // handler. Clicking the inner span alone wouldn't trigger activation
    // reliably because react-arborist listens on the outer row.
    const outerRow = promptRow.closest('[role="treeitem"]');
    expect(outerRow).toBeTruthy();
    fireEvent.click(outerRow as HTMLElement);
    await waitFor(() =>
      expect(onSelectOrchestratorPrompt).toHaveBeenCalledWith(projectOne.id)
    );
  });

  /// ADR-016: the `+` button is now a DropdownMenu with two items
  /// ("Add board" + "Add orchestrator prompt"). The old single-purpose
  /// button is gone.
  it('renders a `+` dropdown with Add board and Add orchestrator prompt items', async () => {
    const onCreateChildBoard = vi.fn();
    const onSelectOrchestratorPrompt = vi.fn();
    const { baseElement } = renderTree({
      projects: [projectOne],
      onCreateChildBoard,
      onSelectOrchestratorPrompt,
    });

    // Wait for the trigger to mount.
    const trigger = (await screen.findByLabelText(
      'Project actions'
    )) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    // Radix's DropdownMenu.Trigger opens on pointerdown by default (jsdom
    // doesn't dispatch pointer events from `click`, so we drive the
    // pointerdown path explicitly).
    fireEvent.pointerDown(trigger, { button: 0 });
    // Radix renders the menu content into a portal — search the whole
    // document (portals attach to baseElement.body, not the render
    // container).
    const menuItems = baseElement.querySelectorAll('[role="menuitem"]');
    expect(menuItems.length).toBe(2);
    expect(menuItems[0]!.textContent).toContain('Add board');
    expect(menuItems[1]!.textContent).toContain('Add orchestrator prompt');

    // Clicking "Add orchestrator prompt" fires the callback.
    fireEvent.click(menuItems[1] as HTMLElement);
    await waitFor(() =>
      expect(onSelectOrchestratorPrompt).toHaveBeenCalledWith(projectOne.id)
    );
  });
});
