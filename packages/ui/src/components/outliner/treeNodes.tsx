import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { ArrowSquareOutIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { OutlinerBucketNode } from './BucketNode';
import { CardNodeRow } from './CardNodeRow';
import { OutlinerLeafNode } from './LeafNode';
import { StatusNodeRow } from './StatusNodeRow';
import { TasksSectionNode } from './TasksSectionNode';
import { TreeCaretRow } from './TreeCaretRow';
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
    onSelectProject: (id: string) => void;
    activeProjectId: string | null;
  },
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
        isActive ? 'text-high font-bold' : 'text-normal hover:bg-tertiary',
      )}
    >
      <CaretRightIcon
        aria-hidden="true"
        className={cn(
          'size-2.5 shrink-0 text-low transition-transform duration-150',
          node.isOpen && 'rotate-90',
        )}
        weight="bold"
      />
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-medium',
          isUnassigned && 'opacity-70',
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
          'transition-opacity focus:outline-none',
        )}
      >
        <ArrowSquareOutIcon className="size-4.5" weight="bold" />
      </button>
    </div>
  );
}

function SectionTreeNode(
  props: TreeNodeRenderProps<Extract<SectionNode, { kind: 'workspaces' }>>,
) {
  const { node, style, dragHandle } = props;
  return (
    <TreeCaretRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      className="text-sm font-medium text-low"
    >
      <span className="truncate">{node.data.label}</span>
    </TreeCaretRow>
  );
}

export function TreeNodeRouter(
  props: NodeRendererProps<SidebarTreeNode> & {
    onSelectProject: (id: string) => void;
    activeProjectId: string | null;
    activeWorkspaceId: string | null;
    onSelectIssue?: (projectId: string, issueId: string) => void;
    activeIssueId?: string | null;
  },
) {
  const {
    node,
    style,
    dragHandle,
    onSelectProject,
    activeProjectId,
    activeWorkspaceId,
    activeIssueId,
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
        />
      );
  }
}
