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
import { SOURCE_DATA_ATTRS } from './dnd';
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
  useLayoutEffect,
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
  const { onPointerDown } = useDraggable(source, { disabled: dragDisabled });
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
  // P4-E1: on mobile, the drag binding lives on the handle
  // (`DotsSixVerticalIcon`) so the card body stays scrollable by
  // swipe — the handle is the only touch target that promotes the
  // gesture into a drag. Desktop keeps whole-card binding (no scroll
  // conflict, larger drag target helps accessibility).
  const cardPointerProps =
    !isMobile && onPointerDown
      ? { onPointerDown, style: { touchAction: 'none' as const } }
      : {};
  const handlePointerProps =
    isMobile && onPointerDown
      ? { onPointerDown, style: { touchAction: 'none' as const } }
      : {};
  return (
    <Card
      className={cn(
        'p-base outline-none flex-col rounded-md border -mt-[1px] -mx-[1px] bg-surface cursor-pointer',
        (isSelected || isOpen) && 'relative z-10',
        isSelected
          ? 'ring-2 ring-accent ring-inset bg-accent/5'
          : isOpen && 'ring-2 ring-brand ring-inset',
        isDraggedSource && 'opacity-50 transition-opacity',
        className,
      )}
      {...cardPointerProps}
      {...dropTargetAttrs}
      data-dnd-card=""
      data-dnd-card-issue-id={source.issueId}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {isMobile ? (
        <div className="flex gap-half">
          <div
            className="flex items-start pt-half cursor-grab shrink-0"
            {...handlePointerProps}
          >
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
  /** Ordered ids of the issues rendered as children (same order as
   * `children`). When provided, the same-column swap preview resolves
   * source/target indices via this list instead of parsing React's
   * `Children.toArray` keys — the latter changes shape across React
   * versions (`.$` prefix is an implementation detail). */
  issueIds?: string[];
  /** Enables slot-position previews (same-column swap reorder and
   * cross-column insertion clone). Defaults to `true` for backward
   * compat. `KanbanContainer` flips this off under non-manual sort
   * modes (priority/created_at/title) where the swap COMMIT is gated
   * off but the PREVIEW used to leak through — preview and commit
   * disagreed and the user saw a live swap that snap-back'd on drop.
   * ADR-012 round-5 §17. */
  positionalReorderEnabled?: boolean;
};

export const KanbanCards = ({
  id,
  children,
  className,
  activeProjectId,
  issueIds,
  positionalReorderEnabled = true,
}: KanbanCardsProps) => {
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const candidateIndex = useDragCandidateIndex();
  const sourceIssueId = useDragSourceIssueId();
  const isSwapPreview =
    positionalReorderEnabled &&
    isDragActive &&
    candidateId !== null &&
    candidateId !== id;
  const isMovePreview =
    positionalReorderEnabled && isDragActive && candidateId === id;
  const dropTargetAttrs = useDropTarget(id, activeProjectId ?? '');
  const columnRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  // Cross-column move preview: create one dimmed clone for the target
  // column AND position it in a single layout effect. P5-E5: the
  // position step MUST run synchronously before paint so the clone
  // never paints at a stale slot for one frame between a fast-finger
  // sweep (candidateIndex changes every few px). Splitting create
  // and position into two effects — create as useEffect, position as
  // useLayoutEffect — would race the wrong way: useLayoutEffect runs
  // strictly BEFORE useEffect, so position would run first with no
  // preview to position and create would then append at the column
  // tail. The combined effect creates + positions in one synchronous
  // pass before paint. Cleanup runs on dep removal to drop the clone.
  useLayoutEffect(() => {
    const col = columnRef.current;
    if (!col) return;
    if (!isMovePreview || !sourceIssueId) {
      previewRef.current?.remove();
      previewRef.current = null;
      return;
    }
    let preview = previewRef.current;
    if (!preview) {
      // Issue ids are bare UUIDs (safe selector chars — no CSS escaping needed).
      const sourceEl = document.querySelector<HTMLElement>(
        `[data-dnd-card-issue-id="${sourceIssueId}"]`,
      );
      if (!sourceEl) return;
      preview = sourceEl.cloneNode(true) as HTMLElement;
      preview.style.opacity = '0.5';
      preview.style.pointerEvents = 'none';
      // P5-E3: strip every source data attribute via the shared
      // `SOURCE_DATA_ATTRS` list (see `dnd/sourceAttrs.ts`). The ghost in
      // `DragController` and this preview clone were stripping
      // overlapping but inconsistent subsets — the ghost knew about
      // `data-drop-target-project` and `data-drop-target-accept-kinds`,
      // this preview didn't. A bare preview with the wrong subset
      // would be picked up by `collectTargets` if the controller's
      // per-frame DOM re-query ever noticed the inherited project /
      // accept-kinds. Single source of truth eliminates the drift.
      for (const attr of SOURCE_DATA_ATTRS) {
        preview.removeAttribute(attr);
      }
      previewRef.current = preview;
      col.appendChild(preview);
    }
    // Snapshot real children without the preview itself; otherwise moving
    // from an earlier slot to a later one would make the live clone skew the
    // insertion index by one.
    const kids = Array.from(col.children).filter((child) => child !== preview);
    const insertAt = candidateIndex ?? kids.length;
    const anchor = kids[insertAt] ?? null;
    col.insertBefore(preview, anchor);
  }, [isMovePreview, sourceIssueId, candidateIndex, id]);

  const displayChildren = useMemo(() => {
    if (!isSwapPreview || !sourceIssueId) return children;
    const arr = Children.toArray(children);
    let srcIdx: number;
    let dstIdx: number;
    if (issueIds && issueIds.length === arr.length) {
      // Authoritative path: the caller passes the ids in render order,
      // so we can resolve source/target indices directly without
      // depending on React's internal `.$` key prefix.
      srcIdx = issueIds.indexOf(sourceIssueId);
      dstIdx = issueIds.indexOf(candidateId ?? '');
    } else {
      const stripKeyPrefix = (k: string): string => k.replace(/^\.\$/, '');
      srcIdx = arr.findIndex(
        (c) =>
          stripKeyPrefix(String((c as { key?: string | null }).key ?? '')) ===
          sourceIssueId,
      );
      dstIdx = arr.findIndex(
        (c) =>
          stripKeyPrefix(String((c as { key?: string | null }).key ?? '')) ===
          candidateId,
      );
    }
    if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return children;
    const a = arr[srcIdx];
    const b = arr[dstIdx];
    if (!a || !b) return children;
    arr[srcIdx] = b;
    arr[dstIdx] = a;
    return arr;
  }, [children, isSwapPreview, sourceIssueId, candidateId, issueIds]);
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
