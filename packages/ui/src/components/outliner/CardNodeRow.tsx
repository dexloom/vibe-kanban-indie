import {
  Droppable,
  Draggable,
  type DraggableProvided,
  type DraggableStateSnapshot,
  type DroppableProvided,
} from '@hello-pangea/dnd';
import { type MutableRefObject, type Ref } from 'react';
import { cn } from '../../lib/cn';
import { TreeRow } from './TreeRow';
import type { CardNode, TreeNodeRenderProps } from './types';

interface CardNodeRowProps extends TreeNodeRenderProps<CardNode> {
  activeIssueId?: string | null;
  /** Disables drag while the kanban's bulk-select mode is on (PLAN §7.5).
   * Defaults to `false` so the prop is optional in tests / non-DnD contexts. */
  isMultiSelectActive?: boolean;
}

/**
 * Compact issue title row. Cards with sub-issues expose an isolated caret.
 *
 * Cross-surface DnD wrapping (PLAN §6.3, §6.5):
 *  - Outer `<Droppable>` uses the bare issue.id as droppableId. Each card
 *    gets its own droppable, satisfying hello-pangea's invariant that a
 *    `<Draggable>` must have a `<Droppable>` React ancestor (react-arborist
 *    makes each row a sibling, not a DOM child of the status row's div).
 *    `resolveDragEnd` distinguishes card droppables from kanban-column
 *    droppables by `issuesById.has(id)` lookup.
 *  - Inner `<Draggable>` carries the canonical `issue:<uuid>` draggableId
 *    consumed by the cross-surface resolver in `SharedAppLayout`.
 *  - `outerRef` merges the renderer's react-arborist `dragHandle` ref with
 *    hello-pangea's `provided.innerRef` so both libraries anchor to the
 *    same DOM node. `outerProps` spreads `provided.draggableProps` +
 *    `provided.dragHandleProps` onto the row.
 *  - `isDragDisabled={isMultiSelectActive}` mirrors `KanbanCard.dragDisabled`.
 */
export function CardNodeRow({
  node,
  style,
  dragHandle,
  activeIssueId,
  isMultiSelectActive = false,
}: CardNodeRowProps) {
  const issue = node.data.issue;
  const isActive = issue.id === activeIssueId;
  const hasChildren = node.data.children.length > 0;

  // hello-pangea requires a numeric `index` per draggable. Each card lives
  // in its own Droppable (no sibling comparison needed), and cross-status
  // moves never use intra-status ordering — pass 0.
  const draggableIndex = 0;

  return (
    <Droppable droppableId={issue.id}>
      {(dropProvided: DroppableProvided) => (
        <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
          <Draggable
            draggableId={`issue:${issue.id}`}
            index={draggableIndex}
            isDragDisabled={isMultiSelectActive}
          >
            {(
              dragProvided: DraggableProvided,
              snapshot: DraggableStateSnapshot
            ) => {
              const setRefs = (el: HTMLDivElement | null) => {
                dragProvided.innerRef(el);
                if (typeof dragHandle === 'function') {
                  dragHandle(el as HTMLDivElement);
                } else if (dragHandle && typeof dragHandle === 'object') {
                  (
                    dragHandle as MutableRefObject<HTMLDivElement | null>
                  ).current = el;
                }
              };

              return (
                <TreeRow
                  node={node}
                  style={style}
                  isActive={isActive}
                  showCaret={hasChildren}
                  rowClassName={cn(
                    'text-sm leading-tight',
                    isActive
                      ? 'text-high font-semibold'
                      : 'text-normal font-light hover:text-high',
                    snapshot.isDragging && 'cursor-grabbing shadow-lg'
                  )}
                  outerRef={setRefs as unknown as Ref<HTMLDivElement>}
                  outerProps={{
                    ...dragProvided.draggableProps,
                    ...dragProvided.dragHandleProps,
                  }}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="truncate">{issue.title}</span>
                  </div>
                </TreeRow>
              );
            }}
          </Draggable>
          {dropProvided.placeholder}
        </div>
      )}
    </Droppable>
  );
}
