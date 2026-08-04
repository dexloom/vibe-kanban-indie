import { cn } from '../../lib/cn';
import { TreeRow } from './TreeRow';
import { useTreeCardDrag } from './treeDrag';
import type { CardNode, TreeNodeRenderProps } from './types';

interface CardNodeRowProps extends TreeNodeRenderProps<CardNode> {
  activeIssueId?: string | null;
  /** Disables drag while the kanban's bulk-select mode is on (PLAN §7.5).
   * Defaults to `false` so the prop is optional in tests / non-DnD contexts. */
  isMultiSelectActive?: boolean;
}

/**
 * Compact issue title row. Cards with sub-issues expose an isolated caret.
 *
 * Drag is handled by the custom tree drag manager (see
 * `outliner/treeDrag/TreeDragManager`) rather than hello-pangea — the
 * hello-pangea `<Draggable>` never lifts inside react-arborist\'s
 * virtualized rows (registry churn drops the Draggable before mousedown,
 * `getById` invariant crashes), so we install our own mouse sensor and
 * ghost. The hook `useTreeCardDrag` returns an `onMouseDown` handler that
 * the layout\'s `TreeDragManager` listens to. A `data-tree-card` attribute
 * tags the source row so the manager can clone it for the ghost.
 *
 * The row\'s click-to-navigate still flows through react-arborist\'s outer
 * DefaultRow → `node.handleClick` → `onActivate`; the manager installs a
 * one-shot capture-phase click swallower on promote so the synthetic click
 * fired after a real drag doesn\'t navigate.
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

  const { onMouseDown } = useTreeCardDrag(
    issue.id,
    issue.projectId,
    isMultiSelectActive,
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
          : 'text-normal font-light hover:text-high',
      )}
      outerProps={{
        ...(onMouseDown ? { onMouseDown } : {}),
        'data-tree-card': issue.id,
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{issue.title}</span>
      </div>
    </TreeRow>
  );
}
