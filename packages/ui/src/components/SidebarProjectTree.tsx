import { useCallback, useMemo, useRef } from 'react';
import {
  Tree,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from 'react-arborist';
import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { categorizeWorkspacesForOutliner } from '../lib/workspaceStatus';
import { OutlinerLeafNode } from './outliner/LeafNode';
import { OutlinerBucketNode } from './outliner/BucketNode';
import {
  BUCKET_ORDER,
  buildSidebarTreeInitialOpenState,
  readSidebarTreeOpenState,
  writeSidebarTreeOpenState,
  type BucketNode,
  type LeafNode,
  type OutlinerWorkspace,
  type TreeNodeRenderProps,
} from './outliner/types';
import { useContainerHeight } from './outliner/useContainerHeight';

/** Stable id for the pseudo-project that holds workspaces with no project link. */
export const UNASSIGNED_PROJECT_ID = 'unassigned';

/** Per-project workspaces section id (e.g. `${projectId}:workspaces`). */
export type WorkspacesSectionId = `${string}:workspaces`;

/**
 * Sidebar project record (a trimmed shape — only what the tree needs to
 * render a project row).
 */
export interface SidebarProject {
  id: string;
  name: string;
  color: string;
}

/** Sidebar-local alias for the membership map shape. */
export type SidebarMembership = Map<string, Set<string>>;

/**
 * Tree node union. Project / section / bucket / leaf. The four levels map
 * 1:1 to the ADR-007 design:
 *   project → "Workspaces" section → bucket (Active/Running/Idle/Archived)
 *            → workspace leaf.
 */
export type SidebarTreeNode = ProjectNode | SectionNode | BucketNode | LeafNode;

export interface ProjectNode {
  id: string;
  type: 'project';
  name: string;
  color: string;
  children: SectionNode[];
}

export interface SectionNode {
  id: WorkspacesSectionId;
  type: 'section';
  label: string;
  children: BucketNode[];
}

interface SidebarProjectTreeProps {
  /** All known projects, in display order (already sorted by the caller). */
  projects: readonly SidebarProject[];
  /** Project id whose destination the user is currently on, if any. */
  activeProjectId: string | null;
  /** Active (non-archived) workspaces. */
  workspaces: OutlinerWorkspace[];
  /** Archived workspaces. */
  archivedWorkspaces?: OutlinerWorkspace[];
  /** local_workspace_id → set of project ids it's linked to. */
  membership: SidebarMembership;
  /** Workspace id whose destination the user is currently on, if any. */
  activeWorkspaceId: string | null;
  isLoading?: boolean;
  onSelectWorkspace: (id: string) => void;
  onSelectProject: (id: string) => void;
  /**
   * Called after the user successfully reorders projects in the tree. The
   * caller is responsible for persisting the new order (mirrors the
   * `onProjectsDragEnd` contract that `ProjectsGroup` exposed).
   */
  onProjectsReorder: (reorderedProjectIds: string[]) => void;
  /** Fixed width of the tree viewport (px). Defaults to the sidebar width. */
  width?: number;
  className?: string;
}

/** "Root" id used by react-arborist for top-level nodes. */
const ROOT_PARENT_ID: string | null = null;

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';

  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Build the tree data. One project node per real project, plus an
 * "Unassigned" pseudo-project at the bottom. Each project/section has one
 * "Workspaces" section that contains the four buckets.
 */
function buildTreeData(
  projects: readonly SidebarProject[],
  workspacesByProject: Map<string, OutlinerWorkspace[]>,
  archivedWorkspacesByProject: Map<string, OutlinerWorkspace[]>,
  unassignedActive: OutlinerWorkspace[],
  unassignedArchived: OutlinerWorkspace[],
  t: (key: string) => string
): SidebarTreeNode[] {
  const makeBuckets = (
    projectId: string,
    active: readonly OutlinerWorkspace[],
    archived: readonly OutlinerWorkspace[]
  ): BucketNode[] => {
    const {
      attention,
      running,
      idle,
      archived: archivedBucket,
    } = categorizeWorkspacesForOutliner(active, archived);
    return BUCKET_ORDER.map((bucketId): BucketNode => {
      const items =
        bucketId === 'attention'
          ? attention
          : bucketId === 'running'
            ? running
            : bucketId === 'idle'
              ? idle
              : archivedBucket;
      const label = (() => {
        switch (bucketId) {
          case 'attention':
            return t('workspaces.outliner.active');
          case 'running':
            return t('workspaces.running');
          case 'idle':
            return t('workspaces.idle');
          case 'archived':
            return t('workspaces.archived');
        }
      })();
      return {
        id: `${projectId}:bucket:${bucketId}`,
        type: 'bucket',
        bucketId,
        name: label,
        children: items.map((workspace): LeafNode => ({
          id: workspace.id,
          type: 'leaf',
          workspace,
        })),
      };
    });
  };

  const projectNodes: ProjectNode[] = projects.map((project) => {
    const active = workspacesByProject.get(project.id) ?? [];
    const archived = archivedWorkspacesByProject.get(project.id) ?? [];
    return {
      id: project.id,
      type: 'project',
      name: project.name,
      color: project.color,
      children: [
        {
          id: `${project.id}:workspaces` as WorkspacesSectionId,
          type: 'section',
          label: t('sidebar.workspacesSection'),
          children: makeBuckets(project.id, active, archived),
        },
      ],
    };
  });

  // Unassigned pseudo-project (only when there's at least one unassigned
  // workspace, so the tree stays clean otherwise).
  if (unassignedActive.length > 0 || unassignedArchived.length > 0) {
    projectNodes.push({
      id: UNASSIGNED_PROJECT_ID,
      type: 'project',
      name: t('sidebar.unassigned'),
      color: '0 0% 60%',
      children: [
        {
          id: `${UNASSIGNED_PROJECT_ID}:workspaces` as WorkspacesSectionId,
          type: 'section',
          label: t('sidebar.workspacesSection'),
          children: makeBuckets(
            UNASSIGNED_PROJECT_ID,
            unassignedActive,
            unassignedArchived
          ),
        },
      ],
    });
  }

  return projectNodes;
}

function ProjectTreeNode(
  props: TreeNodeRenderProps<ProjectNode> & {
    onSelectProject: (id: string) => void;
    activeProjectId: string | null;
  }
) {
  const { node, style, dragHandle, onSelectProject, activeProjectId } = props;
  const { t } = useTranslation('common');
  const project = node.data;
  const isActive = project.id === activeProjectId;
  const isUnassigned = project.id === UNASSIGNED_PROJECT_ID;
  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-selected={isActive}
      aria-expanded={node.isOpen}
      onClick={() => {
        node.toggle();
        onSelectProject(project.id);
      }}
      className={cn(
        'group relative flex w-full cursor-pointer items-center gap-1 rounded-md pr-1.5 text-left',
        'text-base transition-colors focus:outline-none',
        isActive ? 'text-high font-bold' : 'text-normal hover:bg-tertiary'
      )}
    >
      <CaretRightIcon
        aria-hidden="true"
        className={cn(
          'size-2.5 shrink-0 text-low transition-transform duration-150',
          node.isOpen && 'rotate-90'
        )}
        weight="bold"
      />
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-medium',
          isUnassigned && 'opacity-70'
        )}
        style={{
          color: `hsl(${project.color})`,
          backgroundColor: `hsl(${project.color} / 0.18)`,
        }}
        aria-hidden="true"
      >
        {getProjectInitials(project.name)}
      </span>
      <span className="truncate">{project.name}</span>
      <button
        aria-label={t('sidebar.openProjectKanban')}
        onClick={(e) => {
          e.stopPropagation();
          onSelectProject(project.id);
        }}
        className={cn(
          'pointer-events-auto ml-auto shrink-0 rounded-sm p-0.5',
          'text-low hover:text-high hover:bg-tertiary',
          'transition-opacity focus:outline-none'
        )}
      >
        <ArrowSquareOutIcon className="size-4.5" weight="bold" />
      </button>
    </div>
  );
}

function SectionTreeNode(props: TreeNodeRenderProps<SectionNode>) {
  const { node, style, dragHandle } = props;
  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-expanded={node.isOpen}
      onClick={() => node.toggle()}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1 rounded-sm pr-1.5 text-left',
        'text-sm font-medium text-low',
        'hover:bg-surface focus:outline-none',
        node.isFocused && 'bg-surface/60'
      )}
    >
      <CaretRightIcon
        aria-hidden="true"
        className={cn(
          'size-2.5 shrink-0 text-low transition-transform duration-150',
          node.isOpen && 'rotate-90'
        )}
        weight="bold"
      />
      <span className="truncate">{node.data.label}</span>
    </div>
  );
}

function TreeNodeRouter(
  props: NodeRendererProps<SidebarTreeNode> & {
    onSelectProject: (id: string) => void;
    activeProjectId: string | null;
    activeWorkspaceId: string | null;
  }
) {
  const {
    node,
    style,
    dragHandle,
    onSelectProject,
    activeProjectId,
    activeWorkspaceId,
  } = props;
  switch (node.data.type) {
    case 'project':
      return (
        <ProjectTreeNode
          node={node as NodeApi<ProjectNode>}
          style={style}
          dragHandle={dragHandle}
          onSelectProject={onSelectProject}
          activeProjectId={activeProjectId}
        />
      );
    case 'section':
      return (
        <SectionTreeNode
          node={node as NodeApi<SectionNode>}
          style={style}
          dragHandle={dragHandle}
        />
      );
    case 'bucket':
      return (
        <OutlinerBucketNode
          node={node as NodeApi<BucketNode>}
          style={style}
          dragHandle={dragHandle}
        />
      );
    case 'leaf':
      return (
        <OutlinerLeafNode
          node={node as NodeApi<LeafNode>}
          style={style}
          dragHandle={dragHandle}
          activeWorkspaceId={activeWorkspaceId}
        />
      );
  }
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
      buildTreeData(
        projects,
        workspacesByProject,
        archivedWorkspacesByProject,
        unassignedActive,
        unassignedArchived,
        t
      ),
    [
      projects,
      workspacesByProject,
      archivedWorkspacesByProject,
      unassignedActive,
      unassignedArchived,
      t,
    ]
  );

  const projectIds = useMemo(() => treeData.map((n) => n.id), [treeData]);

  // Seed the open-state map from persistence + defaults. Recomputed when the
  // project set changes, but react-arborist only consumes this value at Tree
  // mount (provider.js: createStore inside useRef). Post-mount the Tree's
  // in-memory store owns open state; this prop is ignored.
  const initialOpenState = useMemo(
    () => buildSidebarTreeInitialOpenState(projectIds),
    [projectIds]
  );

  // In-memory mirror of persisted open state. Kept in a ref so toggles don't
  // trigger re-renders — the Tree re-renders itself via its store
  // subscription; we only persist on the side.
  const openStateRef = useRef<Record<string, boolean>>(
    readSidebarTreeOpenState(new Set(projectIds))
  );
  const writeScheduled = useRef(false);

  // Coalesce a burst of synchronous toggles into one localStorage write.
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
    [onSelectWorkspace, onSelectProject]
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
    [scheduleOpenStateWrite]
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
        .filter((n) => n.type === 'project')
        .map((n) => n.id);

      const dragId = dragIds[0];
      if (!dragId) return;

      const fromIndex = visibleProjects.indexOf(dragId);
      if (fromIndex === -1) return;

      const next = visibleProjects.slice();
      next.splice(fromIndex, 1);
      const insertAt = Math.max(0, Math.min(index, next.length));
      next.splice(insertAt, 0, dragId);

      const reordered = next.filter((id) => id !== UNASSIGNED_PROJECT_ID);
      if (reordered.length === 0) return;
      onProjectsReorder(reordered);
    },
    [treeData, onProjectsReorder]
  );

  // BoolFunc signature for disableDrag.
  const isProjectDragDisabled = useCallback(
    (data: SidebarTreeNode) => data.type !== 'project',
    []
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
    []
  );

  const hasAnyContent =
    projects.length > 0 ||
    workspaces.length > 0 ||
    archivedWorkspaces.length > 0;

  return (
    <section
      aria-label={t('appBar.projects')}
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
              indent={12}
              rowHeight={(node) => {
                if (node.data.type === 'leaf') return 40;
                if (node.data.type === 'project') return 32;
                return 24;
              }}
              overscanCount={5}
              padding={2}
              disableEdit
              disableMultiSelection
              selection={activeProjectId ?? undefined}
              selectionFollowsFocus={false}
              disableDrop={isProjectDropDisabled}
              disableDrag={isProjectDragDisabled}
              onActivate={handleActivate}
              onToggle={handleToggle}
              onMove={handleMove}
              aria-label={t('appBar.projects')}
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
