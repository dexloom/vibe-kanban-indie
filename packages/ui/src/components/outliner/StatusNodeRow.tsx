import { TreeRow } from './TreeRow';
import type { StatusNode, TreeNodeRenderProps } from './types';

/** Status column header: name, color dot (after name), and direct child count. */
export function StatusNodeRow({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<StatusNode>) {
  const status = node.data;
  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      onRowClick={() => node.toggle()}
      showCaret={status.children.length > 0}
      rowClassName="text-xs font-medium uppercase tracking-wide text-low"
    >
      <div className="flex items-center gap-1">
        <span className="truncate">{status.name}</span>
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: `hsl(${status.color})` }}
        />
        <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
          {status.children.length}
        </span>
      </div>
    </TreeRow>
  );
}