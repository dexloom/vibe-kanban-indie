import { CircleIcon, GitPullRequestIcon, HandIcon, PlayIcon, PushPinIcon, TriangleIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { RunningDots } from './RunningDots';

export interface WorkspaceStatusIconsProps {
  isRunning?: boolean;
  isPinned?: boolean;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  size?: 'default' | 'compact';
}

export function WorkspaceStatusIcons({ isRunning = false, isPinned = false, hasPendingApproval = false, hasRunningDevServer = false, hasUnseenActivity = false, latestProcessStatus, prStatus, size = 'default' }: WorkspaceStatusIconsProps) {
  const failed = latestProcessStatus === 'failed' || latestProcessStatus === 'killed';
  const iconClass = cn(size === 'compact' ? 'size-icon-xs' : 'size-icon-base', 'shrink-0');
  return <>
    {hasRunningDevServer && <PlayIcon className={cn(iconClass, 'text-brand')} weight="fill" />}
    {!isRunning && failed && <TriangleIcon className={cn(iconClass, 'text-error')} weight="fill" />}
    {isRunning && (hasPendingApproval ? <HandIcon className={cn(iconClass, 'text-brand')} weight="fill" /> : <RunningDots className={iconClass} />)}
    {hasUnseenActivity && !isRunning && !failed && <CircleIcon className={cn(iconClass, 'text-brand')} weight="fill" />}
    {prStatus === 'open' && <GitPullRequestIcon className={cn(iconClass, 'text-success')} weight="fill" />}
    {prStatus === 'merged' && <GitPullRequestIcon className={cn(iconClass, 'text-merged')} weight="fill" />}
    {isPinned && <PushPinIcon className={cn(iconClass, 'text-brand')} weight="fill" />}
  </>;
}
