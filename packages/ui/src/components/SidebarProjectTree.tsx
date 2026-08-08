import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Tree, type NodeApi, type TreeApi } from 'react-arborist';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import {
  makeTasksSectionId,
  makeWorkspacesSectionId,
  type OutlinerWorkspace,
  type ProjectNode,
  type SidebarProject,
  type SidebarTreeNode,
  type WorkspaceProjectMembership,
} from './outliner/types';
import {
  buildSidebarTreeInitialOpenState,
  findTreeNodeById,
  isTasksSectionOpen,
  liveTreeNodeIds,
  pendingOpenStatusCardIds,
  projectIdFromOpenStateKey,
  readSidebarTreeOpenState,
  writeSidebarTreeOpenState,
} from './outliner/openState';
import { buildTreeData } from './outliner/buildTreeData';
import type { ProjectTasksData } from './outliner/types';
import { TREE_LAYOUT } from './outliner/layout';
import { TreeNodeRouter } from './outliner/treeNodes';
import { useContainerHeight } from './outliner/useContainerHeight';

interface SidebarProjectTreeProps {
  projects: readonly SidebarProject[];
  activeProjectId: string | null;
  workspaces: OutlinerWorkspace[];
  archivedWorkspaces?: OutlinerWorkspace[];
  membership: WorkspaceProjectMembership;
  activeWorkspaceId: string | null;
  tasksByProject?: ReadonlyMap<string, ProjectTasksData>;
  loadingTasksProjectIds?: ReadonlySet<string>;
  activeIssueId?: string | null;
  onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
  onSelectIssue?: (
    projectId: string,
    issueId: string,
    parentIssueId?: string | null
  ) => void;
  isLoading?: boolean;
  onSelectWorkspace: (id: string) => void;
  /** Collapse-by-default (2026-08-07): opens the project's kanban board when
   *  the user clicks the open-page icon on a project row or Tasks section.
   *  Row clicks themselves toggle expand/collapse. */
  onOpenProjectPage?: (projectId: string) => void;
  /** Opens the flat workspaces dashboard when the user clicks the open-page
   *  icon on a Workspaces section row. */
  onOpenWorkspacesPage?: (projectId: string) => void;
  /** ADR-015: opens `CreateRemoteProjectDialog` with `parentId` set so the
   *  new project is created as a child board of the supplied project id. */
  onCreateChildBoard?: (parentId: string) => void;
  /** ADR-016: opens the orchestrator-prompt editor for the supplied
   *  project id. The `+` menu's "Orchestrator prompt" item and the
   *  prompt row's click both route through this. */
  onSelectOrchestratorPrompt?: (projectId: string) => void;
  /** ADR-016: project id whose prompt editor is currently open. Drives
   *  the rendered row's `aria-current` and the active styling. */
  activeProjectPromptId?: string | null;
  /** When >1 issues are selected, disable card drag-and-drop (PLAN §7.5). */
  isMultiSelectActive?: boolean;
  /** Id of the external <h2> that labels this section. Replaces the old aria-label. */
  ariaLabelledBy?: string;
  width?: number;
  className?: string;
}

const EMPTY_TASKS_BY_PROJECT: ReadonlyMap<string, ProjectTasksData> = new Map();
const EMPTY_LOADING_TASKS_PROJECT_IDS: ReadonlySet<string> = new Set();

export function SidebarProjectTree({
  projects,
  activeProjectId,
  workspaces,
  archivedWorkspaces = [],
  membership,
  activeWorkspaceId,
  tasksByProject = EMPTY_TASKS_BY_PROJECT,
  loadingTasksProjectIds = EMPTY_LOADING_TASKS_PROJECT_IDS,
  activeIssueId = null,
  onTasksExpansionChange,
  onSelectIssue,
  isLoading = false,
  onSelectWorkspace,
  onOpenProjectPage,
  onOpenWorkspacesPage,
  onCreateChildBoard,
  onSelectOrchestratorPrompt,
  activeProjectPromptId = null,
  isMultiSelectActive = false,
  ariaLabelledBy,
  width = 256,
  className,
}: SidebarProjectTreeProps) {
  const { t } = useTranslation('common');

  // Partition workspaces into per-project buckets + an "unassigned" bucket.
  // A workspace renders under EVERY project it's linked to (M:N); one with
  // no membership goes under the Unassigned pseudo-project.
  const {
    workspacesByProject,
    archivedWorkspacesByProject,
    unassignedActive,
    unassignedArchived,
  } = useMemo(() => {
    const activeByProject = new Map<string, OutlinerWorkspace[]>();
    const archivedByProject = new Map<string, OutlinerWorkspace[]>();
    const unassignedActive: OutlinerWorkspace[] = [];
    const unassignedArchived: OutlinerWorkspace[] = [];

    const push = (
      map: Map<string, OutlinerWorkspace[]>,
      key: string,
      ws: OutlinerWorkspace
    ) => {
      const arr = map.get(key);
      if (arr) {
        arr.push(ws);
      } else {
        map.set(key, [ws]);
      }
    };

    for (const ws of workspaces) {
      const projectsForWs = membership.get(ws.id);
      if (!projectsForWs || projectsForWs.size === 0) {
        unassignedActive.push(ws);
        continue;
      }
      for (const projectId of projectsForWs) {
        push(activeByProject, projectId, ws);
      }
    }
    for (const ws of archivedWorkspaces) {
      const projectsForWs = membership.get(ws.id);
      if (!projectsForWs || projectsForWs.size === 0) {
        unassignedArchived.push(ws);
        continue;
      }
      for (const projectId of projectsForWs) {
        push(archivedByProject, projectId, ws);
      }
    }

    return {
      workspacesByProject: activeByProject,
      archivedWorkspacesByProject: archivedByProject,
      unassignedActive,
      unassignedArchived,
    };
  }, [workspaces, archivedWorkspaces, membership]);

  const treeData = useMemo(
    () =>
      buildTreeData({
        projects,
        workspacesByProject,
        archivedWorkspacesByProject,
        unassignedActive,
        unassignedArchived,
        tasksByProject,
        loadingTasksProjectIds,
        t,
      }),
    [
      projects,
      workspacesByProject,
      archivedWorkspacesByProject,
      unassignedActive,
      unassignedArchived,
      tasksByProject,
      loadingTasksProjectIds,
      t,
    ]
  );

  const liveProjectIds = useMemo(
    () =>
      new Set(
        treeData
          .filter((n): n is ProjectNode => n.type === 'project')
          .map((n) => n.id)
      ),
    [treeData]
  );

  // Stable key of the live project set. initialOpenState and the new-project
  // auto-open effect depend on THIS (not the whole treeData), so Electric
  // updates to task data don't re-read localStorage or re-iterate projects.
  const projectKey = useMemo(
    () =>
      treeData
        .filter((node): node is ProjectNode => node.type === 'project')
        .map((node) => node.id)
        .join(','),
    [treeData]
  );

  // ADR-015: every node id reachable in the BUILT tree. Used by the prune
  // effect to drop persisted keys whose full node id is no longer present
  // (e.g. a nested-board `<childId>:workspaces` key from before the
  // root-only-Workspaces change). Recomputed on every treeData change —
  // short-circuit the work when the tree shape didn't change.
  const liveTreeNodeIdsSet = useMemo(
    () => liveTreeNodeIds(treeData),
    [treeData]
  );

  // Seed the open-state map from persistence + defaults. Recomputed only when
  // the project set changes; react-arborist consumes it exactly once at Tree
  // mount (provider.js: createStore inside useRef). Status/card ids are NOT
  // seeded — they load lazily after mount and default closed via
  // openByDefault={false}.
  const initialOpenState = useMemo(
    () => buildSidebarTreeInitialOpenState(treeData),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per project-set change; treeData grows (lazily-loaded statuses/cards) but the seed never should.
    [projectKey]
  );

  // In-memory mirror of persisted open state. Kept in a ref so toggles don't
  // trigger re-renders — the Tree re-renders itself via its store
  // subscription; we only persist on the side.
  const openStateRef = useRef<Record<string, boolean>>(
    readSidebarTreeOpenState(liveProjectIds)
  );
  // Snapshot of the PERSISTED open state used as the replay source for
  // lazily-loaded status/card ids (their ids are unknown when initialOpenState
  // was seeded). Frozen at mount, but refreshed when a new project appears
  // mid-session (auto-open effect) so its stored-open values replay too.
  const persistedOpenRef = useRef<Record<string, boolean>>(
    openStateRef.current
  );
  const appliedOpenRef = useRef<Set<string>>(new Set());
  const writeScheduled = useRef(false);

  // Coalesce a burst of synchronous toggles into one localStorage write.
  // Microtask may fire after unmount; intentional to persist last-known state.
  const scheduleOpenStateWrite = useCallback(() => {
    if (writeScheduled.current) return;
    writeScheduled.current = true;
    queueMicrotask(() => {
      writeScheduled.current = false;
      writeSidebarTreeOpenState(openStateRef.current);
    });
  }, []);

  const treeRef = useRef<TreeApi<SidebarTreeNode> | null>(null);
  const seenProjectIdsRef = useRef<Set<string> | null>(null);
  const { containerRef, width: containerWidth, height } = useContainerHeight();
  // Latches true the first time the tree mounts (height > 0). The auto-open
  // and replay effects depend on `height` purely as a "tree is mounted"
  // signal — use this ref so resize-driven `height` churn doesn't re-run
  // them on every window resize.
  const treeReadyRef = useRef(false);
  // Effect, not inline render: refs written during render fire on every
  // commit, can race with the StrictMode double-invoke, and silently
  // strand effects that read the ref. Latch here in an effect so the
  // auto-open / replay effects can observe a stable value once the
  // mount-time layout has settled.
  useEffect(() => {
    if (height > 0 && !treeReadyRef.current) {
      treeReadyRef.current = true;
    }
  }, [height]);

  // Late-arrival open-state restore (collapse-by-default, 2026-08-07).
  // initialOpenState is consumed by react-arborist exactly once at Tree
  // mount; when projects arrive asynchronously AFTER mount, their persisted
  // open state was never seeded. This effect restores persisted-OPEN nodes
  // for late arrivals WITHOUT forcing anything open — a brand-new project
  // (no persisted state) stays collapsed per the default. The persisted
  // state is read FRESH from storage here (not the mount-time openStateRef,
  // which may be empty when projects land after mount).
  useEffect(() => {
    if (!treeReadyRef.current) return;
    const api = treeRef.current;
    if (!api) return;

    const currentProjectIds = new Set(projectKey ? projectKey.split(',') : []);
    if (seenProjectIdsRef.current === null) {
      seenProjectIdsRef.current = currentProjectIds;
      return;
    }

    // Read FRESH persisted state for the current project set.
    const stored = readSidebarTreeOpenState(currentProjectIds);
    let addedProject = false;
    for (const projectId of currentProjectIds) {
      if (seenProjectIdsRef.current.has(projectId)) continue;
      seenProjectIdsRef.current.add(projectId);
      // Restore ONLY persisted-OPEN nodes; absence of a persisted value
      // means default CLOSED (the user never expanded it).
      if (stored[projectId] === true) {
        api.open(projectId);
      }
      const wsNodeId = makeWorkspacesSectionId(projectId);
      if (liveTreeNodeIdsSet.has(wsNodeId) && stored[wsNodeId] === true) {
        api.open(wsNodeId);
      }
      const tasksId = makeTasksSectionId(projectId);
      if (isTasksSectionOpen(stored, projectId)) {
        api.open(tasksId);
      }
      addedProject = true;
    }

    if (addedProject) {
      // Keep the in-memory mirror + replay source in sync with what we just
      // applied so subsequent toggles/prunes see the restored values.
      openStateRef.current = { ...openStateRef.current, ...stored };
      persistedOpenRef.current = {
        ...persistedOpenRef.current,
        ...stored,
      };
    }
  }, [projectKey, liveTreeNodeIdsSet]);

  // Replay persisted status/card open state onto lazily-loaded nodes. Statuses
  // only mount after the Tasks section opens (lazy gate), so their ids are not
  // in initialOpenState; each time tree data changes we open any stored-open
  // status/card that just appeared. Presence is resolved against the built
  // treeData (NOT api.get, which only sees visible nodes) so a card under a
  // still-collapsed status is still found and opened. `appliedOpenRef` guards
  // against reopening a node the user collapsed after it was first restored.
  useEffect(() => {
    if (!treeReadyRef.current) return;
    const api = treeRef.current;
    if (!api) return;
    const ids = pendingOpenStatusCardIds(
      persistedOpenRef.current,
      appliedOpenRef.current,
      (id) => findTreeNodeById(treeData, id)
    );
    for (const id of ids) {
      api.open(id);
      appliedOpenRef.current.add(id);
    }
  }, [treeData]);

  // Prune persisted entries for projects that no longer exist (deleted /
  // no longer visible). The read-time GC only filters on next load; without
  // this, deleted projects' `:tasks`/`:status:`/`:card:`/`:bucket:` keys
  // accumulate in localStorage forever.
  //
  // Guard: projects load asynchronously, so on first mount projectKey is ''.
  // Pruning then would drop EVERY persisted key (including a user's closed
  // Tasks section) before any project arrives. Only prune once we have seen
  // at least one project — after that, an empty projectKey means the user
  // genuinely removed them and pruning is legitimate.
  //
  // ADR-015: a second pass drops keys whose FULL node id is not in the live
  // tree, scoped to workspace structural keys (`<id>:workspaces`,
  // `<id>:bucket:*`). The project-prefix prune above catches the
  // deleted-project case cheaply; this catches the case where a nested board's
  // Workspaces section no longer renders — a key like `<childId>:workspaces`
  // survives the prefix prune because its project prefix is still live, even
  // though the section node itself is gone. Status/card keys are exempt (their
  // nodes only appear once Tasks data loads; see the loop body).
  const seenAnyProjectRef = useRef(false);
  useEffect(() => {
    if (projectKey) seenAnyProjectRef.current = true;
    if (!seenAnyProjectRef.current) return;
    const live = new Set(projectKey ? projectKey.split(',') : []);
    const entries = Object.entries(openStateRef.current);
    let changed = false;
    const pruned: Record<string, boolean> = {};
    for (const [key, open] of entries) {
      const projectId = projectIdFromOpenStateKey(key);
      if (!live.has(projectId)) {
        changed = true;
        continue;
      }
      // The project is still live; but the specific node id might not be (a
      // nested board's Workspaces section no longer renders post-ADR-015).
      // Drop those keys here so they don't accumulate.
      //
      // Scope the full-id check to workspace structural keys only
      // (`<id>:workspaces`, `<id>:bucket:*`). Status/card keys are excluded
      // because their nodes only appear in treeData when the project's Tasks
      // section is OPEN (lazy loader gate) — a status the user expanded in a
      // prior session would otherwise be pruned before its Tasks data loads.
      const isWorkspaceStructuralKey =
        key.endsWith(':workspaces') || key.includes(':bucket:');
      if (isWorkspaceStructuralKey && !liveTreeNodeIdsSet.has(key)) {
        changed = true;
        continue;
      }
      pruned[key] = open;
    }
    if (!changed) return;
    openStateRef.current = pruned;
    scheduleOpenStateWrite();
  }, [projectKey, liveTreeNodeIdsSet, scheduleOpenStateWrite]);

  const handleActivate = useCallback(
    (node: NodeApi<SidebarTreeNode>) => {
      const data = node.data;
      if (data.type === 'leaf') {
        onSelectWorkspace(data.workspace.id);
      } else if (data.type === 'card') {
        // A PARENT card (has subissues) toggles open on activation so the
        // user can reveal its children by clicking the row — consistent with
        // project/Tasks/status rows. A LEAF card (no subissues) opens the
        // task page. The dedicated ↗ icon on parent cards (see CardNodeRow)
        // always opens the task page regardless, with stopPropagation so it
        // never hits this toggle path.
        if (data.children.length > 0) {
          node.toggle();
        } else {
          onSelectIssue?.(
            data.issue.projectId,
            data.issue.id,
            data.issue.parentIssueId
          );
        }
      } else if (
        data.type === 'project' ||
        (data.type === 'section' && data.kind === 'tasks') ||
        data.type === 'status'
      ) {
        // Collapse-by-default (2026-08-07): row activation (click AND
        // keyboard Enter/Space) TOGGLES expand/collapse for projects, Tasks
        // sections, and status columns. Navigation to the kanban board /
        // workspaces dashboard is handled by the dedicated open-page icons
        // on those rows (see treeNodes.tsx), which stop propagation so this
        // activate path never fires for an icon click. Card / leaf /
        // orchestrator-prompt rows keep navigating on activation.
        node.toggle();
      } else if (data.type === 'orchestrator-prompt') {
        // ADR-016: react-arborist's `onActivate` fires for BOTH
        // pointer activation (row click) and keyboard activation
        // (Enter / Space on the focused row). We intentionally rely on
        // this single path — adding a separate `onRowClick` on the
        // orchestrator-prompt row would double-fire for pointer
        // events. The renderer (`OrchestratorPromptTreeNode`) does not
        // wire `onRowClick` for this reason.
        onSelectOrchestratorPrompt?.(data.projectId);
      }
    },
    [onSelectWorkspace, onSelectIssue, onSelectOrchestratorPrompt]
  );

  const handleToggle = useCallback(
    (id: string) => {
      // onToggle fires for every node. Persist open state for every togglable
      // type — project/section/bucket ids are seeded into initialOpenState;
      // status/card ids load lazily after mount and are restored by the
      // replay effect above (persisting them is only a lie when nothing ever
      // restores them). The Tasks section is a `section` node, so its
      // expansion also drives the lazy loader gate.
      const node = treeRef.current?.get(id);
      if (!node) return;
      const type = node.data.type;
      if (type !== 'leaf') {
        openStateRef.current = { ...openStateRef.current, [id]: node.isOpen };
        scheduleOpenStateWrite();
      }
      if (type === 'section' && node.data.kind === 'tasks') {
        onTasksExpansionChange?.(node.data.projectId, node.isOpen);
      }
    },
    [scheduleOpenStateWrite, onTasksExpansionChange]
  );

  const hasAnyContent =
    projects.length > 0 ||
    workspaces.length > 0 ||
    archivedWorkspaces.length > 0;

  return (
    <section
      aria-labelledby={ariaLabelledBy}
      className={cn('flex min-h-0 flex-1 flex-col', className)}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-2">
          <SpinnerIcon className="size-icon-sm animate-spin text-muted" />
        </div>
      ) : !hasAnyContent ? (
        <span className="pl-base text-sm text-low opacity-60">
          {t('workspaces.noWorkspaces')}
        </span>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1">
          {height > 0 && (
            <Tree<SidebarTreeNode>
              ref={treeRef}
              data={treeData}
              openByDefault={false}
              initialOpenState={initialOpenState}
              width={containerWidth || width}
              height={height}
              indent={TREE_LAYOUT.indent}
              // react-arborist applies `rowClassName` to the DefaultRow
              // (the `[role=treeitem]` element it focuses on first click).
              // Kill the focus ring there — the global `*:focus { ring-inset }`
              // otherwise draws an outline around the just-clicked row on
              // first activation after mount.
              rowClassName="outline-none focus:outline-none focus:ring-0"
              rowHeight={(node) => {
                if (node.data.type === 'leaf')
                  return TREE_LAYOUT.rowHeight.leaf;
                if (node.data.type === 'card')
                  return TREE_LAYOUT.rowHeight.card;
                if (node.data.type === 'project')
                  return TREE_LAYOUT.rowHeight.project;
                // ADR-016: orchestrator-prompt + section nodes both fall
                // through to the default row height — no dedicated slot
                // needed. Collapsing the two paths keeps the call site
                // honest.
                return TREE_LAYOUT.rowHeight.default;
              }}
              overscanCount={TREE_LAYOUT.overscanCount}
              padding={TREE_LAYOUT.padding}
              disableEdit
              disableMultiSelection
              disableDrop
              disableDrag
              onActivate={handleActivate}
              onToggle={handleToggle}
              aria-labelledby={ariaLabelledBy}
            >
              {(props) => (
                <TreeNodeRouter
                  {...props}
                  onCreateChildBoard={onCreateChildBoard}
                  onSelectOrchestratorPrompt={onSelectOrchestratorPrompt}
                  onOpenProjectPage={onOpenProjectPage}
                  onOpenWorkspacesPage={onOpenWorkspacesPage}
                  activeProjectId={activeProjectId}
                  activeProjectPromptId={activeProjectPromptId}
                  activeWorkspaceId={activeWorkspaceId}
                  activeIssueId={activeIssueId}
                  onSelectIssue={onSelectIssue}
                  isMultiSelectActive={isMultiSelectActive}
                />
              )}
            </Tree>
          )}
        </div>
      )}
    </section>
  );
}
