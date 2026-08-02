import { ListMagnifyingGlassIcon, CaretRightIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { ToolStatusDot, type ToolStatusLike } from './ToolStatusDot';

export interface AggregatedEntry {
  summary: string;
  status?: ToolStatusLike;
  expansionKey: string;
  content?: string;
  command?: string;
}

interface ChatAggregatedToolEntriesProps {
  entries: AggregatedEntry[];
  expanded: boolean;
  isHovered: boolean;
  onToggle: () => void;
  onHoverChange: (hovered: boolean) => void;
  /** Label to show before the count (e.g., "Read", "Search") */
  label: string;
  /** Unit label for counting (e.g., "file", "URL") - will be pluralized automatically */
  unit: string;
  icon?: React.ElementType;
  className?: string;
  onViewContent?: (index: number) => void;
}

export function ChatAggregatedToolEntries({
  entries,
  expanded,
  isHovered,
  onToggle,
  onHoverChange,
  label,
  unit,
  icon: Icon = ListMagnifyingGlassIcon,
  className,
  onViewContent,
}: ChatAggregatedToolEntriesProps) {
  if (entries.length === 0) return null;

  // Get the worst status among all entries for the aggregate indicator
  const aggregateStatus = entries.reduce<ToolStatusLike | undefined>(
    (worst, entry) => {
      if (!entry.status) return worst;
      if (!worst) return entry.status;

      // Priority: failed > denied > timed_out > pending_approval > created > success
      const statusPriority: Record<string, number> = {
        failed: 6,
        denied: 5,
        timed_out: 4,
        pending_approval: 3,
        created: 2,
        success: 1,
      };

      const worstPriority = statusPriority[worst.status] || 0;
      const currentPriority = statusPriority[entry.status.status] || 0;

      return currentPriority > worstPriority ? entry.status : worst;
    },
    undefined
  );

  // Always render the same header layout regardless of entries.length so the
  // boundary crossing 1 → 2 during streaming (each new file_read / search the
  // subagent makes re-aggregates here) doesn't swap the DOM subtree. The
  // `min-w-0 flex-1` on the text span lets the flex row truncate the text
  // instead of letting the growing count push siblings out, which was a
  // source of layout shifts as the count grew mid-stream.
  const countLabel = `${entries.length} ${entries.length === 1 ? unit : `${unit}s`}`;

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Header row - clickable to expand/collapse */}
      <div
        className="flex items-center gap-base text-sm text-low cursor-pointer group"
        onClick={onToggle}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        role="button"
        aria-expanded={expanded}
        data-scroll-anchor-target=""
      >
        <span className="relative shrink-0 pt-0.5">
          {isHovered ? (
            <CaretRightIcon
              className={cn(
                'size-icon-base transition-transform duration-150',
                expanded && 'rotate-90'
              )}
            />
          ) : (
            <Icon className="size-icon-base" />
          )}
          {aggregateStatus && (
            <ToolStatusDot
              status={aggregateStatus}
              className="absolute -bottom-0.5 -left-0.5"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {label} · {countLabel}
        </span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="ml-6 pt-1 flex flex-col gap-0.5">
          {entries.map((entry, index) => (
            <div
              key={entry.expansionKey}
              className={cn(
                'flex items-center gap-base text-sm text-low pl-base',
                onViewContent && 'cursor-pointer hover:text-normal'
              )}
              onClick={onViewContent ? () => onViewContent(index) : undefined}
              role={onViewContent ? 'button' : undefined}
            >
              <span className="relative shrink-0 pt-0.5">
                <Icon className="size-icon-base" />
                {entry.status && (
                  <ToolStatusDot
                    status={entry.status}
                    className="absolute -bottom-0.5 -left-0.5"
                  />
                )}
              </span>
              <span className="truncate">{entry.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
