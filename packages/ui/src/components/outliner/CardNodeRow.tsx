import { CaretRightIcon } from '@phosphor-icons/react';
import type { IssuePriority } from 'shared/remote-types';
import { cn } from '../../lib/cn';
import { TREE_LAYOUT } from './layout';
import type { CardNode, TreeNodeRenderProps } from './types';

const PRIORITY_DOT_CLASS: Record<IssuePriority, string> = {
  urgent: 'bg-error',
  high: 'bg-warning',
  medium: 'bg-brand',
  low: 'bg-tertiary',
};

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
  const indent = node.tree.indent;
  const paddingLeft = (style.paddingLeft as number | undefined) ?? 0;
  const guideX = paddingLeft - indent + TREE_LAYOUT.caretHalf;
  const tickWidth = Math.max(0, indent - TREE_LAYOUT.caretHalf);
  const priorityClass = issue.priority
    ? PRIORITY_DOT_CLASS[issue.priority]
    : null;

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
          aria-label={node.isOpen ? 'Collapse sub-issues' : 'Expand sub-issues'}
          aria-expanded={node.isOpen}
          onClick={(event) => {
            event.stopPropagation();
            node.toggle();
          }}
          className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-low hover:bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
        {priorityClass && (
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0 rounded-full', priorityClass)}
          />
        )}
        <span className="shrink-0 font-mono text-2xs text-low">
          {issue.simpleId}
        </span>
        <span className="truncate">{issue.title}</span>
      </div>
    </div>
  );
}
