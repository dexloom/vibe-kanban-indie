import {
  Droppable,
  type DroppableProvided,
  type DroppableStateSnapshot,
} from '@hello-pangea/dnd';
import { cn } from '../../lib/cn';
import { TreeRow } from './TreeRow';
import { useDragActive, useDragCandidate } from './dragState';
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
 * separate react-arborist rows.
 *
 * Drop targeting rings: union of hello-pangea\'s `snapshot.isDraggingOver`
 * (kanban→tree) and the custom manager\'s `useDragCandidate()` (tree→tree,
 * tree→kanban). The custom manager reads `data-drop-target-id` /
 * `data-drop-target-project` attributes on the droppable wrapper to
 * compute its magnetic candidate, so we paint the same ring for both
 * source paths.
 */
export function StatusNodeRow({
  node,
  style,
}: TreeNodeRenderProps<StatusNode>) {
  const status = node.data;
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const statusDroppableId = makeStatusNodeId(status.projectId, status.statusId);
  const isCandidate = candidateId === statusDroppableId;
  return (
    <Droppable droppableId={statusDroppableId}>
      {(dropProvided: DroppableProvided, snapshot: DroppableStateSnapshot) => (
        <div
          ref={dropProvided.innerRef}
          {...dropProvided.droppableProps}
          data-drop-target-id={statusDroppableId}
          data-drop-target-project={status.projectId}
        >
          <TreeRow
            node={node}
            style={style}
            onRowClick={() => node.toggle()}
            showCaret={status.children.length > 0}
            rowClassName={cn(
              'text-xs font-medium uppercase tracking-wide text-low',
              isDragActive &&
                !snapshot.isDraggingOver &&
                !isCandidate &&
                'ring-1 ring-border-strong/40',
              isDragActive &&
                (snapshot.isDraggingOver || isCandidate) &&
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
