import type { Issue } from 'shared/remote-types';
import { categorizeWorkspacesForOutliner } from '../../lib/workspaceStatus';
import { BUCKETS, BUCKET_ORDER } from '../../lib/buckets';
import {
  UNASSIGNED_PROJECT_ID,
  makeCardNodeId,
  makeStatusNodeId,
  makeTasksSectionId,
  makeWorkspacesSectionId,
  type BucketNode,
  type CardNode,
  type LeafNode,
  type OutlinerWorkspace,
  type ProjectNode,
  type ProjectTasksData,
  type SectionNode,
  type SidebarProject,
  type SidebarTreeNode,
  type StatusNode,
  type TasksSectionNode,
  type WorkspacesSectionNode,
} from './types';

export interface BuildTreeDataInput {
  projects: readonly SidebarProject[];
  workspacesByProject: Map<string, OutlinerWorkspace[]>;
  archivedWorkspacesByProject: Map<string, OutlinerWorkspace[]>;
  unassignedActive: readonly OutlinerWorkspace[];
  unassignedArchived: readonly OutlinerWorkspace[];
  /** Per-project kanban data. Absent entry = "never loaded" (Tasks section
   *  renders empty/closed). */
  tasksByProject: ReadonlyMap<string, ProjectTasksData>;
  /** Projects whose first-open load is still in flight. */
  loadingTasksProjectIds: ReadonlySet<string>;
  t: (key: string) => string;
}

/**
 * Build the full sidebar tree (ADR-007 + ADR-011). PURE: no React, no i18n
 * state, no side effects. `t` is injected so this module is unit-testable with
 * a stub translator.
 *
 * Rules (all asserted by tests in §5):
 *  - Per real project: Tasks section ABOVE Workspaces section.
 *  - Tasks section always present for real projects (even when empty).
 *  - Statuses: drop `hidden`, sort by `sort_order` ASC.
 *  - Cards: group by `status_id`; within a status, **top-level issues** (no
 *    parent_issue_id, or whose parent is missing) sorted by `sort_order` ASC;
 *    **sub-issues nested under their parent card**, sorted by
 *    `parent_issue_sort_order` ASC.
 *  - Orphan issues (status_id not in the visible-status set) are dropped.
 *  - Unassigned pseudo-project: NO Tasks section.
 *  - `TasksSectionNode.isLoading` = `loadingTasksProjectIds.has(projectId)`.
 */
export function buildTreeData(input: BuildTreeDataInput): SidebarTreeNode[] {
  const { t } = input;
  const childrenByParent = new Map<string | null, SidebarProject[]>();
  for (const project of input.projects) {
    const key = project.parentId ?? null;
    const list = childrenByParent.get(key) ?? [];
    list.push(project);
    childrenByParent.set(key, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort(bySidebarProjectOrderAsc);
  }
  const realProjectIds = new Set(input.projects.map((project) => project.id));
  const rootProjects = childrenByParent.get(null) ?? [];
  const projectNodes: ProjectNode[] = rootProjects.map((project) =>
    buildProjectNode(project, input, t, childrenByParent, realProjectIds)
  );

  if (
    input.unassignedActive.length > 0 ||
    input.unassignedArchived.length > 0
  ) {
    projectNodes.push(buildUnassignedNode(input, t));
  }
  return projectNodes;
}

function buildProjectNode(
  project: SidebarProject,
  input: BuildTreeDataInput,
  t: (k: string) => string,
  childrenByParent: Map<string | null, SidebarProject[]>,
  realProjectIds: Set<string>,
  seen: Set<string> = new Set()
): ProjectNode {
  const tasks = buildTasksSection(project.id, input, t);
  const workspaces = buildWorkspacesSection(
    project.id,
    input.workspacesByProject.get(project.id) ?? [],
    input.archivedWorkspacesByProject.get(project.id) ?? [],
    t
  );
  // Sections first (Tasks above Workspaces), then nested subprojects.
  const children: (SectionNode | ProjectNode)[] = [tasks, workspaces];
  if (!seen.has(project.id)) {
    const nextSeen = new Set(seen);
    nextSeen.add(project.id);
    const boards = childrenByParent.get(project.id) ?? [];
    for (const board of boards) {
      if (!realProjectIds.has(board.id) || nextSeen.has(board.id)) continue;
      children.push(
        buildProjectNode(
          board,
          input,
          t,
          childrenByParent,
          realProjectIds,
          nextSeen
        )
      );
    }
  }
  return {
    id: project.id,
    type: 'project',
    name: project.name,
    color: project.color,
    parentId: project.parentId,
    sortOrder: project.sortOrder,
    children,
  };
}

function buildTasksSection(
  projectId: string,
  input: BuildTreeDataInput,
  t: (k: string) => string
): TasksSectionNode {
  const data = input.tasksByProject.get(projectId);
  const visibleStatuses = (data?.statuses ?? [])
    .filter((s) => !s.hidden)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const statusById = new Set(visibleStatuses.map((s) => s.id));

  const issuesByStatus = new Map<string, Issue[]>();
  for (const issue of data?.issues ?? []) {
    if (!statusById.has(issue.status_id)) continue; // orphan → drop
    const arr = issuesByStatus.get(issue.status_id);
    if (arr) arr.push(issue);
    else issuesByStatus.set(issue.status_id, [issue]);
  }

  const statusNodes: StatusNode[] = visibleStatuses
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((status) => ({
      id: makeStatusNodeId(projectId, status.id),
      type: 'status',
      projectId,
      statusId: status.id,
      name: status.name,
      color: status.color,
      children: buildCardForest(issuesByStatus.get(status.id) ?? []),
    }));

  return {
    id: makeTasksSectionId(projectId),
    type: 'section',
    kind: 'tasks',
    projectId,
    label: t('sidebar.tasksSection'),
    isLoading: input.loadingTasksProjectIds.has(projectId),
    children: statusNodes,
  };
}

function buildWorkspacesSection(
  projectId: string,
  active: readonly OutlinerWorkspace[],
  archived: readonly OutlinerWorkspace[],
  t: (k: string) => string
): WorkspacesSectionNode {
  const {
    attention,
    running,
    idle,
    archived: archivedBucket,
  } = categorizeWorkspacesForOutliner(active, archived);
  const buckets: BucketNode[] = BUCKET_ORDER.map((bucketId) => ({
    id: `${projectId}:bucket:${bucketId}`,
    type: 'bucket',
    bucketId,
    name: t(BUCKETS[bucketId].labelKey),
    children: (bucketId === 'attention'
      ? attention
      : bucketId === 'running'
        ? running
        : bucketId === 'idle'
          ? idle
          : archivedBucket
    ).map(
      (workspace): LeafNode => ({
        id: workspace.id,
        type: 'leaf',
        workspace,
      })
    ),
  }));
  return {
    id: makeWorkspacesSectionId(projectId),
    type: 'section',
    kind: 'workspaces',
    label: t('sidebar.workspacesSection'),
    children: buckets,
  };
}

/**
 * Build a recursive card forest from a status's flat issue list. Top-level
 * cards = issues whose `parent_issue_id` is null OR whose parent is not in the
 * same status's issue set (orphan parent → promoted to top-level, mirroring
 * the kanban board). Sub-issues nest under their parent, sorted by
 * `parent_issue_sort_order` ASC; top-level cards sorted by `sort_order` ASC.
 * The `parent_issue_id` is kept on the node so the card renderer can show
 * sub-issue depth without re-deriving it.
 */
function buildCardForest(issues: readonly Issue[]): CardNode[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenByParent = new Map<string, Issue[]>();
  const roots: Issue[] = [];

  for (const issue of issues) {
    const parent = issue.parent_issue_id
      ? byId.get(issue.parent_issue_id)
      : undefined;
    if (parent) {
      const arr = childrenByParent.get(parent.id);
      if (arr) arr.push(issue);
      else childrenByParent.set(parent.id, [issue]);
    } else {
      roots.push(issue);
    }
  }

  const toIssuePayload = (issue: Issue): CardNode['issue'] => ({
    id: issue.id,
    title: issue.title,
    priority: issue.priority,
    statusId: issue.status_id,
    projectId: issue.project_id,
    parentIssueId: issue.parent_issue_id,
  });

  // A parent cycle (A→B→A) leaves every member with a parent, so none reach
  // `roots` and the whole cycle would silently vanish. `placed` guards both
  // directions: recursion is truncated at the first revisit (no infinite
  // depth, no duplicate ids in the tree), and any issue never reached from a
  // root is promoted to a top-level card so nothing disappears.
  const placed = new Set<string>();
  const toCardNode = (issue: Issue): CardNode | null => {
    if (placed.has(issue.id)) return null; // cycle → truncate here
    placed.add(issue.id);
    return {
      // Project-scoped id so the open-state blob's read-time GC (which
      // derives projectId from the first ':' segment) keeps card entries.
      id: makeCardNodeId(issue.project_id, issue.id),
      type: 'card',
      issue: toIssuePayload(issue),
      children: (childrenByParent.get(issue.id) ?? [])
        .slice()
        .sort(
          (a, b) =>
            (a.parent_issue_sort_order ?? 0) - (b.parent_issue_sort_order ?? 0)
        )
        .map(toCardNode)
        .filter((node): node is CardNode => node !== null),
    };
  };

  const tree = roots
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(toCardNode)
    .filter((node): node is CardNode => node !== null);

  const unplaced = issues.filter((issue) => !placed.has(issue.id));
  if (unplaced.length > 0) {
    tree.push(
      ...unplaced
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(toCardNode)
        .filter((node): node is CardNode => node !== null)
    );
  }

  return tree;
}

function buildUnassignedNode(
  input: BuildTreeDataInput,
  t: (k: string) => string
): ProjectNode {
  // Unassigned never gets a Tasks section (owner decision; both variants agree).
  const workspaces = buildWorkspacesSection(
    UNASSIGNED_PROJECT_ID,
    input.unassignedActive,
    input.unassignedArchived,
    t
  );
  return {
    id: UNASSIGNED_PROJECT_ID,
    type: 'project',
    name: t('sidebar.unassigned'),
    color: '0 0% 60%',
    parentId: null,
    // Unassigned is a pseudo-project; the user never drags it, so its
    // sort_order is meaningless. `0` matches the default in
    // `create_project`.
    sortOrder: 0,
    children: [workspaces],
  };
}

function bySidebarProjectOrderAsc(
  a: SidebarProject,
  b: SidebarProject
): number {
  // ADR-013: sibling projects sort by `sort_order` first (user intent), then
  // `id` as a stable tiebreak. The old `localeCompare(id)` only order — which
  // looked like UUID sort — silently broke sibling reorder: a swap moved the
  // rows visually back to UUID order on every refresh.
  const byOrder = a.sortOrder - b.sortOrder;
  if (byOrder !== 0) return byOrder;
  return a.id.localeCompare(b.id);
}
