# PLAN — Sidebar per-project Tasks section

- **Date:** 2026-08-03
- **Branch:** `feat/ui-modernization`
- **Status:** Ready to implement
- **ADR ref:** ADR-011 (pending — file `docs/ADR/ADR-011-sidebar-project-tasks-section.md`,
  set `Status: Proposed` before code, `Accepted` after merge)
- **Design sources:** variant A (escalate-glm) + variant B (escalate-deepseek), reconciled

---

## 1. Goal

Add a per-project **Tasks** section to the sidebar tree, rendered **above** the
existing **Workspaces** section inside each project node. The Tasks section is a
collapsed kanban board: one **status column** child per `ProjectStatus`, each
containing **issue cards** as leaves.

```
Project
  ├─ Tasks                      ← NEW section (collapsed by default)
  │    ├─ Backlog               ← status (ProjectStatus, hidden dropped)
  │    │    ├─ PROJ-1  Fix auth ← card (Issue)
  │    │    └─ PROJ-3  ...
  │    └─ In Progress
  │         └─ PROJ-2  ...
  └─ Workspaces                 ← existing section, unchanged
       ├─ Attention / Running / Idle / Archived
```

Data: `ProjectStatus` + `Issue` via `PROJECT_PROJECT_STATUSES_SHAPE` and
`PROJECT_ISSUES_SHAPE` (one subscription per project, lazy). Card click →
`appNavigation.goToProjectIssue(projectId, issueId)`.

**Verified facts driving the design** (full evidence in §10):

- `react-arborist@3.16.0` computes `isOpen(id)` **live** on every render:
  `state.nodes.open.unfiltered[id] ?? (props.openByDefault ?? true)`
  (`node_modules/.../interfaces/tree-api.js` `isOpen`, L784–796). The open map
  is seeded **once** at mount from `initialOpenState` (`state/initial.js`), then
  mutated only by user toggles / imperative `treeApi.open|close|toggle`
  (`interfaces/tree-api.js` L606/618/630).
- **Consequence:** any node whose id is absent from the seed map falls back to
  `openByDefault`. Today no nodes appear post-mount, so `openByDefault` is
  inert. Lazy status nodes arrive **post-mount** (ids unknown at seed time) →
  they would fall back to `openByDefault`. The existing component passes bare
  `openByDefault` (= `true`), so lazy statuses would render OPEN → "kanban
  huge" explosion. This is why §3 mandates `openByDefault={false}`.
- `useShape` lives in **web-core** (`packages/web-core/src/shared/integrations/electric/hooks.ts`).
  The layer rule forbids `packages/ui` → web-core imports, so the data hook and
  loader components **must** live in web-core.
- `Issue` / `ProjectStatus` field sets (from `shared/remote-types.ts` L19/L23):
  `Issue = { id, project_id, issue_number, simple_id, status_id, title, priority:
  IssuePriority|null, sort_order, parent_issue_id, ... }`;
  `ProjectStatus = { id, project_id, name, color, sort_order, hidden, ... }`;
  `IssuePriority = "urgent"|"high"|"medium"|"low"`.
- `goToProjectIssue(projectId, issueId, transition?)` exists on `AppNavigation`
  (`packages/web-core/src/shared/lib/routes/appNavigation.ts` L55).
- `Sidebar` is mounted twice in `SharedAppLayout` (desktop + mobile drawer)
  and already accepts all props we need to extend.

---

## 2. Reconciliation decisions

One decision per divergence, with rationale. Verified against source.

| # | Divergence | Decision | Rationale |
|---|---|---|---|
| 1 | Hook/loader location: web-core (A) vs `packages/ui/...` (B) | **web-core** | `useShape` is in `@/shared/integrations/electric/hooks` (web-core). `packages/ui` cannot import web-core (layer rule, AGENTS.md). B's placement **would violate** the rule. The registry + loaders are web-core; `SidebarProjectTree` stays a pure (props-in) component. |
| 2 | Lazy trigger: Tasks-section toggle (A) vs project expand (B) | **Tasks-section toggle (A)** | Coherent with §2.2 (Tasks closed by default). Trigger fires the moment data is needed: user opens the Tasks section → load statuses+issues for that one project. Project-expand (B) would force eager load for every open project at mount = "eager-all" (refused by both variants). See §3.4 for the open-Tasks detection path. |
| 3 | `openByDefault` + lazy status nodes | **Flip to `openByDefault={false}` + seed the map at mount + tiny `useEffect` that imperatively opens brand-new projects** | The crux. With current `openByDefault={true}`, lazy status nodes (absent from the seed-once map) fall back to `true` → render OPEN → "kanban huge". Variant A's claim that it can keep `openByDefault={true}` and force statuses closed is **false**: `initialOpenState` is consumed once at mount (`state/initial.js`) when status ids are not yet known, and A's tree-walk cannot seed ids it doesn't have. `openByDefault={false}` makes lazy statuses default CLOSED with **no first-render flash** and **no imperative hack per status**. The new-project `useEffect` (§3.6) preserves the ADR-007 "newly-added projects auto-expand" guarantee by calling `treeApi.open(projectId)` + its two section ids. The existing seed-once contract test already uses `openByDefault={false}`, so this is consistent with the documented contract. |
| 4 | Tasks section default: open (B) vs closed (A) | **Closed (A)** | Open-by-default is incompatible with lazy-on-toggle (#2): an open section with no data either spins for every project at mount (eager) or shows empty until a toggle that already fired. Closed-by-default keeps the **section header always visible** (caret + "Tasks" label, above "Workspaces") — discoverable, not hidden — while contents stay collapsed until the user opts in. One click loads + reveals. Avoids a project with 5 statuses × 10 cards dominating a 256px sidebar. |
| 5 | `buildTreeData`: extract to `outliner/buildTreeData.ts` (A) vs keep in `SidebarProjectTree` (B) | **Extract (A)** | Currently a non-exported function inside `SidebarProjectTree.tsx` (L57–142) — untestable in isolation. It is the heart of this feature (Tasks-above-Workspaces, sort rules, orphan drop, recursive sub-issue nesting). Extraction to a pure module is what makes the red-test-first TDD sequence in §5 possible. |
| 6 | Status/Card renderer files: separate (B) vs in `treeNodes.tsx` (A) | **Separate files** | Repo convention: `BucketNode.tsx`, `LeafNode.tsx`, `TreeCaretRow.tsx` are already separate. `treeNodes.tsx` is the **router** (L111–163); adding two non-trivial renderers inline would bloat it. New: `outliner/TasksSectionNode.tsx`, `outliner/StatusNode.tsx`, `outliner/CardNode.tsx`. |
| 7 | Priority indicator: include a dot (B) vs defer (A) | **Include a small dot** | `IssuePriority` already exists on the card data; a 6px colored dot (urgent=error, high=warning, medium=brand, low=tertiary, null=none) is cheap, scannable at 256px, and matches the density owner likes. No new data, no new subscription. |
| 8 | Loading state: spinner in Tasks section (A risk#7) vs none (B) | **Spinner** | Local SQLite/Electric is sub-second but a `SpinnerIcon` next to the Tasks label (gated on `isLoading`) distinguishes "loading" from "this project has no statuses". Cheap and removes ambiguity on first open. |

**Net:** Variant A's architecture (web-core hook + registry/loader, lazy on
Tasks-toggle, Tasks closed by default, `buildTreeData` extraction) with Variant
B's renderer file layout + priority dot. The `openByDefault` flip is neither A
nor B as written — it is the **verified-correct resolution** of the hole both
variants hand-waved (see §10 for the react-arborist evidence).

---

## 3. Final architecture

### 3.1 Files

| Path | Action | Purpose |
|---|---|---|
| `packages/ui/src/components/outliner/types.ts` | EDIT | Add `TasksSectionId`, `kind`-discriminated `SectionNode` union, `StatusNode`, `CardNode`; move section-id factories here; **flip signature** of `buildSidebarTreeInitialOpenState` to walk a built tree. |
| `packages/ui/src/components/outliner/buildTreeData.ts` | **NEW** | Pure tree builder extracted from `SidebarProjectTree.tsx`. All sort/group/drop rules live here. |
| `packages/ui/src/components/outliner/TasksSectionNode.tsx` | **NEW** | Tasks section caret row (TreeCaretRow + spinner when loading + empty hint). |
| `packages/ui/src/components/outliner/StatusNode.tsx` | **NEW** | Status caret row (TreeCaretRow + color dot + card count). |
| `packages/ui/src/components/outliner/CardNode.tsx` | **NEW** | Issue card leaf (simpleId mono + title + priority dot + dotted guide + active state). |
| `packages/ui/src/components/outliner/treeNodes.tsx` | EDIT | Route `section` by `kind` and add `status`/`card` cases. Thread new callbacks. |
| `packages/ui/src/components/outliner/layout.ts` | EDIT | Add `rowHeight.status`, `rowHeight.card`. |
| `packages/ui/src/components/SidebarProjectTree.tsx` | EDIT | Drop inline `buildTreeData`; consume extracted one. Flip `openByDefault={false}`. Add new props + Tasks-toggle detection + new-project auto-open effect + card/status row heights. |
| `packages/ui/src/components/Sidebar.tsx` | EDIT | Thread new props (`tasksByProject`, `loadingTasksProjectIds`, `onTasksExpansionChange`, `onSelectIssue`, `activeIssueId`) to the tree. |
| `packages/web-core/src/shared/hooks/useProjectTasks.ts` | **NEW** | Single-project `useShape` wrapper for statuses+issues (web-core — owns Electric coupling). |
| `packages/web-core/src/shared/components/sidebar/SidebarProjectTasksRegistry.tsx` | **NEW** | Renders one `ProjectTasksLoader` per project; aggregates results into a `Map` + loading set; pushes them up. Zero DOM. |
| `packages/web-core/src/shared/components/ui-new/containers/SharedAppLayout.tsx` | EDIT | Own `openTasksProjectIds` + `tasksByProject` + `loadingTasksProjectIds` state; render the registry once; pass data + `onTasksExpansionChange` + `onSelectIssue` into both `<Sidebar>` instances. |
| `packages/web-core/src/i18n/locales/en/common.json` | EDIT | Add 3 keys under `sidebar`. |

No changes to `ProjectProvider`, the Electric layer, `shared/remote-types.ts`,
or any Rust crate. No persistence-schema version bump.

### 3.2 Node model — `outliner/types.ts`

The existing `SectionNode` (single interface, `type: 'section'`, `children:
BucketNode[]`) becomes a `kind`-discriminated **union**. `ProjectNode.children`
widens to `(WorkspacesSectionNode | TasksSectionNode)[]`. Two new node types
join `SidebarTreeNode`.

```ts
import type { IssuePriority } from 'shared/remote-types';

/** Per-project Tasks section id (e.g. `${projectId}:tasks`). */
export type TasksSectionId = `${string}:tasks`;

/** Section node now carries a `kind` so the router can split Tasks vs Workspaces. */
export interface WorkspacesSectionNode {
  id: WorkspacesSectionId;
  type: 'section';
  kind: 'workspaces';
  label: string;
  children: BucketNode[];
}

export interface TasksSectionNode {
  id: TasksSectionId;
  type: 'section';
  kind: 'tasks';
  /** Project id echoed so the renderer can fire onTasksExpansionChange(id, open)
   *  without walking to the parent. */
  projectId: string;
  label: string;
  /** True on first open, while statuses+issues are still loading. */
  isLoading?: boolean;
  children: StatusNode[];
}

/** Discriminate sections by `kind` (NOT by `type`, which stays 'section'). */
export type SectionNode = WorkspacesSectionNode | TasksSectionNode;

export interface StatusNode {
  id: string; // `${projectId}:status:${statusId}`
  type: 'status';
  projectId: string;
  statusId: string;
  name: string;
  color: string; // hsl triple string from ProjectStatus.color
  children: CardNode[];
}

/**
 * Issue card. Recursive: sub-issues (parent_issue_id) nest under their parent
 * card as `children`. Trimmed payload — only what the sidebar card needs.
 */
export interface CardNode {
  id: string; // issue.id (stable across reorders, globally unique)
  type: 'card';
  issue: {
    id: string;
    simpleId: string;
    title: string;
    priority: IssuePriority | null;
    statusId: string;
    projectId: string;
    parentIssueId: string | null;
  };
  children: CardNode[];
}

export type SidebarTreeNode =
  | ProjectNode
  | SectionNode
  | BucketNode
  | StatusNode
  | CardNode
  | LeafNode;

// --- id factories (moved here from SidebarProjectTree.tsx so the open-state
//     builder in this same file can use them) ---
export const makeWorkspacesSectionId = (projectId: string): WorkspacesSectionId =>
  `${projectId}:workspaces`;
export const makeTasksSectionId = (projectId: string): TasksSectionId =>
  `${projectId}:tasks`;
export const makeStatusNodeId = (projectId: string, statusId: string): string =>
  `${projectId}:status:${statusId}`;
```

`ProjectNode.children` changes from `SectionNode[]` to `SectionNode[]` (the
union) — same field name, wider type. No call-site breakage because all
consumers switch on `type`/`kind`.

### 3.3 Open-state persistence — `outliner/types.ts`

**Signature change** (the key refactor). `buildSidebarTreeInitialOpenState`
walks the **built tree** instead of a flat `projectIds` list, so it can seed
the Tasks section id per project and leave status ids un-seeded (they arrive
post-mount and default closed via `openByDefault={false}`).

```ts
/**
 * Build the `initialOpenState` map for <Tree>. Per-node resolution:
 *   1. value persisted in the sidebar-tree blob
 *   2. legacy per-bucket value (buckets only, first-run migration)
 *   3. default: project & Workspaces section & attention/running/idle buckets
 *      OPEN; archived bucket CLOSED; **Tasks section CLOSED**.
 *
 * Status nodes are INTENTIONALLY NOT seeded: their ids are unknown at mount
 * (tasks load lazily once the Tasks section is opened). With
 * `openByDefault={false}`, un-seeded ids default CLOSED — exactly the desired
 * first-open behavior. Seeding them here would be impossible (ids unknown) and
 * pointless. See ADR-011.
 *
 * As before, only the value at Tree mount is consumed; the prop is ignored
 * post-mount (verified: react-arborist `state/initial.js` seeds once inside
 * `useRef(createStore(...))`).
 */
export function buildSidebarTreeInitialOpenState(
  tree: readonly SidebarTreeNode[],
): Record<string, boolean> {
  const projectNodes = tree.filter(
    (n): n is ProjectNode => n.type === 'project',
  );
  const liveProjectIds = new Set(projectNodes.map((p) => p.id));
  const stored = readSidebarTreeOpenState(liveProjectIds);
  const useLegacy = Object.keys(stored).length === 0;
  const legacy: Partial<Record<BucketId, boolean>> = useLegacy
    ? readLegacyBucketOpenState()
    : {};

  const out: Record<string, boolean> = {};
  for (const project of projectNodes) {
    const isUnassigned = project.id === UNASSIGNED_PROJECT_ID;
    out[project.id] = stored[project.id] ?? true;

    const wsId = makeWorkspacesSectionId(project.id);
    out[wsId] = stored[wsId] ?? true;

    for (const bucketId of BUCKET_ORDER) {
      const nodeId = `${project.id}:bucket:${bucketId}`;
      out[nodeId] =
        stored[nodeId] ?? legacy[bucketId] ?? BUCKET_DEFAULT_OPEN[bucketId];
    }

    // Tasks section: real projects only, default CLOSED. Unassigned never has
    // a Tasks section, so do not emit an id for it (keeps the map clean and
    // prevents a phantom persisted key).
    if (!isUnassigned) {
      const tasksId = makeTasksSectionId(project.id);
      out[tasksId] = stored[tasksId] ?? false;
    }
  }
  return out;
}
```

No `SIDEBAR_TREE_OPEN_STATE_VERSION` bump. The blob is forward-compatible:
pre-existing entries for project/workspaces/bucket ids stay valid; new Tasks
ids simply default to `false` on the first run after upgrade. (A user who
previously toggled a node keeps their value; everyone else gets the documented
default.)

### 3.4 Tree builder — `outliner/buildTreeData.ts` (pure, the TDD target)

```ts
import type { Issue, ProjectStatus } from 'shared/remote-types';
import { categorizeWorkspacesForOutliner } from '../../lib/workspaceStatus';
import {
  BUCKET_ORDER,
  UNASSIGNED_PROJECT_ID,
  makeStatusNodeId,
  makeTasksSectionId,
  makeWorkspacesSectionId,
  type BucketNode,
  type CardNode,
  type LeafNode,
  type OutlinerWorkspace,
  type ProjectNode,
  type SidebarProject,
  type SidebarTreeNode,
  type StatusNode,
  type TasksSectionNode,
  type WorkspacesSectionNode,
} from './types';

export interface ProjectTasksData {
  statuses: readonly ProjectStatus[];
  issues: readonly Issue[];
}

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
  const projectNodes: ProjectNode[] = input.projects.map((project) =>
    buildProjectNode(project, input, t),
  );

  if (input.unassignedActive.length > 0 || input.unassignedArchived.length > 0) {
    projectNodes.push(buildUnassignedNode(input, t));
  }
  return projectNodes;
}

function buildProjectNode(
  project: SidebarProject,
  input: BuildTreeDataInput,
  t: (k: string) => string,
): ProjectNode {
  const tasks = buildTasksSection(project.id, input, t);
  const workspaces = buildWorkspacesSection(
    project.id,
    input.workspacesByProject.get(project.id) ?? [],
    input.archivedWorkspacesByProject.get(project.id) ?? [],
    t,
  );
  // Tasks ABOVE Workspaces.
  return {
    id: project.id,
    type: 'project',
    name: project.name,
    color: project.color,
    children: [tasks, workspaces],
  };
}

function buildTasksSection(
  projectId: string,
  input: BuildTreeDataInput,
  t: (k: string) => string,
): TasksSectionNode {
  const data = input.tasksByProject.get(projectId);
  const visibleStatuses = (data?.statuses ?? [])
    .filter((s) => !s.hidden)
    .sort(bySortOrderAsc);
  const statusById = new Set(visibleStatuses.map((s) => s.id));

  const issuesByStatus = new Map<string, Issue[]>();
  for (const issue of data?.issues ?? []) {
    if (!statusById.has(issue.status_id)) continue; // orphan → drop
    const arr = issuesByStatus.get(issue.status_id);
    if (arr) arr.push(issue);
    else issuesByStatus.set(issue.status_id, [issue]);
  }

  const statusNodes: StatusNode[] = visibleStatuses.map((status) => ({
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
  t: (k: string) => string,
): WorkspacesSectionNode {
  const { attention, running, idle, archived: archivedBucket } =
    categorizeWorkspacesForOutliner(active, archived);
  const labels = {
    attention: t('workspaces.outliner.attention'),
    running: t('workspaces.running'),
    idle: t('workspaces.idle'),
    archived: t('workspaces.archived'),
  };
  const buckets: BucketNode[] = BUCKET_ORDER.map((bucketId) => ({
    id: `${projectId}:bucket:${bucketId}`,
    type: 'bucket',
    bucketId,
    name: labels[bucketId],
    children: (
      bucketId === 'attention'
        ? attention
        : bucketId === 'running'
          ? running
          : bucketId === 'idle'
            ? idle
            : archivedBucket
    ).map((workspace): LeafNode => ({ id: workspace.id, type: 'leaf', workspace })),
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

  const toCardNode = (issue: Issue): CardNode => ({
    id: issue.id,
    type: 'card',
    issue: {
      id: issue.id,
      simpleId: issue.simple_id,
      title: issue.title,
      priority: issue.priority,
      statusId: issue.status_id,
      projectId: issue.project_id,
      parentIssueId: issue.parent_issue_id,
    },
    children: (childrenByParent.get(issue.id) ?? [])
      .slice()
      .sort((a, b) => (a.parent_issue_sort_order ?? 0) - (b.parent_issue_sort_order ?? 0))
      .map(toCardNode),
  });

  return roots
    .slice()
    .sort(bySortOrderAsc)
    .map(toCardNode);
}

function buildUnassignedNode(
  input: BuildTreeDataInput,
  t: (k: string) => string,
): ProjectNode {
  // Unassigned never gets a Tasks section (owner decision; both variants agree).
  const workspaces = buildWorkspacesSection(
    UNASSIGNED_PROJECT_ID,
    input.unassignedActive,
    input.unassignedArchived,
    t,
  );
  return {
    id: UNASSIGNED_PROJECT_ID,
    type: 'project',
    name: t('sidebar.unassigned'),
    color: '0 0% 60%',
    children: [workspaces],
  };
}

function bySortOrderAsc<T extends { sort_order: number }>(a: T, b: T): number {
  return a.sort_order - b.sort_order;
}
```

### 3.5 Hook + registry/loader — `web-core`

Lives in web-core because it calls `useShape` (Electric). `SidebarProjectTree`
never imports it.

#### `packages/web-core/src/shared/hooks/useProjectTasks.ts`

```ts
import { useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
  type Issue,
  type ProjectStatus,
} from 'shared/remote-types';

export interface ProjectTasksData {
  statuses: ProjectStatus[];
  issues: Issue[];
}

export interface ProjectTasksResult extends ProjectTasksData {
  isLoading: boolean;
}

/**
 * Subscribe to ONE project's statuses + issues (ADR-011). `enabled` gates the
 * Electric subscription so closed Tasks sections never pay for data. Must live
 * in web-core: it imports `@/shared/integrations/electric/hooks`, which
 * packages/ui is forbidden to touch (layer rule, AGENTS.md).
 */
export function useProjectTasks(
  projectId: string,
  enabled: boolean,
): ProjectTasksResult {
  const params = useMemo(() => ({ project_id: projectId }), [projectId]);
  const statuses = useShape(PROJECT_PROJECT_STATUSES_SHAPE, params, { enabled });
  const issues = useShape(PROJECT_ISSUES_SHAPE, params, { enabled });
  return {
    statuses: statuses.data,
    issues: issues.data,
    isLoading:
      enabled && (statuses.isLoading || issues.isLoading),
  };
}
```

#### `packages/web-core/src/shared/components/sidebar/SidebarProjectTasksRegistry.tsx`

Renders one loader per project id (rules-of-hooks safe: one component per
project). Aggregates results into a `Map` + a loading `Set`, pushed up via
effects. Renders **no DOM** (`return null`) — it is a data pump, not a view.

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  useProjectTasks,
  type ProjectTasksData,
} from '@/shared/hooks/useProjectTasks';

interface RegistryProps {
  /** All real (non-Unassigned) project ids that may show a Tasks section. */
  projectIds: readonly string[];
  /** Projects whose Tasks section is open → enabled. */
  openTasksProjectIds: ReadonlySet<string>;
  /** Fired (effect-batched) whenever the aggregated tasks map changes. */
  onTasksByProject: (map: ReadonlyMap<string, ProjectTasksData>) => void;
  /** Fired whenever the loading set changes. */
  onLoadingTasksProjectIds: (set: ReadonlySet<string>) => void;
}

export function SidebarProjectTasksRegistry({
  projectIds,
  openTasksProjectIds,
  onTasksByProject,
  onLoadingTasksProjectIds,
}: RegistryProps) {
  const [dataMap, setDataMap] = useState<Map<string, ProjectTasksData>>(
    () => new Map(),
  );
  const [loadingSet, setLoadingSet] = useState<Set<string>>(() => new Set());

  const reportData = useCallback((id: string, data: ProjectTasksData) => {
    setDataMap((prev) => {
      const next = new Map(prev);
      next.set(id, data);
      return next;
    });
  }, []);
  const reportLoading = useCallback((id: string, loading: boolean) => {
    setLoadingSet((prev) => {
      const has = prev.has(id);
      if (loading && !has) {
        const next = new Set(prev);
        next.add(id);
        return next;
      }
      if (!loading && has) {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      return prev; // unchanged → bail (avoids spurious effect downstream)
    });
  }, []);

  useEffect(() => {
    onTasksByProject(dataMap);
  }, [dataMap, onTasksByProject]);
  useEffect(() => {
    onLoadingTasksProjectIds(loadingSet);
  }, [loadingSet, onLoadingTasksProjectIds]);

  return (
    <>
      {projectIds.map((id) => (
        <ProjectTasksLoader
          key={id}
          projectId={id}
          enabled={openTasksProjectIds.has(id)}
          onData={reportData}
          onLoading={reportLoading}
        />
      ))}
    </>
  );
}

interface LoaderProps {
  projectId: string;
  enabled: boolean;
  onData: (id: string, data: ProjectTasksData) => void;
  onLoading: (id: string, loading: boolean) => void;
}

function ProjectTasksLoader({
  projectId,
  enabled,
  onData,
  onLoading,
}: LoaderProps) {
  const { statuses, issues, isLoading } = useProjectTasks(projectId, enabled);
  useEffect(() => {
    // Only report once we actually have data; a closed section reports nothing.
    if (enabled) onData(projectId, { statuses, issues });
  }, [enabled, projectId, statuses, issues, onData]);
  useEffect(() => {
    onLoading(projectId, isLoading);
  }, [projectId, isLoading, onLoading]);
  return null;
}
```

#### Wiring in `SharedAppLayout.tsx`

SharedAppLayout owns three pieces of state and passes them to **both** Sidebar
instances (desktop + mobile drawer). The registry is rendered **once** (above
the layout switch); both sidebars consume the same aggregated state.

```tsx
// New imports
import { SidebarProjectTasksRegistry } from '@/shared/components/sidebar/SidebarProjectTasksRegistry';
import type { ProjectTasksData } from '@/shared/hooks/useProjectTasks';

// Inside SharedAppLayout():
const [openTasksProjectIds, setOpenTasksProjectIds] = useState<
  ReadonlySet<string>
>(() => new Set());
const [tasksByProject, setTasksByProject] = useState<
  ReadonlyMap<string, ProjectTasksData>
>(() => new Map());
const [loadingTasksProjectIds, setLoadingTasksProjectIds] = useState<
  ReadonlySet<string>
>(() => new Set());

// Real (non-Unassigned) project ids for the registry.
const realProjectIds = useMemo(
  () => projects.map((p) => p.id),
  [projects],
);

// Stable updaters so the registry effects don't loop.
const handleTasksByProject = useCallback(
  (m: ReadonlyMap<string, ProjectTasksData>) => setTasksByProject(m),
  [],
);
const handleLoadingTasks = useCallback(
  (s: ReadonlySet<string>) => setLoadingTasksProjectIds(s),
  [],
);
const handleTasksExpansionChange = useCallback(
  (projectId: string, isOpen: boolean) => {
    setOpenTasksProjectIds((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  },
  [],
);
const handleSelectIssue = useCallback(
  (projectId: string, issueId: string) => {
    appNavigation.goToProjectIssue(projectId, issueId);
  },
  [appNavigation],
);

// One registry instance feeds both sidebars.
<SidebarProjectTasksRegistry
  projectIds={realProjectIds}
  openTasksProjectIds={openTasksProjectIds}
  onTasksByProject={handleTasksByProject}
  onLoadingTasksProjectIds={handleLoadingTasks}
/>;

// Both <Sidebar> instances get the new props:
<Sidebar
  /* existing props… */
  tasksByProject={tasksByProject}
  loadingTasksProjectIds={loadingTasksProjectIds}
  onTasksExpansionChange={handleTasksExpansionChange}
  onSelectIssue={handleSelectIssue}
  activeIssueId={currentDestination?.kind === 'project' ? currentDestination.issueId : null}
/>
```

> **Active card id:** the existing `currentDestination` (from
> `useCurrentAppDestination`) already carries the open project issue id on
> project-issue routes; thread it as `activeIssueId`. Exact field name verified
> at integration time.

### 3.6 `SidebarProjectTree.tsx` changes

1. **Delete** the inline `buildTreeData` (L48–142) and the local
   `makeWorkspacesSectionId`. Import the extracted `buildTreeData` from
   `./outliner/buildTreeData` and the id factories from `./outliner/types`.
2. **New props** on `SidebarProjectTreeProps`:
   ```ts
   tasksByProject?: ReadonlyMap<string, ProjectTasksData>;
   loadingTasksProjectIds?: ReadonlySet<string>;
   onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
   onSelectIssue?: (projectId: string, issueId: string) => void;
   activeIssueId?: string | null;
   ```
3. **Flip** `openByDefault` (L391) → `openByDefault={false}`.
4. **`initialOpenState`** now takes the built tree:
   ```ts
   const initialOpenState = useMemo(
     () => buildSidebarTreeInitialOpenState(treeData),
     [treeData],
   );
   ```
5. **Tasks-toggle detection** inside `handleToggle` — after persisting, look up
   the node; if it is a Tasks section, fire the callback so SharedAppLayout can
   enable the loader:
   ```ts
   const handleToggle = useCallback(
     (id: string) => {
       const node = treeRef.current?.get(id);
       if (!node) return;
       openStateRef.current = { ...openStateRef.current, [id]: node.isOpen };
       scheduleOpenStateWrite();
       if (
         node.data.type === 'section' &&
         node.data.kind === 'tasks'
       ) {
         onTasksExpansionChange?.(node.data.projectId, node.isOpen);
       }
     },
     [scheduleOpenStateWrite, onTasksExpansionChange],
   );
   ```
6. **Card activation** in `handleActivate` — add the card case:
   ```ts
   if (data.type === 'card') {
     onSelectIssue?.(data.issue.projectId, data.issue.id);
     return;
   }
   ```
7. **New-project auto-open** (`useEffect`) — preserves ADR-007 under
   `openByDefault={false}`. When a project id appears in `treeData` that we have
   never seen, open it + its Workspaces section + its Tasks section id (Tasks
   stays **closed** in the seed map, so opening the *id* here only affects
   brand-new projects that have no persisted state yet — exactly the ADR-007
   case). Track seen ids in a ref so we run once per project:
   ```ts
   const seenProjectIdsRef = useRef<Set<string>>(new Set());
   useEffect(() => {
     const api = treeRef.current;
     if (!api) return;
     for (const node of treeData) {
       if (node.type !== 'project') continue;
       if (seenProjectIdsRef.current.has(node.id)) continue;
       seenProjectIdsRef.current.add(node.id);
       // Seed default-open state for the new project only.
       api.open(node.id);
       api.open(makeWorkspacesSectionId(node.id));
       // Tasks section: respect the CLOSED default → do NOT open. Persist it
       // closed so the toggle mirror matches reality.
       openStateRef.current = {
         ...openStateRef.current,
         [node.id]: true,
         [makeWorkspacesSectionId(node.id)]: true,
       };
       scheduleOpenStateWrite();
     }
   }, [treeData, scheduleOpenStateWrite]);
   ```
   > **Why this is safe and minimal:** the effect runs only for project ids not
   > already in `seenProjectIdsRef`; the seed map at mount already covered the
   > initial set, so on a normal first mount this loop only marks the initial
   > ids as "seen" without re-opening. It only ever *opens* something for
   > projects added after mount (the ADR-007 case). Tasks section is
   > intentionally left closed here (matches decision #4).
8. **`rowHeight`** — add card + status heights; pass new props to
   `TreeNodeRouter`:
   ```ts
   rowHeight={(node) => {
     if (node.data.type === 'leaf') return TREE_LAYOUT.rowHeight.leaf;
     if (node.data.type === 'card') return TREE_LAYOUT.rowHeight.card;
     if (node.data.type === 'project') return TREE_LAYOUT.rowHeight.project;
     return TREE_LAYOUT.rowHeight.default;
   }}
   ```
   `<TreeNodeRouter … onSelectIssue={onSelectIssue} activeIssueId={activeIssueId} />`

### 3.7 `Sidebar.tsx` changes

Add the five new fields to `SidebarProps` (all optional, except the two
`on*` callbacks which are required when Tasks is used — kept optional with
`?` so the prop surface stays additive and the unit tests for `Sidebar` need
no change) and pass them straight through to `<SidebarProjectTree>`:

```diff
        onSelectWorkspace={onSelectWorkspace}
        onSelectProject={onSelectProject}
        onProjectsReorder={onProjectsReorder}
+       tasksByProject={tasksByProject}
+       loadingTasksProjectIds={loadingTasksProjectIds}
+       onTasksExpansionChange={onTasksExpansionChange}
+       onSelectIssue={onSelectIssue}
+       activeIssueId={activeIssueId}
        ariaLabelledBy={titleId}
```

No layout/markup change — Tasks lives **inside** the tree, not as a new
sidebar block.

---

## 4. Renderers — `outliner/*Node.tsx`

All three reuse `TreeCaretRow` (caret + `aria-expanded` + `role="treeitem"`)
for visual consistency with Workspaces sections and buckets.

### 4.1 `outliner/TasksSectionNode.tsx`

```tsx
import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { TreeCaretRow } from './TreeCaretRow';
import type { TasksSectionNode, TreeNodeRenderProps } from './types';

/**
 * Tasks section header (ADR-011). Same caret row as the Workspaces section,
 * plus a spinner while the first-open load is in flight and a count of visible
 * statuses. Empty hint renders as a child row when there are zero statuses
 * (handled by buildTreeData producing zero StatusNodes — the row count itself
 * is the affordance).
 */
export function TasksSectionNode({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<TasksSectionNode>) {
  const { t } = useTranslation('common');
  const section = node.data;
  return (
    <TreeCaretRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      className="text-sm font-medium text-low"
    >
      <span className="truncate">{section.label}</span>
      {section.isLoading ? (
        <SpinnerIcon
          aria-label={t('sidebar.tasksLoading')}
          className="ml-auto size-3 shrink-0 animate-spin text-low"
        />
      ) : (
        <span className="ml-auto text-2xs font-normal text-low opacity-70">
          {section.children.length}
        </span>
      )}
    </TreeCaretRow>
  );
}
```

### 4.2 `outliner/StatusNode.tsx`

```tsx
import { TreeCaretRow } from './TreeCaretRow';
import type { StatusNode, TreeNodeRenderProps } from './types';

/** Status column header: color dot + name + card count. */
export function StatusNodeRow({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<StatusNode>) {
  const status = node.data;
  return (
    <TreeCaretRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      className="text-xs font-medium uppercase tracking-wide text-low"
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{
          backgroundColor: `hsl(${status.color})`,
        }}
      />
      <span className="truncate">{status.name}</span>
      <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
        {status.children.length}
      </span>
    </TreeCaretRow>
  );
}
```

### 4.3 `outliner/CardNode.tsx`

```tsx
import { cn } from '../../lib/cn';
import { TREE_LAYOUT } from './layout';
import type {
  CardNode,
  TreeNodeRenderProps,
} from './types';
import type { IssuePriority } from 'shared/remote-types';

/** Priority → Tailwind text-color token. null/undefined → no dot. */
const PRIORITY_DOT_CLASS: Record<Exclude<IssuePriority, null>, string> = {
  urgent: 'bg-error',
  high: 'bg-warning',
  medium: 'bg-brand',
  low: 'bg-tertiary',
};

interface CardNodeRowProps extends TreeNodeRenderProps<CardNode> {
  activeIssueId?: string | null;
}

/**
 * Issue card row. Recursive via react-arborist: a card with sub-issues shows a
 * caret (toggle, stopPropagation) at the left; a leaf card (no children) is a
 * plain navigable row. Visual language matches the workspace leaf (dotted
 * guide, active bolding, `aria-current="page"`), content = issue simpleId
 * (mono) + title + priority dot. Click → node.activate() →
 * SidebarProjectTree.handleActivate → onSelectIssue(projectId, issueId).
 */
export function CardNodeRow({
  node,
  style,
  dragHandle,
  activeIssueId,
}: CardNodeRowProps) {
  const issue = node.data.issue;
  const isActive = issue.id === activeIssueId;
  const hasChildren = node.data.children.length > 0;

  // Dotted-guide geometry (same math as LeafNode.tsx).
  const indent = node.tree.indent;
  const caretHalf = TREE_LAYOUT.caretHalf;
  const paddingLeft = (style.paddingLeft as number | undefined) ?? 0;
  const guideX = paddingLeft - indent + caretHalf;
  const tickWidth = Math.max(0, indent - caretHalf);

  const dotClass =
    issue.priority != null ? PRIORITY_DOT_CLASS[issue.priority] : null;

  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-selected={isActive}
      aria-current={isActive ? 'page' : undefined}
      aria-expanded={hasChildren ? node.isOpen : undefined}
      onClick={() => node.activate()}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-1.5 text-left',
        'text-sm leading-tight focus:outline-none',
        isActive
          ? 'text-high font-semibold'
          : 'text-normal font-light hover:text-high',
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0 h-full w-px border-l-2 border-dotted border-border-strong/80"
        style={{ left: guideX }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-px border-t-2 border-dotted border-border-strong/80"
        style={{ left: guideX, width: tickWidth }}
      />
      {hasChildren ? (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            node.toggle();
          }}
          className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-low hover:bg-tertiary"
        >
          <CaretRightIcon
            className={cn(
              'size-3 transition-transform duration-150',
              node.isOpen && 'rotate-90',
            )}
            weight="bold"
          />
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden="true" />
      )}
      <div
        className="flex min-w-0 items-center gap-1.5"
        style={{ paddingLeft: TREE_LAYOUT.leafContentOffset }}
      >
        {dotClass && (
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dotClass)} />
        )}
        <span className="shrink-0 font-mono text-2xs text-low">
          {issue.simpleId}
        </span>
        <span className="truncate">{issue.title}</span>
      </div>
    </div>
  );
}
```

### 4.4 `outliner/treeNodes.tsx` routing

Split the `case 'section'` by `kind`; add `status` + `card`:

```diff
+import { CardNodeRow } from './CardNode';
+import { StatusNodeRow } from './StatusNode';
+import { TasksSectionNode } from './TasksSectionNode';
 import type {
   BucketNode,
+  CardNode,
   LeafNode,
   ProjectNode,
   SectionNode,
+  StatusNode,
   SidebarTreeNode,
   TreeNodeRenderProps,
 } from './types';
```

```diff
 export function TreeNodeRouter(
   props: NodeRendererProps<SidebarTreeNode> & {
     onSelectProject: (id: string) => void;
     activeProjectId: string | null;
     activeWorkspaceId: string | null;
+    onSelectIssue?: (projectId: string, issueId: string) => void;
+    activeIssueId?: string | null;
   },
 ) {
-  const { node, style, dragHandle, onSelectProject, activeProjectId, activeWorkspaceId } = props;
+  const {
+    node,
+    style,
+    dragHandle,
+    onSelectProject,
+    activeProjectId,
+    activeWorkspaceId,
+    onSelectIssue,
+    activeIssueId,
+  } = props;
   switch (node.data.type) {
     case 'project':
       return ( /* unchanged */ );
     case 'section':
-      return (
-        <SectionTreeNode
-          node={node as NodeApi<SectionNode>}
-          style={style}
-          dragHandle={dragHandle}
-        />
-      );
+      return node.data.kind === 'tasks' ? (
+        <TasksSectionNode
+          node={node as NodeApi<Extract<SectionNode, { kind: 'tasks' }>>}
+          style={style}
+          dragHandle={dragHandle}
+        />
+      ) : (
+        <SectionTreeNode
+          node={node as NodeApi<Extract<SectionNode, { kind: 'workspaces' }>>}
+          style={style}
+          dragHandle={dragHandle}
+        />
+      );
     case 'bucket':
       return ( /* unchanged */ );
     case 'leaf':
       return ( /* unchanged */ );
+    case 'status':
+      return (
+        <StatusNodeRow
+          node={node as NodeApi<StatusNode>}
+          style={style}
+          dragHandle={dragHandle}
+        />
+      );
+    case 'card':
+      return (
+        <CardNodeRow
+          node={node as NodeApi<CardNode>}
+          style={style}
+          dragHandle={dragHandle}
+          activeIssueId={activeIssueId}
+        />
+      );
   }
 }
```

> `onSelectIssue` is read inside `SidebarProjectTree.handleActivate`, not in the
> router, so the router prop is only used to satisfy the union; `CardNodeRow`
> calls `node.activate()` which triggers `handleActivate`.

### 4.5 `outliner/layout.ts`

```diff
 export const TREE_LAYOUT = {
   indent: 12,
   caretHalf: 5,
   leafContentOffset: 10,
-  rowHeight: { leaf: 40, project: 32, default: 24 } as const,
+  rowHeight: { leaf: 40, project: 32, card: 28, default: 24 } as const,
   overscanCount: 5,
   padding: 2,
 } as const;
```

(Status uses `default: 24` — same as Workspaces section/bucket headers — so no
new entry needed. Card gets its own slightly-taller-than-default 28 to fit the
mono simpleId + title comfortably at 256px.)

---

## 5. TDD sequence (red first, then implement)

Strict order. **All tests in §5.1–§5.2 are pure (no React, no network) and MUST
fail before implementation begins.** Render tests (§5.3) fail until the
components exist. Integration (§5.4) last.

Runner: `vitest` (already used by `packages/ui` and `packages/web-core`, per
AGENTS.md). Co-located files: `*.test.ts(x)` next to the module.

### 5.1 `outliner/buildTreeData.test.ts` — pure logic (13 tests, write FIRST)

Stub translator: `const t = (k: string) => k;`. Minimal fixtures: 1 project,
hand-built `ProjectStatus[]` / `Issue[]`.

1. **tasks above workspaces** — for one project with statuses+issues, assert
   `tree[0].children[0].kind === 'tasks'` and `tree[0].children[1].kind ===
   'workspaces'`.
2. **tasks section always present (empty project)** — project with no
   `tasksByProject` entry still has a Tasks section: `children[0].kind ===
   'tasks'` and `children[0].children.length === 0`.
3. **tasks section has correct id + label** — `id === '${pid}:tasks'`,
   `label === 'sidebar.tasksSection'`, `projectId === pid`.
4. **statuses sorted by sort_order asc** — given statuses with sort_order
   `[3,1,2]`, child order is `[1,2,3]`.
5. **hidden statuses dropped** — a status with `hidden: true` is absent from
   the section's children even if issues reference it.
6. **issues grouped by status_id** — issue with `status_id: 'S1'` lands only
   under the `S1` StatusNode; assert each status's `children` match the
   partition.
7. **issues sorted by sort_order asc within status** — issues `[5,1,3]` for
   the same status render in order `[1,3,5]`.
8. **orphan issue dropped** — issue whose `status_id` is not in the visible
   status set (or only on a hidden status) does not appear anywhere in the
   tree.
 9. **sub-issues nest under their parent card** — issue with
    `parent_issue_id: <parentId>` where `<parentId>` is another issue in the
    same status renders as a `children` entry of that parent's `CardNode`
    (depth 2), and a grandchild nests under its parent's `children` (depth 3).
 9a. **sub-issues sorted by parent_issue_sort_order asc** — sub-issues
    `[3,1,2]` for the same parent render `[1,2,3]`.
 9b. **orphan parent promoted to top-level** — sub-issue whose parent is not in
    the same status's issue set renders as a top-level card (not dropped).
 9c. **sub-issue card carries parentIssueId** — `CardNode.issue.parentIssueId`
    is the parent's issue id (used by the renderer for depth/active logic).
 9d. **cards without sub-issues have empty children** — a leaf card's
    `children` is `[]` (renderer then hides the caret).
10. **unassigned has NO tasks section** — with `unassignedActive=[ws]`, the
    Unassigned project's `children` is exactly one Workspaces section
    (`length === 1`, `kind === 'workspaces'`).
11. **isLoading flag mirrored** — with `loadingTasksProjectIds = new Set([pid])`,
    the Tasks section node has `isLoading === true`; absent from the set →
    `false`/`undefined`.
 12. **card payload trimmed correctly** — a card's `issue` carries exactly
     `{ id, simpleId, title, priority, statusId, projectId, parentIssueId }`
     (no `description`,
    no `sort_order`).
13. **multiple projects independent** — two projects each with their own
    statuses+issues produce isolated trees; project A's statuses do not leak
    into project B's Tasks section.

### 5.2 `outliner/buildSidebarTreeInitialOpenState.test.ts` — pure logic (6 tests)

14. **tasks section closed by default** — for a tree with one real project,
    `out['${pid}:tasks'] === false`.
15. **status nodes NOT seeded** — assert the output map has **no** key matching
    `${pid}:status:*`. (They will default closed via `openByDefault={false}`.)
16. **buckets keep their defaults** — `out['${pid}:bucket:attention'] === true`,
    `…:archived === false`, etc. (regression guard for the refactor).
17. **persistence override wins** — pre-seed localStorage with
    `vibe.ui.sidebarTree.openState = { v:1, state: { '${pid}:tasks': true } }`,
    assert `out['${pid}:tasks'] === true`.
18. **unassigned has no tasks id** — for a tree containing the Unassigned
    pseudo-project, assert no key `${UNASSIGNED_PROJECT_ID}:tasks` exists in
    the output.
19. **legacy migration still works** — empty blob + legacy
    `vibe.ui.collapsible.workspaces-outliner-attention = 'false'` →
    `out['${pid}:bucket:attention'] === false`. (Regression guard.)

### 5.3 Renderer tests (9 tests) — fail until components exist

20. **`TasksSectionNode` shows spinner when `isLoading`**
    (`outliner/TasksSectionNode.test.tsx`) — render with a node whose
    `isLoading: true`; assert the `SpinnerIcon` (by aria-label) is present and
    the count span is absent. Reverse assertion for `isLoading: false`.
21. **`StatusNodeRow` shows color dot + count** (`outliner/StatusNode.test.tsx`)
    — assert a `.rounded-full` span whose inline `background-color` matches
    `hsl(${color})`, plus a count text node equal to `children.length`.
22. **`CardNodeRow` renders simpleId + title** (`outliner/CardNode.test.tsx`)
    — assert the mono `simpleId` text and the `title` appear in DOM order.
23. **`CardNodeRow` priority dot** — for each of `urgent|high|medium|low`,
    assert the dot span carries the matching `bg-*` class; for `priority:
    null`, assert no dot span renders.
24. **`CardNodeRow` active state** — `activeIssueId` matching the card's issue
    id → root div has `aria-current="page"` and the `font-semibold` class.
25. **`CardNodeRow` click fires activate** — spy on `node.activate`; click the
    row; assert spy called once.
25a. **`CardNodeRow` shows caret when it has sub-issues** — a card whose
    `children.length > 0` renders a caret button that toggles the node and
    does NOT fire `activate` (assert `node.toggle` called, `node.activate`
    NOT called); the row's `aria-expanded` mirrors `node.isOpen`.
25b. **`CardNodeRow` leaf card has no caret** — a card with `children: []`
    renders no caret button; clicking the row fires `activate` and the
    `aria-expanded` attribute is absent.
26. **router routes by kind + type** (`outliner/treeNodes.test.tsx`) — feed a
    Tasks `SectionNode` and assert `TasksSectionNode` renders; feed a
    `StatusNode`/`CardNode` and assert the right row component renders.

### 5.4 Integration test (3 tests) — last

27. **`SidebarProjectTree` renders Tasks section above Workspaces**
    (`SidebarProjectTree.test.tsx`) — mount with `tasksByProject` containing
    one project; query the tree DOM; assert the Tasks section label appears
    **before** the Workspaces section label inside that project.
28. **opening Tasks section fires `onTasksExpansionChange(projectId, true)`**
    — click the Tasks section caret; assert the callback fires with the right
    id and `true`; click again → `false`.
29. **card click fires `onSelectIssue(projectId, issueId)`** — click a card
    row; assert `onSelectIssue` called with `(projectId, issueId)` matching
    the card's `issue.projectId/id`.

**Red-then-green discipline:** commit §5.1+§5.2 tests first (repo goes red),
then implement `buildTreeData.ts` + the open-state refactor (§5.1+§5.2 go
green). Then §5.3 tests, then renderers. Then §5.4 tests, then `SidebarProjectTree`
wiring + SharedAppLayout wiring. Each layer's tests gate the next.

---

## 6. i18n (`packages/web-core/src/i18n/locales/en/common.json`)

Add three keys inside the existing `sidebar` object (after `workspacesSection`):

```json
  "sidebar": {
    "workspacesSection": "Workspaces",
    "tasksSection": "Tasks",
    "tasksLoading": "Loading tasks…",
    "tasksEmpty": "No statuses yet",
    "unassigned": "Unassigned",
```

`tasksEmpty` is reserved for the empty hint row (§7); wire it in the renderer
if a status-less Tasks section needs explicit copy (currently the row count
`0` already conveys emptiness — keep the key for a future one-line hint
without a second translation pass). English-only — this fork ships no other
locales (AGENTS.md, ADR-004).

`pnpm run lint:i18n` verifies the new keys have no orphan refs and no missing
refs after wiring (`tasksSection` is read by `buildTreeData`; `tasksLoading`
by `TasksSectionNode`).

---

## 7. Accessibility + edge cases

| Concern | Handling |
|---|---|
| Tree semantics (`role="tree"`, `treeitem`, `aria-expanded`) | Inherited from react-arborist + `TreeCaretRow` (already sets `role="treeitem"` + `aria-expanded`). |
| Active card | `aria-current="page"` + `aria-selected` on the active `CardNodeRow` (matches `LeafNode` precedent). |
| Tasks section loading affordance | `SpinnerIcon` with `aria-label={t('sidebar.tasksLoading')}` so AT announces "Loading tasks". |
| Empty project (zero statuses) | Tasks section still renders with count `0`; clicking it shows an empty (zero-status) list. No crash, no misleading "no workspaces". Optional future: render `tasksEmpty` hint row. |
| Orphan issues | Dropped silently in `buildTreeData` — an issue whose `status_id` was deleted (or only exists on a hidden status) does not clutter the tree. |
| Sub-issues | **Nested under their parent card** (owner requirement), up to 3 levels deep; cards default collapsed so the tree stays compact at 256px. |
| Many cards | Virtualized by react-arborist (already the case for workspaces); only visible rows render. |
| 256px width budget | Card row: priority dot (6px) + simpleId (mono 2xs) + title (truncate) — fits comfortably. Status/Tasks headers reuse the existing section/bucket typography. No new horizontal element. |
| Unassigned pseudo-project | No Tasks section (owner decision; verified in test #10). |
| Persistence across reloads | Tasks open/closed state persists in `vibe.ui.sidebarTree.openState` like every other node id (project-scoped key `${pid}:tasks`). No schema bump. |
| Closed-by-default discoverability | The Tasks **section header** (caret + "Tasks" label) is always visible above "Workspaces"; only its contents are collapsed. Not a hidden feature. |
| `openByDefault` flip regression | The new-project `useEffect` (§3.6 #7) re-opens brand-new projects + their Workspaces section, preserving ADR-007. The seed map at mount covers the initial set. The existing `treeSeedOnce.test.tsx` already asserts the seed-once contract under `openByDefault={false}`. |
| Mobile drawer | Both `<Sidebar>` instances receive the same Tasks props; the registry renders once and feeds both. No duplicate subscriptions. |

---

## 8. Verification checklist

Run from repo root after applying the changes.

**Type / lint / build:**

```bash
pnpm --filter @vibe/ui run lint
pnpm --filter @vibe/web-core run lint
pnpm run lint:i18n            # new keys present, no orphan refs
pnpm run check                # tsc + Rust workspace checks
pnpm --filter @vibe/ui run test
pnpm --filter @vibe/web-core run test
pnpm --filter @vibe/local-web run lint  2>/dev/null || true
pnpm run build
```

**Unit tests added (per §5):**

- `packages/ui/src/components/outliner/buildTreeData.test.ts` (13)
- `packages/ui/src/components/outliner/buildSidebarTreeInitialOpenState.test.ts` (6)
- `packages/ui/src/components/outliner/{TasksSectionNode,StatusNode,CardNode,treeNodes}.test.tsx` (7)
- `packages/ui/src/components/SidebarProjectTree.test.tsx` (3)
- (No new web-core unit test: `useProjectTasks` is a 2-line `useShape` wrapper;
  the registry's aggregation is exercised by the integration smoke + the
  existing SidebarProjectTree tests which consume its output shape. Add a
  registry test only if a regression is observed.)

**Runtime smoke (`pnpm run dev`):**

- [ ] Each real project shows **Tasks** (collapsed) **above** Workspaces.
- [ ] Unassigned project shows only Workspaces (no Tasks).
- [ ] Clicking the Tasks caret expands it; a spinner flashes briefly; statuses
      appear (collapsed), each with a color dot + card count.
- [ ] Statuses are ordered by `sort_order` asc; hidden statuses absent.
- [ ] Clicking a status reveals its cards, ordered by `sort_order` asc; simpleId
      mono + title + priority dot.
- [ ] Clicking a card navigates to `goToProjectIssue(projectId, issueId)` and
      the card becomes `aria-current="page"` on return.
- [ ] Refreshing the page preserves Tasks/section/card open state via
      `vibe.ui.sidebarTree.openState` (no schema bump).
- [ ] Creating a new project: it appears expanded with Workspaces open and
      Tasks collapsed (ADR-007 preserved).
- [ ] Closing the Tasks section disables further Electric traffic for that
      project (verify in DevTools Network — no new shape messages for the
      closed project).
- [ ] Both desktop sidebar and mobile drawer render Tasks identically.
- [ ] At 256px width, no horizontal overflow; long titles truncate.

**Documentation:**

- [ ] File `docs/ADR/ADR-011-sidebar-project-tasks-section.md` with
      `Status: Proposed` before code, `Accepted` after merge (see §9).
- [ ] Cross-reference this plan + ADR-007 (amendment note).

---

## 9. ADR-011 outline (content of the ADR to write)

File: `docs/ADR/ADR-011-sidebar-project-tasks-section.md`

```markdown
# ADR-011: Sidebar — per-project Tasks section

- **Status**: Proposed
- **Date**: 2026-08-03
- **Amends**: ADR-007 (adds a second per-project section above Workspaces).

## Context

ADR-007 placed a per-project Workspaces section in the global sidebar tree and
explicitly anticipated "future sections (TODOs, Notes)". The owner now wants
kanban tasks surfaced the same way: a **Tasks** section per project, above
Workspaces, showing status columns → issue cards, clickable into the project
issue view.

Three constraints shape the design:

1. **Layer rule** (`packages/ui` cannot import `web-core`): `useShape` lives in
   web-core, so the data hook and its loader components must too.
2. **Lazy loading**: a sidebar with N projects must not subscribe to N×(statuses
   + issues) shapes eagerly. Subscriptions must be gated on the user actually
   opening a project's Tasks section.
3. **react-arborist 3.16 open semantics** (verified in `node_modules`): `isOpen(id)`
   is computed live as `openMap[id] ?? openByDefault ?? true`, and `initialOpenState`
   is consumed **once at mount**. Lazy status nodes (ids unknown at mount) fall
   back to `openByDefault`, so the previous bare `openByDefault` (= true) would
   force every status OPEN on first load.

## Decision

- **Node model.** Add `TasksSectionNode` (`type: 'section'`, `kind: 'tasks'`),
  `StatusNode`, `CardNode` to `SidebarTreeNode`. Discriminate Workspaces vs
  Tasks sections by `kind` (not `type`).
- **Data hook in web-core.** `useProjectTasks(projectId, enabled)` wraps
  `PROJECT_PROJECT_STATUSES_SHAPE` + `PROJECT_ISSUES_SHAPE`. A
  `SidebarProjectTasksRegistry` renders one `ProjectTasksLoader` per project
  id (rules-of-hooks safe) and aggregates results into a `Map` consumed by the
  pure `SidebarProjectTree`.
- **Lazy trigger.** Load on Tasks-section **toggle** (not project expand).
  `SidebarProjectTree.handleToggle` fires `onTasksExpansionChange(projectId,
  isOpen)` when a Tasks section is toggled; `SharedAppLayout` flips the
  project's membership in `openTasksProjectIds`; the registry
  enables/disables that project's loader. Closed Tasks section ⇒ no Electric
  subscription.
- **Defaults.** Tasks section **closed** by default; status nodes **closed**
  by default. Discoverability is preserved because the Tasks **section header**
  (caret + label) is always visible above Workspaces.
- **`openByDefault={false}`.** Flip the bare `openByDefault` (was `true`) to
  `false` so lazy status nodes default closed without a first-render flash and
  without per-node imperative hacks. Preserve ADR-007's "newly-added projects
  auto-expand" with a small `useEffect` that opens a brand-new project + its
  Workspaces section via `treeApi.open(id)` (Tasks section left closed).
- **Pure tree builder.** Extract `buildTreeData` to
  `outliner/buildTreeData.ts`. Rules: Tasks above Workspaces; statuses sorted
  by `sort_order` asc, `hidden` dropped; issues grouped by `status_id`, sorted
  by `sort_order` asc; orphan issues dropped; **sub-issues nested under their
  parent card**; Unassigned has
  no Tasks section; empty project still shows a (zero-status) Tasks section.
- **No persistence schema bump.** The `vibe.ui.sidebarTree.openState` blob
  (v1) gains `${pid}:tasks` keys on demand; pre-existing keys stay valid.

## Consequences

- Positive: tasks visible alongside workspaces per project; lazy subscriptions
  keep the sidebar cheap; pure `buildTreeData` is unit-tested in isolation;
  `openByDefault={false}` makes the open-state contract explicit and matches
  the existing seed-once test.
- Negative: a brand-new project auto-opens via an effect (one extra moving
  part vs the previous implicit `openByDefault={true}`); users who relied on
  every node defaulting open now see Tasks + statuses collapsed (intentional —
  "kanban huge" mitigation).
- Ongoing: when Phase-2 workspaces `project_id` lands (ADR-007), the same
  registry pattern can feed a per-project Workspaces section from real data
  rather than derived membership.
```

---

## 10. Evidence — react-arborist open-state mechanics

All claims verified against
`node_modules/.pnpm/react-arborist@3.16.0_…/dist/module/`.

**`isOpen` is live, with `openByDefault` fallback** —
`interfaces/tree-api.js`:

```js
isOpen(id) {
  if (!id) return false;
  if (id === ROOT_ID) return true;
  const def = this.props.openByDefault ?? true;      // ← default TRUE
  if (this.isFiltered) {
    return this.state.nodes.open.filtered[id] ?? true;
  } else {
    return this.state.nodes.open.unfiltered[id] ?? def;  // ← fallback
  }
}
```

**`initialOpenState` is consumed once** — `state/initial.js`:

```js
export const initialState = (props) => ({
  nodes: {
    open: { filtered: {}, unfiltered: props?.initialOpenState ?? {} },
    …
  },
  …
});
```

…and `state/provider.js` builds the store via `useRef(createStore(...))`, so a
re-render with a new `initialOpenState` prop does **not** re-seed.

**Imperative API exists** — `interfaces/tree-api.js`:

```js
open(identity, redraw = true)  { … this.actions.open(id, …) … }   // L606
close(identity, redraw = true) { … }                               // L618
toggle(identity)                { … }                               // L630
```

→ the §3.6 #7 `useEffect` can call `api.open(projectId)` / `api.open(wsId)`.

**Existing contract test already uses `openByDefault={false}`** —
`packages/ui/src/components/outliner/treeSeedOnce.test.tsx` (L24–57): seeds
`{ a: false, b: false }`, toggles, re-renders with a different prop, asserts
the new prop is ignored. The flip to `openByDefault={false}` is therefore
consistent with the contract this repo already encodes.

**Layer rule evidence** — `useShape` is imported from
`@/shared/integrations/electric/hooks` (web-core) in every existing caller
(`ProjectProvider.tsx`, `NavbarContainer.tsx`, `SharedAppLayout.tsx`, etc.).
`packages/ui` has no such import; placing the hook there would be the first
and would break the rule documented in AGENTS.md.

**`goToProjectIssue` exists** —
`packages/web-core/src/shared/lib/routes/appNavigation.ts` L55:
`goToProjectIssue(projectId: string, issueId: string, transition?)`.

**Issue / ProjectStatus fields** — `shared/remote-types.ts` L19/L23 (quoted in §1).

---

## Summary

- Architecture: per-project Tasks section above Workspaces; lazy `useShape` in
  web-core via a registry of per-project loaders; pure `buildTreeData` extracted
  for TDD; Tasks section + statuses default closed.
- Crux resolved: flip `openByDefault` to `false` (verified against
  react-arborist source) so lazy status nodes default closed with no flash; a
  small effect preserves ADR-007's new-project auto-expand.
- TDD: 29 tests, ordered red-first (pure builder + open-state → renderers →
  integration), each layer gating the next.
- ADR-011 outline included; no persistence schema bump; ui→web-core layer rule
  respected; no Rust changes.

## Open product questions for the owner

1. **Empty Tasks section copy.** Today a zero-status Tasks section shows a bare
   `0` count. Wire `sidebar.tasksEmpty` ("No statuses yet") as a child hint
   row, or leave the `0` count as the affordance? (Plan keeps the key ready
   but does not render the row.)
2. **Priority-dot color mapping.** Plan maps `high → bg-warning`,
   `medium → bg-brand`. Confirm these tokens match the kanban board's existing
   priority colors (would let us extract one shared `priorityDotClass` map used
   by both the sidebar card and the kanban card — pure DRY win, deferred until
   the kanban colors are verified).
3. **Active-card auto-reveal.** When the user navigates to a project issue via
   command bar/URL, should the sidebar auto-open that project's Tasks section +
   the relevant status + scroll the card into view? Plan does NOT do this
   (keeps the tree non-imperative on navigation); flagged as a possible
   follow-up for parity with the workspaces tree.
