import { CaretRightIcon } from '@phosphor-icons/react';
import { cn } from '../../lib/cn';
import type { BucketNode, TreeNodeRenderProps } from './types';

/**
 * Outliner bucket header row: small caret + label + child count. Visuals
 * are intentionally identical to the ADR-006 WorkspaceOutliner bucket.
 */
export function OutlinerBucketNode({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<BucketNode>) {
  const bucket = node.data;
  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-expanded={node.isOpen}
      onClick={() => node.toggle()}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1 rounded-sm pr-1.5 text-left',
        'text-xs font-medium uppercase tracking-wide text-low',
        'hover:bg-surface focus:outline-none',
        node.isFocused && 'bg-surface/60'
      )}
    >
      <CaretRightIcon
        className={cn(
          'size-2.5 shrink-0 text-low transition-transform duration-150',
          node.isOpen && 'rotate-90'
        )}
        weight="bold"
      />
      <span className="truncate">{bucket.name}</span>
      <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
        {bucket.children.length}
      </span>
    </div>
  );
}
