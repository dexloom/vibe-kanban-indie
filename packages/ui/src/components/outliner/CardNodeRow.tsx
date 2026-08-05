import { cn } from '../../lib/cn';
import { TreeRow } from './TreeRow';
import { useDraggable } from '../dnd';
import type { CardNode, TreeNodeRenderProps } from './types';

interface CardNodeRowProps extends TreeNodeRenderProps<CardNode> {
  activeIssueId?: string | null;
  /** Disables drag while the kanban's bulk-select mode is on.
   * Defaults to `false` so the prop is optional in tests / non-DnD contexts. */
  isMultiSelectActive?: boolean;
}

/**
 * Compact issue title row. Cards with sub-issues expose an isolated caret.
 *
 * Drag is handled by the unified custom drag system (see
 * `components/dnd/DragController`). The controller owns the window-level
 * pointer sensor and ghost; this hook only binds `onPointerDown` to the row's
 * current element so the controller can clone the actual DOM node for the
 * ghost.
 *
 * The row's click-to-navigate still flows through react-arborist's outer
 * DefaultRow → `node.handleClick` → `onActivate`; the controller installs a
 * one-shot capture-phase click swallower on promote so the synthetic click
 * fired after a real drag doesn't navigate.
 */
export function CardNodeRow({
  node,
  style,
  activeIssueId,
  isMultiSelectActive = false,
}: CardNodeRowProps) {
  const issue = node.data.issue;
  const isActive = issue.id === activeIssueId;
  const hasChildren = node.data.children.length > 0;

  const { onPointerDown } = useDraggable(
    {
      kind: 'issue-move',
      issueId: issue.id,
      projectId: issue.projectId,
      statusId: issue.statusId,
    },
    { disabled: isMultiSelectActive }
  );

  return (
    <TreeRow
      node={node}
      style={style}
      isActive={isActive}
      showCaret={hasChildren}
      rowClassName={cn(
        'text-sm leading-tight',
        isActive
          ? 'text-high font-semibold'
          : 'text-normal font-light hover:text-high'
      )}
      outerProps={{
        style: { touchAction: 'none' },
        ...(onPointerDown ? { onPointerDown } : {}),
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{issue.title}</span>
      </div>
    </TreeRow>
  );
}
