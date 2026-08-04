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
  useDragCandidateIndex,
  useDragSourceIssueId,
} from './outliner/dragState';
import { useDraggable, useDropTarget } from './dnd';
import type { DragSource } from './dnd';

/** Source shape specific to kanban card drags; narrows `DragSource` for
 * the props below so card-only code reaches `.issueId` without a runtime
 * guard. Project-row drags are bound via the same `DragSource` union but
 * flow through a separate tree-node renderer (see `treeNodes.tsx`). */
type IssueMoveSource = Extract<DragSource, { kind: 'issue-move' }>;
import {
  Children,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
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
// Kanban Card (Draggable + Drop target via shared dnd context)
// =============================================================================

export type KanbanCardProps = {
  source: IssueMoveSource;
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
  // Dim the source card while a drag is in flight; the source card may
  // be in a column that has no live candidate (the pointer is over a
  // different column), so the source id lives in its own context
  // (`DragSourceContext`), not on `DragCandidateContext`.
  const dragSourceIssueId = useDragSourceIssueId();
  const isDraggedSource = dragSourceIssueId === source.issueId;
  // Cards are also drop targets: dropping issue X on issue Y in the
  // SAME column swaps their status columns. The drop target carries
  // the issue's id (resolver → issue-swap) and the status it sits in
  // (controller → same-column filter).
  const dropTargetAttrs = useDropTarget(source.issueId, source.projectId, {
    acceptKinds: ['issue-move'],
    statusId: source.statusId,
  });
  return (
    <Card
      className={cn(
        'p-base outline-none flex-col rounded-md border -mt-[1px] -mx-[1px] bg-surface cursor-pointer',
        isSelected
          ? 'ring-2 ring-accent ring-inset bg-accent/5'
          : isOpen && 'ring-2 ring-brand ring-inset',
        isDraggedSource && 'opacity-50 transition-opacity',
        className
      )}
      {...(onMouseDown ? { onMouseDown } : {})}
      {...dropTargetAttrs}
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
  const candidateIndex = useDragCandidateIndex();
  const sourceIssueId = useDragSourceIssueId();
  const isSwapPreview =
    isDragActive && candidateId !== null && candidateId !== id;
  const isMovePreview = isDragActive && candidateId === id;
  const dropTargetAttrs = useDropTarget(id, activeProjectId ?? '');
  const columnRef = useRef<HTMLDivElement | null>(null);
  // Cross-column move preview: append a dimmed clone of the dragged card at
  // the insertion slot of the target column (index = how many cards sit
  // above it; computed against the controller's promote-time snapshot), so
  // the user sees exactly what will land. Same imperative-clone pattern as
  // the drag ghost (transient, removed on preview end). The source card
  // stays in its original column (dimmed).
  useEffect(() => {
    if (!isMovePreview || !sourceIssueId || !columnRef.current) return;
    // Issue ids are bare UUIDs (safe selector chars — no CSS escaping needed).
    const sourceEl = document.querySelector<HTMLElement>(
      `[data-dnd-card-issue-id="${sourceIssueId}"]`
    );
    if (!sourceEl) return;
    const preview = sourceEl.cloneNode(true) as HTMLElement;
    preview.style.opacity = '0.5';
    preview.style.pointerEvents = 'none';
    preview.removeAttribute('data-dnd-card');
    preview.removeAttribute('data-drop-target-id');
    const col = columnRef.current;
    const insertAt = candidateIndex ?? col.children.length;
    const anchor = col.children[insertAt] ?? null;
    col.insertBefore(preview, anchor);
    return () => preview.remove();
  }, [isMovePreview, sourceIssueId, candidateIndex]);

  const displayChildren = useMemo(() => {
    if (!isSwapPreview || !sourceIssueId) return children;
    const arr = Children.toArray(children);
    const stripKeyPrefix = (k: string): string => k.replace(/^\.\$/, '');
    const srcIdx = arr.findIndex(
      (c) =>
        stripKeyPrefix(String((c as { key?: string | null }).key ?? '')) ===
        sourceIssueId
    );
    const dstIdx = arr.findIndex(
      (c) =>
        stripKeyPrefix(String((c as { key?: string | null }).key ?? '')) ===
        candidateId
    );
    if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return children;
    const a = arr[srcIdx];
    const b = arr[dstIdx];
    if (!a || !b) return children;
    arr[srcIdx] = b;
    arr[dstIdx] = a;
    return arr;
  }, [children, isSwapPreview, sourceIssueId, candidateId]);
  return (
    <div
      ref={columnRef}
      className={cn('flex flex-1 flex-col transition-colors', className)}
      {...dropTargetAttrs}
    >
      {displayChildren}
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
        props.className
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
        className
      )}
    >
      {children}
    </div>
  );
};
