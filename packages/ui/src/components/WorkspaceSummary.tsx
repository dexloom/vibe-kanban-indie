import {
  FileIcon,
  DotsThreeIcon,
  RobotIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceKind } from 'shared/types';
import { cn } from '../lib/cn';
import { WorkspaceStatusIcons } from './WorkspaceStatusIcons';

const formatRelativeElapsed = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

export interface WorkspaceSummaryProps {
  name: string;
  workspaceId?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isActive?: boolean;
  isRunning?: boolean;
  isPinned?: boolean;
  /** Special-purpose workspace discriminator; shows a badge when set. */
  kind?: WorkspaceKind | null;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  onClick?: () => void;
  className?: string;
  summary?: boolean;
  /** Whether this is a draft workspace (shows "Draft" instead of elapsed time) */
  isDraft?: boolean;
  onOpenWorkspaceActions?: (workspaceId: string) => void;
}

export function WorkspaceSummary({
  name,
  workspaceId,
  filesChanged,
  linesAdded,
  linesRemoved,
  isActive = false,
  isRunning = false,
  isPinned = false,
  kind = null,
  hasPendingApproval = false,
  hasRunningDevServer = false,
  hasUnseenActivity = false,
  latestProcessCompletedAt,
  latestProcessStatus,
  prStatus,
  onClick,
  className,
  summary = false,
  isDraft = false,
  onOpenWorkspaceActions,
}: WorkspaceSummaryProps) {
  const { t } = useTranslation('common');
  const hasChanges = filesChanged !== undefined && filesChanged > 0;

  const handleOpenCommandBar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!workspaceId || !onOpenWorkspaceActions) return;
    onOpenWorkspaceActions(workspaceId);
  };

  return (
    <div
      className={cn(
        'group relative rounded-sm transition-all duration-100 overflow-hidden',
        isActive ? 'bg-tertiary' : '',
        className
      )}
    >
      {/* Selection indicator - thin colored tab on the left */}
      <div
        className={cn(
          'absolute left-0 top-1 bottom-1 w-0.5 rounded-full transition-colors duration-100',
          isActive ? 'bg-brand' : 'bg-transparent'
        )}
      />
      <button
        onClick={onClick}
        className={cn(
          'flex w-full cursor-pointer flex-col text-left px-base py-half transition-all duration-150',
          isActive
            ? 'text-normal'
            : 'text-low sm:opacity-60 sm:hover:opacity-100 sm:hover:text-normal'
        )}
      >
        <div
          className={cn(
            'flex items-center gap-half overflow-hidden whitespace-nowrap pr-double',
            !summary && 'text-normal'
          )}
          style={{
            maskImage:
              'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
          }}
        >
          {kind === 'orchestrator' && (
            <RobotIcon
              className="size-icon-xs shrink-0 text-brand"
              weight="fill"
              aria-label="Orchestrator"
            />
          )}
          <span className="truncate">{name}</span>
        </div>
        {(!summary || isActive) && (
          <div className="flex w-full items-center gap-base text-sm h-5">
            <WorkspaceStatusIcons
              isRunning={isRunning}
              isPinned={isPinned}
              hasPendingApproval={hasPendingApproval}
              hasRunningDevServer={hasRunningDevServer}
              hasUnseenActivity={hasUnseenActivity}
              latestProcessStatus={latestProcessStatus}
              prStatus={prStatus}
              size="compact"
            />

            {/* Time elapsed OR "Draft" label (when not running) */}
            {!isRunning &&
              (isDraft ? (
                <span className="min-w-0 flex-1 truncate">
                  {t('workspaces.draft')}
                </span>
              ) : latestProcessCompletedAt ? (
                <span className="min-w-0 flex-1 truncate">
                  {formatRelativeElapsed(latestProcessCompletedAt)}
                </span>
              ) : (
                <span className="flex-1" />
              ))}

            {/* Spacer when running (no elapsed time shown) */}
            {isRunning && <span className="flex-1" />}

            {/* File count + lines changed on the right */}
            {hasChanges && (
              <span className="shrink-0 text-right flex items-center gap-half">
                <FileIcon className="size-icon-xs" weight="fill" />
                <span>{filesChanged}</span>
                {linesAdded !== undefined && (
                  <span className="text-success">+{linesAdded}</span>
                )}
                {linesRemoved !== undefined && (
                  <span className="text-error">-{linesRemoved}</span>
                )}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Right-side hover action - more options only */}
      {workspaceId && onOpenWorkspaceActions && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center sm:opacity-0 sm:group-hover:opacity-100">
          {/* Gradient fade from transparent to background */}
          <div className="h-full w-6 pointer-events-none bg-gradient-to-r from-transparent to-secondary" />
          {/* Single action button */}
          <div className="flex items-center pr-base h-full bg-secondary">
            <button
              onClick={handleOpenCommandBar}
              onPointerDown={(e) => e.stopPropagation()}
              className="p-1.5 rounded-sm text-low hover:text-normal hover:bg-tertiary"
              title={t('workspaces.more')}
            >
              <DotsThreeIcon className="size-5" weight="bold" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
