import {
  Droppable,
  type DroppableProvided,
  type DroppableStateSnapshot,
} from '@hello-pangea/dnd';
import { cn } from '../../lib/cn';
import { TreeRow } from './TreeRow';
import { useDragActive } from './dragState';
import {
  makeStatusNodeId,
  type StatusNode,
  type TreeNodeRenderProps,
} from './types';

/**
 * Status column header: name, color dot (after name), and direct child count.
 *
 * Wrapped in a hello-pangea `<Droppable>` with `droppableId` =
 * `<projectId>:status:<statusId>` (PLAN §5). The droppable wraps the row
 * itself — drops land on the status header regardless of collapse state
 * (PLAN §6.5). When the status has children, they're rendered in
 * separate react-arborist rows each with their own per-card Droppable.
 *
 * During a drag the row is a drop target: `useDragActive` outlines every
 * status (subtle ring) and hello-pangea's `snapshot.isDraggingOver` fills
 * the one under the pointer (solid brand ring + tint) — drop lands there.
 */
export function StatusNodeRow({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<StatusNode>) {
  const status = node.data;
  const isDragActive = useDragActive();
  return (
    <Droppable
      droppableId={makeStatusNodeId(status.projectId, status.statusId)}
    >
      {(
        dropProvided: DroppableProvided,
        snapshot: DroppableStateSnapshot,
      ) => (
        <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
          <TreeRow
            node={node}
            style={style}
            dragHandle={dragHandle}
            onRowClick={() => node.toggle()}
            showCaret={status.children.length > 0}
            rowClassName={cn(
              'text-xs font-medium uppercase tracking-wide text-low',
              isDragActive &&
                !snapshot.isDraggingOver &&
                'ring-1 ring-border-strong/40',
              isDragActive &&
                snapshot.isDraggingOver &&
                'ring-2 ring-brand bg-brand/10',
            )}
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
          {dropProvided.placeholder}
        </div>
      )}
    </Droppable>
  );
}
