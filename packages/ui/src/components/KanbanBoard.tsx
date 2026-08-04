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
  useDragSourceIssueId,
} from './outliner/dragState';
import { useDraggable, useDropTarget } from './dnd';
import { adjustInsertionIndex } from './dnd/geometry';
import type { DragSource } from './dnd';

/** Source shape specific to kanban card drags; narrows `DragSource` for
 * the props below so card-only code reaches `.issueId` without a runtime
 * guard. Project-row drags are bound via the same `DragSource` union but
 * flow through a separate tree-node renderer (see `treeNodes.tsx`). */
type IssueMoveSource = Extract<DragSource, { kind: 'issue-move' }>;
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
  // be in a column that has no live insertion (the pointer is over a
  // different column), so the source id lives in its own context
  // (`DragSourceContext`), not on `DragInsertionContext`.
  const dragSourceIssueId = useDragSourceIssueId();
  const isDraggedSource = dragSourceIssueId === source.issueId;
  return (
    <Card
      className={cn(
        'p-base outline-none flex-col rounded-md border -mt-[1px] -mx-[1px] bg-surface cursor-pointer',
        isSelected
          ? 'ring-2 ring-accent ring-inset bg-accent/5'
          : isOpen && 'ring-2 ring-brand ring-inset',
        isDraggedSource && 'opacity-50 transition-opacity',
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
  /** When false, same-column drags (where the source card already lives in
   * this column) suppress the insertion indicator — the controller no-ops
   * the move in non-positional sort modes so the indicator would be a lie. */
  positionalReorderEnabled?: boolean;
};

/** Fallback placeholder height when the column has no cards to measure
 * (empty column). Matches the typical card visual height in this app. */
const FALLBACK_CARD_HEIGHT_PX = 60;

export const KanbanCards = ({
  id,
  children,
  className,
  activeProjectId,
  positionalReorderEnabled = true,
}: KanbanCardsProps) => {
  const isDragActive = useDragActive();
  const candidateId = useDragCandidate();
  const isCustomCandidate = isDragActive && candidateId === id;
  const dropTargetAttrs = useDropTarget(id, activeProjectId ?? '');
  const insertion = useDragInsertion();
  // Container ref + effect-based source-card index + placeholder-height
  // lookup. The render pass would otherwise see `containerRef.current
  // === null` (refs are set during commit, not render) and resolve the
  // source index to -1, placing the indicator one slot off. The effect
  // runs after commit and stashes the resolved index in state; the next
  // render reads the live value. Skipping the useState-as-ref callback
  // avoids a re-render per commit (StrictMode would triple-fire it).
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [sourceFullIndex, setSourceFullIndex] = React.useState(-1);
  const [cardHeightPx, setCardHeightPx] = React.useState(
    FALLBACK_CARD_HEIGHT_PX,
  );
  // `React.Children.toArray` returns a fresh array every call — keep a
  // memoized view so downstream slice / array operations don't churn
  // when the children prop is referentially stable.
  const cardChildren = React.useMemo(
    () => React.Children.toArray(children),
    [children],
  );
  // `useLayoutEffect` instead of `useEffect`: the DOM query + state set
  // must run synchronously BEFORE paint, otherwise the first paint
  // after a column entry sees `sourceFullIndex === -1` and the
  // indicator lands one slot off for one frame. The placeholder-height
  // measurement shares this same query (one DOM pass per effect run).
  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!insertion || insertion.targetId !== id) {
      setSourceFullIndex(-1);
      setCardHeightPx(FALLBACK_CARD_HEIGHT_PX);
      return;
    }
    if (!el) {
      setSourceFullIndex(-1);
      setCardHeightPx(FALLBACK_CARD_HEIGHT_PX);
      return;
    }
    // Locate the dragged source card by DOM order, not React key. React's
    // `Children.toArray` rewrites every key with an internal `.$` prefix,
    // so matching against `insertion.sourceIssueId` directly never finds
    // a hit and the indicator would render one slot off. The container's
    // `[data-dnd-card]` children are in 1:1 order with `cardChildren`,
    // and each card carries `data-dnd-card-issue-id` for an exact lookup.
    const cards = Array.from(
      el.querySelectorAll<HTMLElement>('[data-dnd-card]'),
    );
    // First card's height = the placeholder slot height. Empty column
    // falls back to a constant. `getBoundingClientRect` is the live
    // layout height (border + padding + content), no margins.
    setCardHeightPx(
      cards[0]
        ? cards[0].getBoundingClientRect().height
        : FALLBACK_CARD_HEIGHT_PX,
    );
    if (insertion.sourceIssueId == null) {
      setSourceFullIndex(-1);
      return;
    }
    const idx = cards.findIndex(
      (card) => card.dataset.dndCardIssueId === insertion.sourceIssueId,
    );
    setSourceFullIndex(idx);
  }, [insertion, id]);
  const fullIndex = adjustInsertionIndex(
    insertion?.index ?? 0,
    sourceFullIndex >= 0 ? sourceFullIndex : null,
  );
  // Non-positional sort → any insertion would be re-sorted away by the
  // next shape sync, so the indicator would lie about the landing slot.
  // Suppress for every column insertion in that mode.
  const showInsertion = insertion?.targetId === id && positionalReorderEnabled;
  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-1 flex-col transition-colors',
        isCustomCandidate && 'bg-brand/5',
        className,
      )}
      {...dropTargetAttrs}
    >
      {showInsertion ? (
        <>
          {cardChildren.slice(0, fullIndex)}
          <div
            data-dnd-insertion-indicator=""
            className="shrink-0 rounded-md border-2 border-dashed border-brand/60 bg-brand/5 mx-2"
            style={{ height: `${cardHeightPx}px` }}
          />
          {cardChildren.slice(fullIndex)}
        </>
      ) : (
        children
      )}
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
