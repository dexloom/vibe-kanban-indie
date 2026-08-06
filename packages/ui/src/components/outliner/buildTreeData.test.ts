import { describe, expect, it } from 'vitest';
import type { Issue, ProjectStatus } from 'shared/remote-types';
import type { CardNode, SidebarProject } from './types';
import { UNASSIGNED_PROJECT_ID } from './types';
import type { OutlinerWorkspace } from './types';
import { buildTreeData } from './buildTreeData';
import type { ProjectTasksData } from './types';

const project = (
  id: string,
  overrides: Partial<SidebarProject> = {}
): SidebarProject => ({
  id,
  name: id,
  color: '0 0% 50%',
  parentId: null,
  sortOrder: 0,
  ...overrides,
});

const status = (
  id: string,
  overrides: Partial<ProjectStatus> = {}
): ProjectStatus => ({
  id,
  project_id: 'p1',
  name: id,
  color: '0 0% 50%',
  sort_order: 0,
  hidden: false,
  created_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const issue = (overrides: Partial<Issue>): Issue => ({
  id: overrides.id ?? 'i-default',
  project_id: 'p1',
  issue_number: 1,
  simple_id: (overrides.id ?? 'i-default').toUpperCase(),
  status_id: 's1',
  title: overrides.id ?? 'i-default',
  description: null,
  priority: null,
  start_date: null,
  target_date: null,
  completed_at: null,
  sort_order: 0,
  parent_issue_id: null,
  parent_issue_sort_order: null,
  extension_metadata: null,
  creator_user_id: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const t = (k: string): string => k;

function baseInput(
  overrides: Partial<Parameters<typeof buildTreeData>[0]> = {}
): Parameters<typeof buildTreeData>[0] {
  return {
    projects: [project('p1')],
    workspacesByProject: new Map(),
    archivedWorkspacesByProject: new Map(),
    unassignedActive: [],
    unassignedArchived: [],
    tasksByProject: new Map(),
    loadingTasksProjectIds: new Set(),
    t,
    ...overrides,
  };
}

describe('buildTreeData', () => {
  it('places the Tasks section above the Workspaces section', () => {
    // ADR-015: root's Workspaces section is now only rendered when the
    // aggregate is non-empty (mirrors the Unassigned gate). Seed one
    // workspace so the section appears.
    // ADR-016: the orchestrator-prompt leaf is inserted between Tasks
    // and child boards ONLY when the project has a prompt (added via the
    // `+` menu). With no prompt and no child boards, the order is
    // [Tasks, Workspaces].
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [],
    };
    const input = baseInput({
      workspacesByProject: new Map([
        [
          'p1',
          [
            {
              id: 'w1',
              name: 'w1',
              createdAt: '2026-08-01T00:00:00.000Z',
            } as OutlinerWorkspace,
          ],
        ],
      ]),
      tasksByProject: new Map([['p1', tasks]]),
    });

    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    expect(projectNode.type).toBe('project');
    if (projectNode.type !== 'project') return;
    const tasksSection = projectNode.children[0]!;
    const workspacesSection = projectNode.children[1]!;
    expect(tasksSection.type).toBe('section');
    expect(workspacesSection.type).toBe('section');
    if (
      tasksSection.type !== 'section' ||
      workspacesSection.type !== 'section'
    ) {
      throw new Error('expected section children');
    }
    expect(tasksSection.kind).toBe('tasks');
    expect(workspacesSection.kind).toBe('workspaces');
  });

  it('always renders a Tasks section for a real project (empty when no data)', () => {
    const input = baseInput();
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section') {
      throw new Error('expected section');
    }
    expect(tasksSection.kind).toBe('tasks');
    expect(tasksSection.type).toBe('section');
    expect(tasksSection.children).toEqual([]);
  });

  it('Tasks section carries correct id, label, and echoed projectId', () => {
    const input = baseInput();
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks section');
    expect(tasksSection.id).toBe('p1:tasks');
    expect(tasksSection.label).toBe('sidebar.tasksSection');
    expect(tasksSection.projectId).toBe('p1');
  });

  it('sorts statuses by sort_order ascending', () => {
    const tasks: ProjectTasksData = {
      statuses: [
        status('s3', { sort_order: 3 }),
        status('s1', { sort_order: 1 }),
        status('s2', { sort_order: 2 }),
      ],
      issues: [],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const statusIds = tasksSection.children.map((c) => c.statusId);
    expect(statusIds).toEqual(['s1', 's2', 's3']);
  });

  it('drops statuses flagged hidden', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s-visible'), status('s-hidden', { hidden: true })],
      issues: [issue({ id: 'i-orphan', status_id: 's-hidden' })],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const statusIds = tasksSection.children.map((c) => c.statusId);
    expect(statusIds).toEqual(['s-visible']);
    expect(tasksSection.children.every((c) => c.children.length === 0)).toBe(
      true
    );
  });

  it('groups issues by status_id', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1'), status('s2', { sort_order: 1 })],
      issues: [
        issue({ id: 'i1', status_id: 's1' }),
        issue({ id: 'i2', status_id: 's2' }),
        issue({ id: 'i3', status_id: 's1' }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const byStatus = Object.fromEntries(
      tasksSection.children.map((s) => [
        s.statusId,
        s.children.map((c) => c.issue.id),
      ])
    );
    expect(byStatus).toEqual({ s1: ['i1', 'i3'], s2: ['i2'] });
  });

  it('sorts top-level issues within a status by sort_order ascending', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({ id: 'i5', sort_order: 5 }),
        issue({ id: 'i1', sort_order: 1 }),
        issue({ id: 'i3', sort_order: 3 }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const ids = tasksSection.children[0]!.children.map((c) => c.issue.id);
    expect(ids).toEqual(['i1', 'i3', 'i5']);
  });

  it('drops orphan issues whose status_id is not in the visible status set', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({ id: 'i-kept', status_id: 's1' }),
        issue({ id: 'i-orphan', status_id: 's-deleted' }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const allIds = tasksSection.children.flatMap((s) =>
      s.children.map((c) => c.issue.id)
    );
    expect(allIds).toEqual(['i-kept']);
  });

  it('nests sub-issues under their parent card (depth 2 and depth 3)', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({ id: 'p1', status_id: 's1' }),
        issue({
          id: 'c1',
          status_id: 's1',
          parent_issue_id: 'p1',
          parent_issue_sort_order: 0,
        }),
        issue({
          id: 'g1',
          status_id: 's1',
          parent_issue_id: 'c1',
          parent_issue_sort_order: 0,
        }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const parent = tasksSection.children[0]!.children[0]!;
    expect(parent.issue.id).toBe('p1');
    expect(parent.children).toHaveLength(1);
    const child = parent.children[0]!;
    expect(child.issue.id).toBe('c1');
    expect(child.children).toHaveLength(1);
    expect(child.children[0]!.issue.id).toBe('g1');
    expect(child.children[0]!.children).toEqual([]);
  });

  it('handles a parent cycle (A→B→A) without dropping issues or recursing infinitely', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({ id: 'a', status_id: 's1', parent_issue_id: 'b' }),
        issue({ id: 'b', status_id: 's1', parent_issue_id: 'a' }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const collectIds = (cards: CardNode[]): string[] =>
      cards.flatMap((c) => [c.issue.id, ...collectIds(c.children)]);
    const allIds = tasksSection.children.flatMap((s) => collectIds(s.children));
    expect(allIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicate ids
  });

  it('handles a self-cycle (A→A) without recursion', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [issue({ id: 'a', status_id: 's1', parent_issue_id: 'a' })],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const allIds = tasksSection.children.flatMap((s) =>
      s.children.map((c) => c.issue.id)
    );
    expect(allIds).toEqual(['a']);
  });

  it('sorts sub-issues within a parent by parent_issue_sort_order ascending', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({ id: 'p1', status_id: 's1' }),
        issue({
          id: 'c3',
          status_id: 's1',
          parent_issue_id: 'p1',
          parent_issue_sort_order: 3,
        }),
        issue({
          id: 'c1',
          status_id: 's1',
          parent_issue_id: 'p1',
          parent_issue_sort_order: 1,
        }),
        issue({
          id: 'c2',
          status_id: 's1',
          parent_issue_id: 'p1',
          parent_issue_sort_order: 2,
        }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const parent = tasksSection.children[0]!.children[0]!;
    expect(parent.children.map((c) => c.issue.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('promotes a sub-issue whose parent is missing from the same status to top-level', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({
          id: 'orphan-child',
          status_id: 's1',
          parent_issue_id: 'p-missing',
          parent_issue_sort_order: 0,
        }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const tops = tasksSection.children[0]!.children;
    expect(tops).toHaveLength(1);
    expect(tops[0]!.issue.id).toBe('orphan-child');
    expect(tops[0]!.children).toEqual([]);
  });

  it('preserves parentIssueId on sub-issue cards', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({ id: 'p1', status_id: 's1' }),
        issue({
          id: 'c1',
          status_id: 's1',
          parent_issue_id: 'p1',
          parent_issue_sort_order: 0,
        }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const parent = tasksSection.children[0]!.children[0]!;
    expect(parent.issue.parentIssueId).toBeNull();
    const child = parent.children[0]!;
    expect(child.issue.parentIssueId).toBe('p1');
  });

  it('gives leaf cards an empty children array', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [issue({ id: 'leaf', status_id: 's1' })],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const leaf = tasksSection.children[0]!.children[0]!;
    expect(leaf.children).toEqual([]);
  });

  it('omits the Tasks section for the Unassigned pseudo-project', () => {
    const input = baseInput({
      projects: [],
      unassignedActive: [
        {
          id: 'ws1',
          name: 'ws1',
          createdAt: '2026-08-01T00:00:00.000Z',
        } as OutlinerWorkspace,
      ],
    });
    const tree = buildTreeData(input);
    const unassigned = tree.find((n) => n.id === UNASSIGNED_PROJECT_ID);
    expect(unassigned).toBeDefined();
    if (!unassigned || unassigned.type !== 'project') {
      throw new Error('expected unassigned project');
    }
    expect(unassigned.children).toHaveLength(1);
    const unassignedSection = unassigned.children[0]!;
    if (unassignedSection.type !== 'section') {
      throw new Error('expected section');
    }
    expect(unassignedSection.kind).toBe('workspaces');
  });

  it('mirrors isLoading onto the Tasks section from loadingTasksProjectIds', () => {
    const input = baseInput({
      loadingTasksProjectIds: new Set(['p1']),
    });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    expect(tasksSection.isLoading).toBe(true);

    const input2 = baseInput();
    const tree2 = buildTreeData(input2);
    const projectNode2 = tree2[0]!;
    if (projectNode2.type !== 'project') throw new Error('expected project');
    const tasksSection2 = projectNode2.children[0]!;
    if (tasksSection2.type !== 'section' || tasksSection2.kind !== 'tasks')
      throw new Error('expected tasks');
    expect(tasksSection2.isLoading).toBeFalsy();
  });

  it('emits only the trimmed payload on card.issue', () => {
    const tasks: ProjectTasksData = {
      statuses: [status('s1')],
      issues: [
        issue({
          id: 'i1',
          status_id: 's1',
          priority: 'high',
        }),
      ],
    };
    const input = baseInput({ tasksByProject: new Map([['p1', tasks]]) });
    const tree = buildTreeData(input);
    const projectNode = tree[0]!;
    if (projectNode.type !== 'project') throw new Error('expected project');
    const tasksSection = projectNode.children[0]!;
    if (tasksSection.type !== 'section' || tasksSection.kind !== 'tasks')
      throw new Error('expected tasks');
    const card = tasksSection.children[0]!.children[0]!;
    expect(card.issue).toEqual({
      id: 'i1',
      title: 'i1',
      priority: 'high',
      statusId: 's1',
      projectId: 'p1',
      parentIssueId: null,
    });
    expect(card.id).toBe('p1:card:i1');
    expect(Object.keys(card.issue).sort()).toEqual([
      'id',
      'parentIssueId',
      'priority',
      'projectId',
      'statusId',
      'title',
    ]);
  });

  it('keeps multiple projects independent (no status leakage)', () => {
    const tasksA: ProjectTasksData = {
      statuses: [status('sA', { project_id: 'pA' })],
      issues: [issue({ id: 'iA', project_id: 'pA', status_id: 'sA' })],
    };
    const tasksB: ProjectTasksData = {
      statuses: [status('sB', { project_id: 'pB' })],
      issues: [issue({ id: 'iB', project_id: 'pB', status_id: 'sB' })],
    };
    const input = baseInput({
      projects: [project('pA'), project('pB')],
      tasksByProject: new Map([
        ['pA', tasksA],
        ['pB', tasksB],
      ]),
    });
    const tree = buildTreeData(input);
    const projectA = tree[0]!;
    const projectB = tree[1]!;
    if (projectA.type !== 'project' || projectB.type !== 'project') {
      throw new Error('expected projects');
    }
    const tasksA_node = projectA.children[0]!;
    const tasksB_node = projectB.children[0]!;
    if (
      tasksA_node.type !== 'section' ||
      tasksA_node.kind !== 'tasks' ||
      tasksB_node.type !== 'section' ||
      tasksB_node.kind !== 'tasks'
    ) {
      throw new Error('expected tasks sections');
    }
    expect(tasksA_node.id).toBe('pA:tasks');
    expect(tasksB_node.id).toBe('pB:tasks');
    const idsA = tasksA_node.children.flatMap((s) =>
      s.children.map((c) => c.issue.id)
    );
    const idsB = tasksB_node.children.flatMap((s) =>
      s.children.map((c) => c.issue.id)
    );
    expect(idsA).toEqual(['iA']);
    expect(idsB).toEqual(['iB']);
  });

  it('groups nested boards under their parent after the sections', () => {
    // ADR-015: Workspace section only renders when aggregate is non-empty.
    // ADR-016: the orchestrator-prompt leaf is rendered ONLY when the
    // project has a prompt (added via `+`). None of these projects have
    // `hasOrchestratorPrompt`, so the order is [Tasks, ...childBoards,
    // Workspaces].
    const input = baseInput({
      projects: [
        project('p-root', { name: 'root' }),
        project('p-child-a', {
          name: 'child-a',
          parentId: 'p-root',
        }),
        project('p-child-b', {
          name: 'child-b',
          parentId: 'p-root',
        }),
        project('p-grand', {
          name: 'grand',
          parentId: 'p-child-a',
        }),
      ],
      workspacesByProject: new Map([['p-root', [ws('w-root')]]]),
    });
    const tree = buildTreeData(input);
    const root = tree[0]!;
    if (root.type !== 'project') throw new Error('expected project');
    expect(root.children).toHaveLength(4);
    expect(root.children[0]!.type).toBe('section');
    expect(root.children[1]!.type).toBe('project');
    expect(root.children[2]!.type).toBe('project');
    const childA = root.children[1]!;
    const childB = root.children[2]!;
    if (childA.type !== 'project' || childB.type !== 'project') {
      throw new Error('expected nested project children');
    }
    expect(childA.id).toBe('p-child-a');
    expect(childB.id).toBe('p-child-b');
    const lastChild = root.children[3]!;
    if (lastChild.type !== 'section' || lastChild.kind !== 'workspaces') {
      throw new Error('expected workspaces section at the bottom');
    }
    const nestedAChildren = childA.children.filter((c) => c.type === 'project');
    expect(nestedAChildren).toHaveLength(1);
    expect(nestedAChildren[0]!.id).toBe('p-grand');
  });

  /// ADR-016: the orchestrator-prompt leaf is rendered ONLY when the
  /// project has a prompt (added via the `+` menu). A project with a
  /// prompt gets the node between its Tasks and child boards; a project
  /// WITHOUT one gets no node at all.
  it('renders orchestrator-prompt leaf only when the project has a prompt', () => {
    const input = baseInput({
      projects: [
        project('p-root', {
          name: 'root',
          hasOrchestratorPrompt: true,
        }),
        project('p-child', {
          name: 'child',
          parentId: 'p-root',
          hasOrchestratorPrompt: false,
        }),
      ],
    });
    const tree = buildTreeData(input);
    const root = tree[0]!;
    if (root.type !== 'project') throw new Error('expected project');

    // Root has a prompt: [Tasks, OrchestratorPrompt, child]. No workspaces
    // section (no aggregates). The prompt row sits AT index 1.
    const promptNode = root.children[1]!;
    if (promptNode.type !== 'orchestrator-prompt') {
      throw new Error('expected orchestrator-prompt at index 1');
    }
    expect(promptNode.projectId).toBe('p-root');
    expect(promptNode.id).toBe('p-root:orchestrator-prompt');
    expect(promptNode.hasPrompt).toBe(true);
    expect(promptNode.label).toBe('sidebar.orchestratorPrompt');

    // Child board has NO prompt → its children are [Tasks] only (no
    // orchestrator-prompt node, no grand-child).
    const childProject = root.children[2]!;
    if (childProject.type !== 'project') {
      throw new Error('expected nested project child');
    }
    const childHasPromptNode = childProject.children.some(
      (c) => c.type === 'orchestrator-prompt'
    );
    expect(childHasPromptNode).toBe(false);
  });

  /// ADR-016: missing `hasOrchestratorPrompt` defaults to `false` (the
  /// dot stays dark). This keeps pre-ADR-016 test fixtures working
  /// without a forced rewrite — the buildTreeData path is the only
  /// reader today.
  it('omits the orchestrator-prompt node when hasOrchestratorPrompt is missing/false', () => {
    const input = baseInput();
    const tree = buildTreeData(input);
    const root = tree[0]!;
    if (root.type !== 'project') throw new Error('expected project');
    const hasPromptNode = root.children.some(
      (c) => c.type === 'orchestrator-prompt'
    );
    expect(hasPromptNode).toBe(false);
  });

  it('F-1: sibling projects sort by sortOrder (not UUID), so reorder survives refresh', () => {
    // Regression for the silent reorder bug: `bySidebarProjectOrderAsc`
    // used to compare by `id.localeCompare(id)`, which made sibling order
    // follow UUID order and silently undid every drag-reorder on refresh.
    const input = baseInput({
      projects: [
        project('p-b', { sortOrder: 200 }),
        project('p-a', { sortOrder: 100 }),
        project('p-c', { sortOrder: 300 }),
      ],
    });
    const tree = buildTreeData(input);
    expect(tree.map((node) => node.id)).toEqual(['p-a', 'p-b', 'p-c']);
  });

  it('F-1: a root sorts before its child even when the child has higher sortOrder', () => {
    // Roots render as the top-level list; their children render nested
    // inside the parent. A root with sortOrder=0 should still appear
    // before its child with sortOrder=9999 because the child is nested,
    // not in the top-level ordering.
    const input = baseInput({
      projects: [
        project('p-root', { name: 'root', sortOrder: 0 }),
        project('p-child', {
          name: 'child',
          parentId: 'p-root',
          sortOrder: 9999,
        }),
      ],
    });
    const tree = buildTreeData(input);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    if (root.type !== 'project') throw new Error('expected root project');
    expect(root.id).toBe('p-root');
    const nested = root.children.filter((c) => c.type === 'project');
    expect(nested).toHaveLength(1);
    expect(nested[0]!.id).toBe('p-child');
  });
});

// ============================================================================
// ADR-015: root-only Workspaces aggregation
// ============================================================================
//
// 1. Only ROOT projects (parentId === null) render a Workspaces section.
// 2. The root's Workspaces section aggregates active + archived workspaces of
//    the entire subtree (root + all descendants), deduped by workspace.id.
// 3. The Workspaces section is hidden when the aggregate is empty.
// 4. Children order at the root: [Tasks, ...childBoards, Workspaces].
// 5. Unassigned is unchanged (keeps its own Workspaces section).
// 6. Tasks section is unchanged (toggle-only).

function ws(
  id: string,
  overrides: Partial<OutlinerWorkspace> = {}
): OutlinerWorkspace {
  return {
    id,
    name: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as OutlinerWorkspace;
}

describe('buildTreeData ADR-015 root-only Workspaces', () => {
  it('root with no workspace memberships has NO Workspaces section in its children', () => {
    const input = baseInput({
      projects: [project('p-root')],
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    // Sections: only the Tasks section (kind === 'tasks'); no workspaces.
    const sections = root.children.filter((c) => c.type === 'section');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.type === 'section' && sections[0]!.kind).toBe('tasks');
  });

  it('root aggregates own + child-board workspaces deduplicated by id', () => {
    const input = baseInput({
      projects: [project('p-root'), project('p-child', { parentId: 'p-root' })],
      workspacesByProject: new Map([
        ['p-root', [ws('w1'), ws('w2')]],
        ['p-child', [ws('w2'), ws('w3')]],
      ]),
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    const wsSection = root.children.find(
      (c) => c.type === 'section' && c.kind === 'workspaces'
    );
    expect(wsSection).toBeDefined();
    if (
      !wsSection ||
      wsSection.type !== 'section' ||
      wsSection.kind !== 'workspaces'
    ) {
      throw new Error('expected workspaces section');
    }
    const allBuckets = wsSection.children.flatMap((b) =>
      b.children.map((leaf) => leaf.workspace.id)
    );
    // w1, w2, w3 — each appears exactly once.
    expect(new Set(allBuckets)).toEqual(new Set(['w1', 'w2', 'w3']));
    expect(allBuckets).toHaveLength(3);
  });

  it('a workspace linked to both root AND a child appears exactly once', () => {
    // Membership is M:N; a workspace linked to root + child must dedupe by id.
    const input = baseInput({
      projects: [project('p-root'), project('p-child', { parentId: 'p-root' })],
      workspacesByProject: new Map([
        ['p-root', [ws('w-shared')]],
        ['p-child', [ws('w-shared')]],
      ]),
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    const wsSection = root.children.find(
      (c) => c.type === 'section' && c.kind === 'workspaces'
    );
    expect(wsSection).toBeDefined();
    if (
      !wsSection ||
      wsSection.type !== 'section' ||
      wsSection.kind !== 'workspaces'
    ) {
      throw new Error('expected workspaces section');
    }
    const ids = wsSection.children.flatMap((b) =>
      b.children.map((leaf) => leaf.workspace.id)
    );
    expect(ids.filter((id) => id === 'w-shared')).toHaveLength(1);

    // The child board itself has NO Workspaces section (ADR-015 §4).
    const child = root.children.find(
      (c) => c.type === 'project' && c.id === 'p-child'
    );
    if (!child || child.type !== 'project') throw new Error('expected child');
    const childSections = child.children.filter((c) => c.type === 'section');
    expect(childSections).toHaveLength(1);
    expect(childSections[0]!.type === 'section' && childSections[0]!.kind).toBe(
      'tasks'
    );
  });

  it('child board (non-root) has NO Workspaces section in its children', () => {
    const input = baseInput({
      projects: [project('p-root'), project('p-child', { parentId: 'p-root' })],
      workspacesByProject: new Map([['p-child', [ws('w-only-on-child')]]]),
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    const child = root.children.find(
      (c) => c.type === 'project' && c.id === 'p-child'
    );
    if (!child || child.type !== 'project') throw new Error('expected child');
    const wsSection = child.children.find(
      (c) => c.type === 'section' && c.kind === 'workspaces'
    );
    expect(wsSection).toBeUndefined();
  });

  it('root children order is [Tasks, OrchestratorPrompt, ...childBoards, Workspaces]', () => {
    // ADR-016: the prompt node sits between Tasks and child boards, but
    // ONLY when the root has a prompt (added via `+`).
    const input = baseInput({
      projects: [
        project('p-root', { hasOrchestratorPrompt: true }),
        project('p-child-a', { parentId: 'p-root' }),
        project('p-child-b', { parentId: 'p-root' }),
      ],
      workspacesByProject: new Map([['p-root', [ws('w1')]]]),
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    const tags = root.children.map((c) => {
      if (c.type === 'section') {
        return `section:${c.kind}`;
      }
      if (c.type === 'orchestrator-prompt') {
        return `orchestrator-prompt:${c.projectId}`;
      }
      return `project:${c.id}`;
    });
    expect(tags).toEqual([
      'section:tasks',
      'orchestrator-prompt:p-root',
      'project:p-child-a',
      'project:p-child-b',
      'section:workspaces',
    ]);
  });

  it("archived workspaces in subtree land in the root's archived bucket", () => {
    // Two passes: aggregate active and aggregate archived separately, dedupe
    // each by id. A workspace is "archived" iff it appears in the
    // archivedWorkspacesByProject map; the active list must not include it.
    const input = baseInput({
      projects: [project('p-root'), project('p-child', { parentId: 'p-root' })],
      workspacesByProject: new Map([
        ['p-root', [ws('w-active')]],
        ['p-child', [ws('w-active'), ws('w-other-active')]],
      ]),
      archivedWorkspacesByProject: new Map([
        ['p-root', [ws('w-archived')]],
        ['p-child', [ws('w-archived-2')]],
      ]),
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    const wsSection = root.children.find(
      (c) => c.type === 'section' && c.kind === 'workspaces'
    );
    expect(wsSection).toBeDefined();
    if (
      !wsSection ||
      wsSection.type !== 'section' ||
      wsSection.kind !== 'workspaces'
    ) {
      throw new Error('expected workspaces section');
    }
    const archivedBucket = wsSection.children.find(
      (b) => b.bucketId === 'archived'
    );
    expect(archivedBucket).toBeDefined();
    const archivedIds = (archivedBucket?.children ?? []).map(
      (leaf) => leaf.workspace.id
    );
    expect(new Set(archivedIds)).toEqual(
      new Set(['w-archived', 'w-archived-2'])
    );
    // The active workspaces must NOT appear in the archived bucket.
    expect(archivedIds).not.toContain('w-active');
  });

  it('depth-2 grandchild board workspace aggregates into the root', () => {
    const input = baseInput({
      projects: [
        project('p-root'),
        project('p-child', { parentId: 'p-root' }),
        project('p-grand', { parentId: 'p-child' }),
      ],
      workspacesByProject: new Map([
        ['p-root', [ws('w-root')]],
        ['p-child', [ws('w-child')]],
        ['p-grand', [ws('w-grand')]],
      ]),
    });
    const tree = buildTreeData(input);
    const root = tree.find((n) => n.type === 'project' && n.id === 'p-root');
    if (!root || root.type !== 'project') throw new Error('expected root');
    const wsSection = root.children.find(
      (c) => c.type === 'section' && c.kind === 'workspaces'
    );
    expect(wsSection).toBeDefined();
    if (
      !wsSection ||
      wsSection.type !== 'section' ||
      wsSection.kind !== 'workspaces'
    ) {
      throw new Error('expected workspaces section');
    }
    const ids = wsSection.children.flatMap((b) =>
      b.children.map((leaf) => leaf.workspace.id)
    );
    expect(new Set(ids)).toEqual(new Set(['w-root', 'w-child', 'w-grand']));
  });

  it('Unassigned pseudo-project still renders its own Workspaces section', () => {
    // ADR-015 §6: Unassigned is unchanged. Keep its own Workspaces section.
    const input = baseInput({
      projects: [],
      unassignedActive: [ws('w-orphaned')],
    });
    const tree = buildTreeData(input);
    const unassigned = tree.find((n) => n.id === UNASSIGNED_PROJECT_ID);
    if (!unassigned || unassigned.type !== 'project') {
      throw new Error('expected unassigned');
    }
    const wsSection = unassigned.children.find(
      (c) => c.type === 'section' && c.kind === 'workspaces'
    );
    expect(wsSection).toBeDefined();
    const taskSection = unassigned.children.find(
      (c) => c.type === 'section' && c.kind === 'tasks'
    );
    expect(taskSection).toBeUndefined();
  });
});
