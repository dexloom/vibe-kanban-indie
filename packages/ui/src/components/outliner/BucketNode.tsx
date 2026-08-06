import { cn } from '../../lib/cn';
import { DIM_ROW, HOVER_ROW, TINT_ROW, tintStyle } from './layout';
import { TreeRow } from './TreeRow';
import type { BucketNode, TreeNodeRenderProps } from './types';

/**
 * Outliner bucket header row: small caret + label + child count. Visuals
 * are intentionally identical to the ADR-006 WorkspaceOutliner bucket.
 */
export function OutlinerBucketNode({
  node,
  style,
  dragHandle,
  tintColor,
  dimmed,
}: TreeNodeRenderProps<BucketNode> & {
  tintColor?: string | null;
  dimmed?: boolean;
}) {
  const bucket = node.data;
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      onRowClick={() => node.toggle()}
      rowClassName={cn(
        `text-xs font-medium uppercase tracking-wide text-low ${TINT_ROW} ${HOVER_ROW}`,
        dimmed && DIM_ROW
      )}
    >
      <div className="flex items-center gap-1">
        <span
          className="truncate"
          style={tintStyle(tintColor)}
        >
          {bucket.name}
        </span>
        <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
          {bucket.children.length}
        </span>
      </div>
    </TreeRow>
  );
}
