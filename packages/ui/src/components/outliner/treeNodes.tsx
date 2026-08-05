import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { useDraggable, useDropTarget } from '../dnd';
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
import type {
  BucketNode,
  CardNode,
  LeafNode,
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
    activeProjectId: string | null;
  }
) {
  const {
    node,
    style,
    dragHandle,
    onCreateChildBoard,
    activeProjectId,
  } = props;
  const { t } = useTranslation('common');
  const project = node.data;
  const isActive = project.id === activeProjectId;
  const isUnassigned = project.id === UNASSIGNED_PROJECT_ID;
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
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      isActive={isActive}
      // ADR-015: row click navigates via react-arborist's onActivate
      // (handleActivate → onSelectProject); the caret handles toggle.
      outerProps={{
        style: { touchAction: 'none' },
        ...(onPointerDown ? { onPointerDown } : {}),
        ...(!isUnassigned ? dropTargetAttrs : {}),
      }}
      rowClassName={cn(
        'rounded-md text-base transition-colors',
        isActive ? 'text-high font-bold' : 'text-normal hover:bg-tertiary',
        isSource && 'opacity-50 transition-opacity',
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
        <span className="truncate">{project.name}</span>
        {!isUnassigned && onCreateChildBoard && (
          <button
            aria-label={t('sidebar.createChildBoard', 'Create child board')}
            onClick={(e) => {
              e.stopPropagation();
              onCreateChildBoard(project.id);
            }}
            className={cn(
              'pointer-events-auto ml-auto shrink-0 rounded-sm p-0.5',
              'text-low hover:text-high hover:bg-tertiary',
              'transition-opacity focus:outline-none'
            )}
          >
            <PlusIcon className="size-4.5" weight="bold" />
          </button>
        )}
      </div>
    </TreeRow>
  );
}

function SectionTreeNode(
  props: TreeNodeRenderProps<Extract<SectionNode, { kind: 'workspaces' }>>
) {
  const { node, style, dragHandle } = props;
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      onRowClick={() => node.toggle()}
      rowClassName="text-sm font-medium text-low"
    >
      <span className="truncate">{node.data.label}</span>
    </TreeRow>
  );
}

export function TreeNodeRouter(
  props: NodeRendererProps<SidebarTreeNode> & {
    onCreateChildBoard?: (parentId: string) => void;
    activeProjectId: string | null;
    activeWorkspaceId: string | null;
    onSelectIssue?: (projectId: string, issueId: string) => void;
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
    activeProjectId,
    activeWorkspaceId,
    activeIssueId,
    isMultiSelectActive,
  } = props;
  switch (node.data.type) {
    case 'project':
      return (
        <ProjectTreeNode
          node={node as NodeApi<ProjectNode>}
          style={style}
          dragHandle={dragHandle}
          onCreateChildBoard={onCreateChildBoard}
          activeProjectId={activeProjectId}
        />
      );
    case 'section':
      return node.data.kind === 'tasks' ? (
        <TasksSectionNode
          node={node as NodeApi<Extract<SectionNode, { kind: 'tasks' }>>}
          style={style}
          dragHandle={dragHandle}
        />
      ) : (
        <SectionTreeNode
          node={node as NodeApi<Extract<SectionNode, { kind: 'workspaces' }>>}
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
    case 'status':
      return (
        <StatusNodeRow
          node={node as NodeApi<StatusNode>}
          style={style}
          dragHandle={dragHandle}
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
        />
      );
  }
}
