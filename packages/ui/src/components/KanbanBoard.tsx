'use client';

import { Card } from './Card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './RadixTooltip';
import { cn } from '../lib/cn';
import { useDragActive, useDragCandidate } from './outliner/dragState';
import {
  Droppable,
  Draggable,
  type DraggableProvided,
  type DraggableStateSnapshot,
  type DroppableProvided,
  type DroppableStateSnapshot,
} from '@hello-pangea/dnd';
import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DotsSixVerticalIcon, PlusIcon } from '@phosphor-icons/react';
import { Button } from './Button';

// Re-exported so existing imports keep compiling — leaf components below use
// Droppable/Draggable directly, and downstream consumers reference the type
// via `@vibe/ui`.
export type { DropResult } from '@hello-pangea/dnd';

export type Status = {
  id: string;
  name: string;
  color: string;
};

export type Feature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: Status;
};

// =============================================================================
// Kanban Board (Droppable Column)
// =============================================================================

export type KanbanBoardProps = {
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ children, className }: KanbanBoardProps) => {
  return (
    <div className={cn('flex flex-col min-h-40', className)}>{children}</div>
  );
};

// =============================================================================
// Kanban Card (Draggable)
// =============================================================================

export type KanbanCardProps = Pick<Feature, 'id' | 'name'> & {
  index: number;
  children?: ReactNode;
  className?: string;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  forwardedRef?: Ref<HTMLDivElement>;
  onKeyDown?: (e: KeyboardEvent) => void;
  isOpen?: boolean;
  isSelected?: boolean;
  dragDisabled?: boolean;
  isMobile?: boolean;
};

export const KanbanCard = ({
  id,
  name,
  index,
  children,
  className,
  onClick,
  tabIndex,
  forwardedRef,
  onKeyDown,
  isOpen,
  isSelected,
  dragDisabled = false,
  isMobile,
}: KanbanCardProps) => {
  return (
    <Draggable draggableId={id} index={index} isDragDisabled={dragDisabled}>
      {(provided: DraggableProvided, snapshot: DraggableStateSnapshot) => {
        // Combine DnD ref and forwarded ref
        const setRefs = (node: HTMLDivElement | null) => {
          provided.innerRef(node);
          if (typeof forwardedRef === 'function') {
            forwardedRef(node);
          } else if (forwardedRef && typeof forwardedRef === 'object') {
            (forwardedRef as MutableRefObject<HTMLDivElement | null>).current =
              node;
          }
        };

        return (
          <Card
            className={cn(
              'p-base outline-none flex-col rounded-md border -mt-[1px] -mx-[1px] bg-surface',
              snapshot.isDragging && 'cursor-grabbing shadow-lg',
              isSelected
                ? 'ring-2 ring-accent ring-inset bg-accent/5'
                : isOpen && 'ring-2 ring-brand ring-inset',
              className,
            )}
            ref={setRefs}
            {...provided.draggableProps}
            {...(isMobile ? {} : provided.dragHandleProps)}
            tabIndex={tabIndex}
            onClick={
              isMobile
                ? (e) => {
                    if (!snapshot.isDragging) onClick?.(e);
                  }
                : undefined
            }
            onMouseUp={
              !isMobile
                ? (e) => {
                    if (e.button === 0 && !snapshot.isDragging) {
                      onClick?.(e);
                    }
                  }
                : undefined
            }
            onKeyDown={onKeyDown}
          >
            {isMobile ? (
              <div className="flex gap-half">
                <div
                  {...provided.dragHandleProps}
                  className="flex items-start pt-half cursor-grab shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DotsSixVerticalIcon
                    className="size-icon-xs text-low"
                    weight="bold"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  {children ?? (
                    <p className="m-0 font-medium text-sm">{name}</p>
                  )}
                </div>
              </div>
            ) : (
              (children ?? <p className="m-0 font-medium text-sm">{name}</p>)
            )}
          </Card>
        );
      }}
    </Draggable>
  );
};

// =============================================================================
// Kanban Cards Container
// =============================================================================

export type KanbanCardsProps = {
  id: string;
  children: ReactNode;
  className?: string;
  /**
   * Project id this column belongs to. Read by the custom tree-drag
   * manager via `data-drop-target-project` so it skips targets from
   * other projects. Optional — when absent the column is invisible to
   * the custom manager (hello-pangea kanban-internal still works).
   */
  activeProjectId?: string | null;
};

export const KanbanCards = ({
  id,
  children,
  className,
  activeProjectId,
}: KanbanCardsProps) => {
  // Custom manager candidate + hello-pangea snapshot union for the
  // solid ring. `isCustomCandidate` flips on when the user is dragging a
  // tree card and the manager has resolved this column as the magnetic
  // target.
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const isCustomCandidate = isDragActive && candidateId === id;
  return (
    <Droppable droppableId={id}>
      {(provided: DroppableProvided, snapshot: DroppableStateSnapshot) => (
        <div
          className={cn(
            'flex flex-1 flex-col transition-colors',
            isCustomCandidate && 'bg-brand/5',
            className,
          )}
          ref={provided.innerRef}
          {...provided.droppableProps}
          data-drop-target-id={id}
          data-drop-target-project={activeProjectId ?? ''}
        >
          {children}
          {provided.placeholder}
          {void snapshot /* keep snapshot referenced for tree-shake */}
        </div>
      )}
    </Droppable>
  );
};

// =============================================================================
// Kanban Header
// =============================================================================

export type KanbanHeaderProps =
  | {
      children: ReactNode;
    }
  | {
      name: Status['name'];
      color: Status['color'];
      className?: string;
      onAddTask?: () => void;
    };

export const KanbanHeader = (props: KanbanHeaderProps) => {
  const { t } = useTranslation('tasks');

  if ('children' in props) {
    return props.children;
  }

  return (
    <Card
      className={cn(
        'sticky top-0 z-20 flex shrink-0 items-center gap-base p-base flex gap-base',
        'bg-background',
        props.className,
      )}
      style={{
        backgroundImage: `linear-gradient(hsl(var(${props.color}) / 0.03), hsl(var(${props.color}) / 0.03))`,
      }}
    >
      <span className="flex-1 flex items-center gap-base">
        <div
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: `hsl(var(${props.color}))` }}
        />

        <p className="m-0 text-sm">{props.name}</p>
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className="m-0 p-0 h-0 text-foreground/50 hover:text-foreground"
              onClick={props.onAddTask}
              aria-label={t('actions.addTask')}
            >
              <PlusIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('actions.addTask')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Card>
  );
};

// =============================================================================
// Kanban Provider (layout-only — DragDropContext lives in SharedAppLayout)
// =============================================================================
//
// `DragDropContext` was lifted to `SharedAppLayout` (PLAN §6.1) so a single
// context spans the sidebar tree AND the kanban board. `KanbanProvider` here
// stays for its layout-only grid; the leaf `<Draggable>`/`<Droppable>`
// components below connect to the nearest ancestor `DragDropContext`, so they
// keep working unchanged.

export type KanbanProviderProps = {
  children: ReactNode;
  className?: string;
};

export const KanbanProvider = ({
  children,
  className,
}: KanbanProviderProps) => {
  return (
    <div
      className={cn(
        'inline-grid grid-flow-col auto-cols-[minmax(200px,400px)] divide-x border-x items-stretch min-h-full',
        className,
      )}
    >
      {children}
    </div>
  );
};
