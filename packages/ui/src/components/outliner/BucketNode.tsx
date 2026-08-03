import type { BucketNode, TreeNodeRenderProps } from './types';
import { TreeCaretRow } from './TreeCaretRow';

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
    <TreeCaretRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      className="text-xs font-medium uppercase tracking-wide text-low"
    >
      <span className="truncate">{bucket.name}</span>
      <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
        {bucket.children.length}
      </span>
    </TreeCaretRow>
  );
}
