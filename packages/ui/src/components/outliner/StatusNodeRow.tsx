import { TreeCaretRow } from './TreeCaretRow';
import type { StatusNode, TreeNodeRenderProps } from './types';

/** Status column header: color dot, name, and direct child count. */
export function StatusNodeRow({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<StatusNode>) {
  const status = node.data;

  return (
    <TreeCaretRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      className="text-xs font-medium uppercase tracking-wide text-low"
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `hsl(${status.color})` }}
      />
      <span className="truncate">{status.name}</span>
      <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
        {status.children.length}
      </span>
    </TreeCaretRow>
  );
}
