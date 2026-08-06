import { cn } from '../../lib/cn';
import { DIM_ROW, HOVER_ROW, TINT_ROW, tintStyle } from './layout';
import { TreeRow } from './TreeRow';
import { useDragActive, useDragCandidate } from './dragState';
import { useDropTarget } from '../dnd';
import {
  makeStatusNodeId,
  type StatusNode,
  type TreeNodeRenderProps,
} from './types';

/**
 * Status column header: name, color dot (after name), and direct child count.
 *
 * Tagged as a drop target via `useDropTarget` (id format:
 * `<projectId>:status:<statusId>`). Drops land on the status header
 * regardless of collapse state. The custom drag controller reads
 * `data-drop-target-id` / `data-drop-target-project` /
 * `data-drop-target-accept-kinds` attributes to compute its magnetic
 * candidate, so all valid targets get a rounded fill AND the single
 * candidate gets a stronger brand fill in one place.
 */
export function StatusNodeRow({
  node,
  style,
  tintColor,
  dimmed,
}: TreeNodeRenderProps<StatusNode> & {
  tintColor?: string | null;
  dimmed?: boolean;
}) {
  const status = node.data;
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const statusDroppableId = makeStatusNodeId(status.projectId, status.statusId);
  const isCandidate = candidateId === statusDroppableId;
  const dropTargetAttrs = useDropTarget(statusDroppableId, status.projectId);
  return (
    <div className="h-full" {...dropTargetAttrs}>
      <TreeRow
        node={node}
        style={style}
        showCaret={status.children.length > 0}
        rowClassName={cn(
          `text-xs font-medium uppercase tracking-wide text-low ${TINT_ROW} ${HOVER_ROW}`,
          dimmed && DIM_ROW,
          isDragActive && !isCandidate && 'rounded-sm bg-tertiary/40',
          isDragActive && isCandidate && 'rounded-sm bg-brand/20'
        )}
      >
        <div className="flex items-center gap-1">
          <span
            className="truncate"
            style={tintStyle(tintColor)}
          >
            {status.name}
          </span>
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
    </div>
  );
}
