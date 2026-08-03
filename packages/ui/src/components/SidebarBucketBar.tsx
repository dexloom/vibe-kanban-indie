import { useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import {
  compareWorkspaceDashboardRecency,
  isWorkspaceIdle,
  isWorkspaceNeedsAttention,
  isWorkspaceRunning,
} from '../lib/workspaceStatus';
import {
  BAR_BUCKETS,
  BAR_BUCKET_ORDER,
  type BarBucketId,
  type BarBucketMeta,
} from '../lib/workspaceBuckets';
import { cn } from '../lib/cn';
import { CountBadge } from './CountBadge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { WorkspaceActivityText } from './WorkspaceActivityText';
import {
  formatRelativeElapsed,
  type OutlinerWorkspace,
} from './outliner/types';

interface SidebarBucketBarProps {
  /** All active (non-archived) workspaces. */
  workspaces: readonly OutlinerWorkspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  className?: string;
}

const BUCKET_PREDICATE: Record<BarBucketId, (w: OutlinerWorkspace) => boolean> =
  {
    attention: isWorkspaceNeedsAttention,
    running: isWorkspaceRunning,
    idle: isWorkspaceIdle,
  };

/**
 * Top-of-sidebar toolbar with one dropdown button per active workspace bucket
 * (ADR-009). Always renders all three buttons; empty buckets open a small
 * "No workspaces" row. Items inside each dropdown are sorted newest-first by
 * `compareWorkspaceDashboardRecency` — the shared prop array is never
 * mutated, so the project tree below keeps its own ordering.
 */
export function SidebarBucketBar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  className,
}: SidebarBucketBarProps) {
  const { t } = useTranslation('common');

  const buckets = useMemo(() => {
    const byBucket: Record<BarBucketId, OutlinerWorkspace[]> = {
      attention: [],
      running: [],
      idle: [],
    };
    for (const ws of workspaces) {
      for (const id of BAR_BUCKET_ORDER) {
        if (BUCKET_PREDICATE[id](ws)) {
          byBucket[id].push(ws);
          break; // buckets are mutually exclusive by construction
        }
      }
    }
    for (const id of BAR_BUCKET_ORDER) {
      byBucket[id].sort(compareWorkspaceDashboardRecency);
    }
    return byBucket;
  }, [workspaces]);

  return (
    <div
      role="toolbar"
      aria-label={t('workspaces.bucketBarLabel')}
      className={cn('flex shrink-0 items-center gap-1', className)}
    >
      {BAR_BUCKET_ORDER.map((id) => (
        <BucketButton
          key={id}
          meta={BAR_BUCKETS[id]}
          items={buckets[id]}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          emptyLabel={t('workspaces.bucketEmpty')}
        />
      ))}
    </div>
  );
}

interface BucketButtonProps {
  meta: BarBucketMeta;
  items: readonly OutlinerWorkspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  emptyLabel: string;
}

function BucketButton({
  meta,
  items,
  activeWorkspaceId,
  onSelectWorkspace,
  emptyLabel,
}: BucketButtonProps) {
  const { t } = useTranslation('common');
  const Icon = meta.icon as ComponentType<{
    className?: string;
    weight?: BarBucketMeta['iconWeight'];
  }>;
  const count = items.length;
  const label = t(meta.labelKey);
  const showBadge = !meta.hideBadge && count > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={showBadge ? `${label} — ${count}` : undefined}
          className={cn(
            'relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-sm',
            'h-10 px-1 cursor-pointer transition-colors',
            'text-normal hover:bg-accent hover:text-high',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          )}
        >
          <span className="relative">
            <Icon
              className={cn('size-4 shrink-0', meta.iconClass)}
              weight={meta.iconWeight}
            />
            {showBadge && (
              <CountBadge size="sm" count={count} className={meta.badgeClass} />
            )}
          </span>
          <span className="max-w-full truncate text-2xs font-medium leading-none text-low">
            {label}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="min-w-[260px] max-w-[320px]"
      >
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {count === 0 ? (
          <p className="px-2 py-1.5 text-xs text-low">{emptyLabel}</p>
        ) : (
          items.map((ws) => (
            <WorkspaceBucketMenuItem
              key={ws.id}
              workspace={ws}
              active={ws.id === activeWorkspaceId}
              onSelectWorkspace={onSelectWorkspace}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceBucketMenuItem({
  workspace,
  active,
  onSelectWorkspace,
}: {
  workspace: OutlinerWorkspace;
  active: boolean;
  onSelectWorkspace: (id: string) => void;
}) {
  const elapsed = formatRelativeElapsed(workspace.latestProcessCompletedAt);
  return (
    <DropdownMenuItem
      // Radix closes the menu after onSelect fires by default — gives us
      // close-on-navigate for free.
      onSelect={() => onSelectWorkspace(workspace.id)}
      aria-current={active ? 'page' : undefined}
      className="flex flex-col items-stretch gap-0.5 py-1.5"
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn('truncate', active && 'font-semibold text-high')}>
          {workspace.name}
        </span>
        {elapsed && (
          <span className="shrink-0 text-xs text-low">{elapsed}</span>
        )}
      </span>
      <WorkspaceActivityText
        filesChanged={workspace.filesChanged}
        linesAdded={workspace.linesAdded}
        linesRemoved={workspace.linesRemoved}
      />
    </DropdownMenuItem>
  );
}
