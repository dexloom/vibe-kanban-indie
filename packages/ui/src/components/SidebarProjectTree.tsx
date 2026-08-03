import { useCallback, useMemo, useRef } from 'react';
import { Tree, type NodeApi, type TreeApi } from 'react-arborist';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { categorizeWorkspacesForOutliner } from '../lib/workspaceStatus';
import {
  BUCKET_ORDER,
  UNASSIGNED_PROJECT_ID,
  buildSidebarTreeInitialOpenState,
  readSidebarTreeOpenState,
  writeSidebarTreeOpenState,
  type BucketNode,
  type LeafNode,
  type OutlinerWorkspace,
  type ProjectNode,
  type SidebarProject,
  type SidebarTreeNode,
  type WorkspacesSectionId,
  type WorkspaceProjectMembership,
} from './outliner/types';
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
  isLoading?: boolean;
  onSelectWorkspace: (id: string) => void;
  onSelectProject: (id: string) => void;
  onProjectsReorder: (reorderedProjectIds: string[]) => void;
  /** Id of the external <h2> that labels this section. Replaces the old aria-label. */
  ariaLabelledBy?: string;
  width?: number;
  className?: string;
}

const ROOT_PARENT_ID: string | null = null;

const makeWorkspacesSectionId = (projectId: string): WorkspacesSectionId =>
  `${projectId}:workspaces`;

interface BuildTreeDataOptions {
  projects: readonly SidebarProject[];
  workspacesByProject: Map<string, OutlinerWorkspace[]>;
  archivedWorkspacesByProject: Map<string, OutlinerWorkspace[]>;
  unassignedActive: OutlinerWorkspace[];
  unassignedArchived: OutlinerWorkspace[];
  t: (key: string) => string;
}

function buildTreeData({
  projects,
  workspacesByProject,
  archivedWorkspacesByProject,
  unassignedActive,
  unassignedArchived,
  t,
}: BuildTreeDataOptions): SidebarTreeNode[] {
  const makeBuckets = (
    projectId: string,
    active: readonly OutlinerWorkspace[],
    archived: readonly OutlinerWorkspace[],
  ): BucketNode[] => {
    const {
      attention,
      running,
      idle,
      archived: archivedBucket,
    } = categorizeWorkspacesForOutliner(active, archived);
    const labels = {
      attention: t('workspaces.outliner.active'),
      running: t('workspaces.running'),
      idle: t('workspaces.idle'),
      archived: t('workspaces.archived'),
    };
    return BUCKET_ORDER.map((bucketId) => ({
      id: `${projectId}:bucket:${bucketId}`,
      type: 'bucket' as const,
      bucketId,
      name: labels[bucketId],
      children: (bucketId === 'attention'
        ? attention
        : bucketId === 'running'
          ? running
          : bucketId === 'idle'
            ? idle
            : archivedBucket
      ).map((workspace): LeafNode => ({
        id: workspace.id,
        type: 'leaf',
        workspace,
      })),
    }));
  };

  const projectNodes: ProjectNode[] = projects.map((project) => ({
    id: project.id,
    type: 'project',
    name: project.name,
    color: project.color,
    children: [
      {
        id: makeWorkspacesSectionId(project.id),
        type: 'section',
        label: t('sidebar.workspacesSection'),
        children: makeBuckets(
          project.id,
          workspacesByProject.get(project.id) ?? [],
          archivedWorkspacesByProject.get(project.id) ?? [],
        ),
      },
    ],
  }));

  if (unassignedActive.length > 0 || unassignedArchived.length > 0) {
    projectNodes.push({
      id: UNASSIGNED_PROJECT_ID,
      type: 'project',
      name: t('sidebar.unassigned'),
      color: '0 0% 60%',
      children: [
        {
          id: makeWorkspacesSectionId(UNASSIGNED_PROJECT_ID),
          type: 'section',
          label: t('sidebar.workspacesSection'),
          children: makeBuckets(
            UNASSIGNED_PROJECT_ID,
            unassignedActive,
            unassignedArchived,
          ),
        },
      ],
    });
  }
  return projectNodes;
}

export function SidebarProjectTree({
  projects,
  activeProjectId,
  workspaces,
  archivedWorkspaces = [],
  membership,
  activeWorkspaceId,
  isLoading = false,
  onSelectWorkspace,
  onSelectProject,
  onProjectsReorder,
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
      ws: OutlinerWorkspace,
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
        t,
      }),
    [
      projects,
      workspacesByProject,
      archivedWorkspacesByProject,
      unassignedActive,
      unassignedArchived,
      t,
    ],
  );

  const projectIds = useMemo(() => treeData.map((n) => n.id), [treeData]);

  // Seed the open-state map from persistence + defaults. Recomputed when the
  // project set changes, but react-arborist only consumes this value at Tree
  // mount (provider.js: createStore inside useRef). Post-mount the Tree's
  // in-memory store owns open state; this prop is ignored.
  const initialOpenState = useMemo(
    () => buildSidebarTreeInitialOpenState(projectIds),
    [projectIds],
  );

  // In-memory mirror of persisted open state. Kept in a ref so toggles don't
  // trigger re-renders — the Tree re-renders itself via its store
  // subscription; we only persist on the side.
  const openStateRef = useRef<Record<string, boolean>>(
    readSidebarTreeOpenState(new Set(projectIds)),
  );
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
  const { containerRef, width: containerWidth, height } = useContainerHeight();

  const handleActivate = useCallback(
    (node: NodeApi<SidebarTreeNode>) => {
      const data = node.data;
      if (data.type === 'leaf') {
        onSelectWorkspace(data.workspace.id);
      } else if (data.type === 'project') {
        onSelectProject(data.id);
      }
    },
    [onSelectWorkspace, onSelectProject],
  );

  const handleToggle = useCallback(
    (id: string) => {
      // onToggle fires for every node (project | section | bucket). Persist
      // all three by node id — ids are already project-scoped, so per-project
      // state is isolated. (Tree has already updated its store by the time
      // onToggle fires: tree-api dispatches visibility.open/close BEFORE
      // safeRun(onToggle, id).)
      const node = treeRef.current?.get(id);
      if (!node) return;
      openStateRef.current = { ...openStateRef.current, [id]: node.isOpen };
      scheduleOpenStateWrite();
    },
    [scheduleOpenStateWrite],
  );

  const handleMove = useCallback(
    (args: {
      dragIds: string[];
      dragNodes: NodeApi<SidebarTreeNode>[];
      parentId: string | null;
      parentNode: NodeApi<SidebarTreeNode> | null;
      index: number;
    }) => {
      const { dragIds, dragNodes, parentId, index } = args;
      // ADR-007: only allow reordering projects at the root, and only when
      // the dragged node is a project row. Everything else (sections,
      // buckets, leaves) is rejected — react-arborist will snap them back.
      if (parentId !== ROOT_PARENT_ID) return;
      if (dragNodes.length === 0) return;
      const first = dragNodes[0];
      if (!first || first.data.type !== 'project') return;
      // The Unassigned pseudo-project is not user-reorderable — it always
      // sits at the bottom of the tree.
      if (dragIds.includes(UNASSIGNED_PROJECT_ID)) return;

      const visibleProjects = treeData
        .filter((n): n is ProjectNode => n.type === 'project')
        .map((n) => n.id);
      const unassignedPresent = visibleProjects.includes(UNASSIGNED_PROJECT_ID);
      const reorderableProjects = visibleProjects.filter(
        (id) => id !== UNASSIGNED_PROJECT_ID,
      );

      const dragId = dragIds[0];
      if (!dragId) return;

      const fromIndex = reorderableProjects.indexOf(dragId);
      if (fromIndex === -1) return;

      const next = reorderableProjects.slice();
      next.splice(fromIndex, 1);
      const insertAt = Math.max(0, Math.min(index, next.length));
      next.splice(insertAt, 0, dragId);

      if (unassignedPresent) next.push(UNASSIGNED_PROJECT_ID);
      const reordered = next.filter((id) => id !== UNASSIGNED_PROJECT_ID);
      if (reordered.length === 0) return;
      onProjectsReorder(reordered);
    },
    [treeData, onProjectsReorder],
  );

  // BoolFunc signature for disableDrag.
  const isProjectDragDisabled = useCallback(
    (data: SidebarTreeNode) => data.type !== 'project',
    [],
  );

  // disableDrop has a richer signature (parentNode + dragNodes + index) so
  // sections/buckets/leaves cannot be dropped onto.
  const isProjectDropDisabled = useCallback(
    (args: {
      parentNode: NodeApi<SidebarTreeNode>;
      dragNodes: NodeApi<SidebarTreeNode>[];
      index: number;
    }) => {
      if (args.parentNode.data.type !== 'project') return true;
      // Only allow dropping at root between project rows. Dragging a
      // section/bucket/leaf onto a project is rejected.
      if (args.dragNodes.some((n) => n.data.type !== 'project')) return true;
      return false;
    },
    [],
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
              openByDefault
              initialOpenState={initialOpenState}
              width={containerWidth || width}
              height={height}
              indent={TREE_LAYOUT.indent}
              rowHeight={(node) => {
                if (node.data.type === 'leaf')
                  return TREE_LAYOUT.rowHeight.leaf;
                if (node.data.type === 'project')
                  return TREE_LAYOUT.rowHeight.project;
                return TREE_LAYOUT.rowHeight.default;
              }}
              overscanCount={TREE_LAYOUT.overscanCount}
              padding={TREE_LAYOUT.padding}
              disableEdit
              disableMultiSelection
              disableDrop={isProjectDropDisabled}
              disableDrag={isProjectDragDisabled}
              onActivate={handleActivate}
              onToggle={handleToggle}
              onMove={handleMove}
              aria-labelledby={ariaLabelledBy}
            >
              {(props) => (
                <TreeNodeRouter
                  {...props}
                  onSelectProject={onSelectProject}
                  activeProjectId={activeProjectId}
                  activeWorkspaceId={activeWorkspaceId}
                />
              )}
            </Tree>
          )}
        </div>
      )}
    </section>
  );
}
