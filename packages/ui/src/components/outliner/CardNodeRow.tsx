import { cn } from '../../lib/cn';
import { TreeRow } from './TreeRow';
import type { CardNode, TreeNodeRenderProps } from './types';

interface CardNodeRowProps extends TreeNodeRenderProps<CardNode> {
  activeIssueId?: string | null;
}

/** Compact issue title row. Cards with sub-issues expose an isolated caret. */
export function CardNodeRow({
  node,
  style,
  dragHandle,
  activeIssueId,
}: CardNodeRowProps) {
  const issue = node.data.issue;
  const isActive = issue.id === activeIssueId;
  const hasChildren = node.data.children.length > 0;

  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      isActive={isActive}
      showCaret={hasChildren}
      rowClassName={cn(
        'text-sm leading-tight',
        isActive ? 'text-high font-semibold' : 'text-normal font-light hover:text-high',
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{issue.title}</span>
      </div>
    </TreeRow>
  );
}