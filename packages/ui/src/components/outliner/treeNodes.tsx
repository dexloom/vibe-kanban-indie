import type { NodeApi, NodeRendererProps } from 'react-arborist';
import {
  ArrowSquareOutIcon,
  LightningIcon,
  NotePencilIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useDraggable, useDropTarget } from '../dnd';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../DropdownMenu';
import {
  useDragActive,
  useDragCandidate,
  useDragSourceProjectId,
} from './dragState';
import { OutlinerBucketNode } from './BucketNode';
import { CardNodeRow } from './CardNodeRow';
import { OutlinerLeafNode } from './LeafNode';
import { StatusNodeRow } from './StatusNodeRow';
import { TasksSectionNode } from './TasksSectionNode';
import { TreeRow } from './TreeRow';
import { nearestProjectTint } from './treeGeometry';
import { DIM_ROW, HOVER_ROW, TINT_ROW, tintStyle } from './layout';
import type {
  BucketNode,
  CardNode,
  LeafNode,
  OrchestratorPromptNode,
  ProjectNode,
  SectionNode,
  SidebarTreeNode,
  StatusNode,
  TreeNodeRenderProps,
} from './types';
import { UNASSIGNED_PROJECT_ID } from './types';

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';

  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function ProjectTreeNode(
  props: TreeNodeRenderProps<ProjectNode> & {
    onCreateChildBoard?: (parentId: string) => void;
    onSelectOrchestratorPrompt?: (projectId: string) => void;
    onOpenProjectPage?: (projectId: string) => void;
    /** Opens the most-recent workspace under the Orchestrator (Unassigned)
     *  pseudo-project. Rendered only on that row. */
    onOpenLastWorkspace?: () => void;
    activeProjectId: string | null;
    tintColor?: string | null;
    dimmed?: boolean;
  }
) {
  const {
    node,
    style,
    dragHandle,
    onCreateChildBoard,
    onSelectOrchestratorPrompt,
    onOpenProjectPage,
    onOpenLastWorkspace,
    activeProjectId,
    tintColor,
    dimmed,
  } = props;
  const { t } = useTranslation('common');
  const project = node.data;
  const isActive = project.id === activeProjectId;
  const isUnassigned = project.id === UNASSIGNED_PROJECT_ID;
  const isExpandable = !node.isLeaf;
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const sourceProjectId = useDragSourceProjectId();
  const isCandidate = candidateId === project.id;
  const isSource = sourceProjectId === project.id;
  const projectParentId = project.parentId ?? null;
  const { onPointerDown } = useDraggable(
    {
      kind: 'project-reorder',
      projectId: project.id,
      parentId: projectParentId,
    },
    { disabled: isUnassigned }
  );
  const dropTargetAttrs = useDropTarget(project.id, project.id, {
    acceptKinds: ['project-reorder'],
    parentId: projectParentId,
  });
  // ADR-016: the `+` button is a DropdownMenu with two items — "Add
  // board" (creates a child board) and "Orchestrator prompt" (opens the
  // editor pane). The prompt is rendered as a sibling row, so the menu
  // item label is "Orchestrator prompt" (NOT "Add …") — the column
  // always exists, "Add" would lie.
  const showAddMenu =
    !isUnassigned && (onCreateChildBoard || onSelectOrchestratorPrompt);
  // Collapse-by-default (2026-08-07): row click toggles expand/collapse;
  // the open-page icon navigates to the project's kanban board. The
  // Unassigned pseudo-project has no board, so no icon.
  const showOpenIcon = !isUnassigned && onOpenProjectPage;
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      isActive={isActive}
      // Collapse-by-default (2026-08-07): row click TOGGLES expand/collapse
      // via react-arborist's onActivate (handleActivate → node.toggle);
      // the open-page icon handles navigation to the kanban board.
      outerProps={{
        style: { touchAction: 'none' },
        ...(onPointerDown ? { onPointerDown } : {}),
        ...(!isUnassigned ? dropTargetAttrs : {}),
      }}
      rowClassName={cn(
        'rounded-md text-base transition-[color,opacity,background-color]',
        // Expandable rows are always bold (matches the active project's
        // label weight); the active project additionally gets the fill.
        isExpandable || isActive ? 'font-bold' : 'font-normal',
        isActive ? 'bg-tertiary text-high' : `text-normal ${HOVER_ROW}`,
        dimmed && DIM_ROW,
        isSource && `opacity-50 ${TINT_ROW}`,
        isDragActive && !isUnassigned && !isCandidate && 'bg-tertiary/40',
        isDragActive && isCandidate && 'bg-brand/20'
      )}
    >
      <div className="flex items-center gap-1">
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
        <span
          className="flex-1 min-w-0 truncate"
          style={
            tintColor
              ? tintStyle(tintColor, isActive ? 1 : 0.8)
              : { color: `hsl(${project.color})` }
          }
        >
          {project.name}
        </span>
        {isUnassigned && onOpenLastWorkspace && (
          <button
            aria-label={t(
              'sidebar.openOrchestratorWorkspace',
              'Open last workspace'
            )}
            title={t(
              'sidebar.openOrchestratorWorkspace',
              'Open last workspace'
            )}
            onClick={(e) => {
              e.stopPropagation();
              onOpenLastWorkspace();
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5',
              'text-low hover:text-high hover:bg-tertiary',
              'transition-opacity focus:outline-none'
            )}
          >
            <LightningIcon className="size-4.5" weight="fill" />
          </button>
        )}
        {showOpenIcon && (
          <button
            aria-label={t('sidebar.openProjectPage', 'Open project board')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenProjectPage!(project.id);
            }}
            onPointerDown={(e) => {
              // Same reason as the `+` trigger below: keep the icon's
              // pointer-down independent of the row's drag binding so the
              // click navigates instead of promoting a drag candidate.
              e.stopPropagation();
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5',
              'text-low hover:text-high hover:bg-tertiary',
              'transition-opacity focus:outline-none'
            )}
          >
            <ArrowSquareOutIcon className="size-4.5" weight="bold" />
          </button>
        )}
        {showAddMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={t('sidebar.projectActions', 'Project actions')}
                onClick={(e) => {
                  e.stopPropagation();
                }}
                onPointerDown={(e) => {
                  // The row's drag binding (`useDraggable`'s
                  // `onPointerDown` walked from the trigger up to the
                  // row root exclusive) already exempts the button via
                  // its `button` selector — but the exemption walk is
                  // an implementation detail. `stopPropagation` here
                  // makes the trigger's pointer-down independence from
                  // the row's drag binding explicit: clicking the `+`
                  // never promotes the row to a drag candidate, even
                  // if a future refactor narrows the exemption list.
                  e.stopPropagation();
                }}
                className={cn(
                  'shrink-0 rounded-sm p-0.5',
                  'text-low hover:text-high hover:bg-tertiary',
                  'transition-opacity focus:outline-none'
                )}
              >
                <PlusIcon className="size-4.5" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              {onCreateChildBoard && (
                <DropdownMenuItem
                  onSelect={() => onCreateChildBoard(project.id)}
                >
                  <PlusIcon className="size-4" weight="bold" aria-hidden />
                  {t('sidebar.addChildBoard', 'Add board')}
                </DropdownMenuItem>
              )}
              {onSelectOrchestratorPrompt && (
                <DropdownMenuItem
                  onSelect={() => onSelectOrchestratorPrompt(project.id)}
                >
                  <NotePencilIcon
                    className="size-4"
                    weight="regular"
                    aria-hidden
                  />
                  {t(
                    'sidebar.addOrchestratorPrompt',
                    'Add orchestrator prompt'
                  )}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </TreeRow>
  );
}

function SectionTreeNode(
  props: TreeNodeRenderProps<Extract<SectionNode, { kind: 'workspaces' }>> & {
    onOpenWorkspacesPage?: (projectId: string) => void;
    tintColor?: string | null;
    dimmed?: boolean;
  }
) {
  const { node, style, dragHandle, onOpenWorkspacesPage, tintColor, dimmed } =
    props;
  const { t } = useTranslation('common');
  const projectId = node.data.projectId;
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      onRowClick={() => node.toggle()}
      rowClassName={cn(
        `text-sm font-medium text-low ${TINT_ROW} ${HOVER_ROW}`,
        dimmed && DIM_ROW
      )}
    >
      <div className="flex items-center gap-1">
        <span className="flex-1 min-w-0 truncate" style={tintStyle(tintColor)}>
          {node.data.label}
        </span>
        {onOpenWorkspacesPage && projectId && (
          <button
            aria-label={t('sidebar.openWorkspacesPage', 'Open workspaces')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenWorkspacesPage(projectId);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5',
              'text-low hover:text-high hover:bg-tertiary',
              'transition-opacity focus:outline-none'
            )}
          >
            <ArrowSquareOutIcon className="size-4" weight="bold" />
          </button>
        )}
      </div>
    </TreeRow>
  );
}

/**
 * ADR-016: leaf row for the per-project orchestrator prompt. Activation
 * (row click AND keyboard) is handled by the `handleActivate` branch in
 * `SidebarProjectTree` — routing through the same path as
 * project/leaf/card nodes keeps keyboard navigation working for free.
 * We intentionally do NOT wire a separate `onRowClick` here: the row's
 * activation is dispatched through react-arborist's `onActivate`
 * callback, which fires for both pointer and keyboard events. A second
 * click handler would double-fire `onSelectOrchestratorPrompt` for
 * pointer events (the same row would dispatch once via react-arborist's
 * activation and once via the local `onRowClick`).
 *
 * The `hasPrompt` brand-coloured dot tracks the wire
 * `has_orchestrator_prompt` flag — the body never ships on the list
 * shape, the dot does.
 */
function OrchestratorPromptTreeNode(
  props: TreeNodeRenderProps<OrchestratorPromptNode> & {
    onSelectOrchestratorPrompt?: (projectId: string) => void;
    activeProjectPromptId: string | null;
    tintColor?: string | null;
    dimmed?: boolean;
  }
) {
  const { node, style, dragHandle, activeProjectPromptId, tintColor, dimmed } =
    props;
  const { t } = useTranslation('common');
  const data = node.data;
  const isActive = data.projectId === activeProjectPromptId;
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      isActive={isActive}
      rowClassName={cn(
        `rounded-md text-sm text-low transition-[color,opacity] ${HOVER_ROW} hover:text-normal`,
        dimmed && DIM_ROW
      )}
    >
      <div className="flex items-center gap-1">
        <NotePencilIcon
          className="size-3.5 shrink-0 text-low"
          weight="regular"
          aria-hidden
        />
        <span className="truncate" style={tintStyle(tintColor)}>
          {data.label}
        </span>
        {data.hasPrompt && (
          <span
            aria-label={t(
              'sidebar.orchestratorPromptSet',
              'Orchestrator prompt is set'
            )}
            data-testid={`orchestrator-prompt-dot-${data.projectId}`}
            className="ml-auto size-1.5 shrink-0 rounded-full bg-brand"
          />
        )}
      </div>
    </TreeRow>
  );
}

export function TreeNodeRouter(
  props: NodeRendererProps<SidebarTreeNode> & {
    onCreateChildBoard?: (parentId: string) => void;
    onSelectOrchestratorPrompt?: (projectId: string) => void;
    onOpenProjectPage?: (projectId: string) => void;
    onOpenWorkspacesPage?: (projectId: string) => void;
    onOpenLastWorkspace?: () => void;
    activeProjectId: string | null;
    activeProjectPromptId?: string | null;
    activeWorkspaceId: string | null;
    onSelectIssue?: (
      projectId: string,
      issueId: string,
      parentIssueId?: string | null
    ) => void;
    activeIssueId?: string | null;
    /** Mirrors KanbanCard's `dragDisabled={isMultiSelectActive}` — tree card
     * drag is disabled while the kanban's bulk-select mode is on (PLAN §7.5). */
    isMultiSelectActive?: boolean;
  }
) {
  const {
    node,
    style,
    dragHandle,
    onCreateChildBoard,
    onSelectOrchestratorPrompt,
    onOpenProjectPage,
    onOpenWorkspacesPage,
    onOpenLastWorkspace,
    activeProjectId,
    activeProjectPromptId,
    activeWorkspaceId,
    activeIssueId,
    onSelectIssue,
    isMultiSelectActive,
  } = props;
  // ADR-016 usability: every project is color-coded — each node gets its
  // nearest project ancestor's color; nodes outside the active project's
  // subtree are dimmed so the working scope stands out.
  const tint = nearestProjectTint(node, activeProjectId);
  const tintColor = tint?.color ?? null;
  // Dim rows only when a project is actually selected AND this node is
  // outside its subtree. With no active project (workspace/settings
  // routes) nothing is dimmed — the whole tree stays readable.
  const dimmed =
    activeProjectId !== null && (tint === null || !tint.inActiveSubtree);
  switch (node.data.type) {
    case 'project':
      return (
        <ProjectTreeNode
          node={node as NodeApi<ProjectNode>}
          style={style}
          dragHandle={dragHandle}
          onCreateChildBoard={onCreateChildBoard}
          onSelectOrchestratorPrompt={onSelectOrchestratorPrompt}
          onOpenProjectPage={onOpenProjectPage}
          onOpenLastWorkspace={onOpenLastWorkspace}
          activeProjectId={activeProjectId}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
    case 'section':
      return node.data.kind === 'tasks' ? (
        <TasksSectionNode
          node={node as NodeApi<Extract<SectionNode, { kind: 'tasks' }>>}
          style={style}
          dragHandle={dragHandle}
          onOpenProjectPage={onOpenProjectPage}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      ) : (
        <SectionTreeNode
          node={node as NodeApi<Extract<SectionNode, { kind: 'workspaces' }>>}
          style={style}
          dragHandle={dragHandle}
          onOpenWorkspacesPage={onOpenWorkspacesPage}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
    case 'orchestrator-prompt':
      return (
        <OrchestratorPromptTreeNode
          node={node as NodeApi<OrchestratorPromptNode>}
          style={style}
          dragHandle={dragHandle}
          onSelectOrchestratorPrompt={onSelectOrchestratorPrompt}
          activeProjectPromptId={activeProjectPromptId ?? null}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
    case 'bucket':
      return (
        <OutlinerBucketNode
          node={node as NodeApi<BucketNode>}
          style={style}
          dragHandle={dragHandle}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
    case 'leaf':
      return (
        <OutlinerLeafNode
          node={node as NodeApi<LeafNode>}
          style={style}
          dragHandle={dragHandle}
          activeWorkspaceId={activeWorkspaceId}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
    case 'status':
      return (
        <StatusNodeRow
          node={node as NodeApi<StatusNode>}
          style={style}
          dragHandle={dragHandle}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
    case 'card':
      return (
        <CardNodeRow
          node={node as NodeApi<CardNode>}
          style={style}
          dragHandle={dragHandle}
          activeIssueId={activeIssueId}
          isMultiSelectActive={isMultiSelectActive}
          onSelectIssue={onSelectIssue}
          tintColor={tintColor}
          dimmed={dimmed}
        />
      );
  }
}
