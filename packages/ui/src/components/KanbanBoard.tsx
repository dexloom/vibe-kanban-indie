'use client';

import { Card } from './Card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './RadixTooltip';
import { cn } from '../lib/cn';
import {
  useDragActive,
  useDragCandidate,
  useDragInsertion,
} from './outliner/dragState';
import { useDraggable, useDropTarget } from './dnd';
import { adjustInsertionIndex } from './dnd/geometry';
import type { DragSource } from './dnd';
import React, {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DotsSixVerticalIcon, PlusIcon } from '@phosphor-icons/react';
import { Button } from './Button';

// Re-exported so existing imports keep compiling — `RemoteProjectsSettingsSection`
// imports `DropResult` from `@vibe/ui/components/KanbanBoard`. The list-view
// adapter in `KanbanContainer` retains hello-pangea for its own
// `DragDropContext`. The cross-surface path (this file) no longer depends
// on the hello-pangea runtime types.
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
// Kanban Board (Container)
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
// Kanban Card (Draggable via shared dnd context)
// =============================================================================

export type KanbanCardProps = {
  source: DragSource;
  children?: ReactNode;
  className?: string;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent) => void;
  isOpen?: boolean;
  isSelected?: boolean;
  dragDisabled?: boolean;
  isMobile?: boolean;
  name?: string;
};

export const KanbanCard = ({
  source,
  children,
  className,
  onClick,
  tabIndex,
  onKeyDown,
  isOpen,
  isSelected,
  dragDisabled = false,
  isMobile,
  name,
}: KanbanCardProps) => {
  const { onMouseDown } = useDraggable(source, { disabled: dragDisabled });
  return (
    <Card
      className={cn(
        'p-base outline-none flex-col rounded-md border -mt-[1px] -mx-[1px] bg-surface',
        isSelected
          ? 'ring-2 ring-accent ring-inset bg-accent/5'
          : isOpen && 'ring-2 ring-brand ring-inset',
        className,
      )}
      {...(onMouseDown ? { onMouseDown } : {})}
      data-dnd-card=""
      data-dnd-card-issue-id={source.issueId}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {isMobile ? (
        <div className="flex gap-half">
          <div className="flex items-start pt-half cursor-grab shrink-0">
            <DotsSixVerticalIcon
              className="size-icon-xs text-low"
              weight="bold"
            />
          </div>
          <div className="flex-1 min-w-0">
            {children ?? <p className="m-0 font-medium text-sm">{name}</p>}
          </div>
        </div>
      ) : (
        (children ?? <p className="m-0 font-medium text-sm">{name}</p>)
      )}
    </Card>
  );
};

// =============================================================================
// Kanban Cards Container (Drop target via shared dnd context)
// =============================================================================

export type KanbanCardsProps = {
  id: string;
  children: ReactNode;
  className?: string;
  /** Project id this column belongs to. Custom drag controller reads
   * `data-drop-target-project` so it skips targets from other projects. */
  activeProjectId?: string | null;
};

export const KanbanCards = ({
  id,
  children,
  className,
  activeProjectId,
}: KanbanCardsProps) => {
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const isCustomCandidate = isDragActive && candidateId === id;
  const dropTargetAttrs = useDropTarget(id, activeProjectId ?? '');
  const insertion = useDragInsertion();
  const showInsertion = insertion?.targetId === id;
  const cardChildren = React.Children.toArray(children);
  // The drop index is computed against the column's cards EXCLUDING the
  // dragged source (which is on its way out). When the source sits in this
  // column, translate the slot to the full children array so the indicator
  // lands where the card will actually end up.
  const sourceFullIndex =
    insertion?.sourceIssueId != null
      ? cardChildren.findIndex(
          (child) =>
            (child as React.ReactElement).key === insertion.sourceIssueId,
        )
      : -1;
  const fullIndex = adjustInsertionIndex(
    insertion?.index ?? 0,
    sourceFullIndex >= 0 ? sourceFullIndex : null,
  );
  const renderedChildren = showInsertion
    ? [
        ...cardChildren.flatMap((child, i) =>
          i === fullIndex
            ? [
                <div
                  key={'drop-indicator-' + i}
                  className="h-0.5 shrink-0 rounded bg-brand/80 mx-2 my-0.5"
                />,
                child,
              ]
            : [child],
        ),
        ...(fullIndex >= cardChildren.length
          ? [
              <div
                key={'drop-indicator-' + fullIndex}
                className="h-0.5 shrink-0 rounded bg-brand/80 mx-2 my-0.5"
              />,
            ]
          : []),
      ]
    : children;
  return (
    <div
      className={cn(
        'flex flex-1 flex-col transition-colors',
        isCustomCandidate && 'bg-brand/5',
        className,
      )}
      {...dropTargetAttrs}
    >
      {renderedChildren}
    </div>
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
// Kanban Provider (layout-only grid)
// =============================================================================
//
// The cross-surface drag system is now owned by `<DragProvider>` (mounted
// above the tree + kanban in the layout). Cards / columns opt into drag
// behaviour via the `useDraggable` / `useDropTarget` hooks. `KanbanProvider`
// stays as a layout-only grid that lays the columns out.

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
