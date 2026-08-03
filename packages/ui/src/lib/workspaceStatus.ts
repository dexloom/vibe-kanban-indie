/**
 * Workspace status derivation — pure domain logic, no React, no web-core deps.
 * Lives in the design-system package so both the sidebar (packages/ui) and the
 * app (packages/web-core) share ONE source of truth for workspace buckets.
 */

/** The status flags the attention predicates need (subset of WorkspaceStatusItem). */
export interface WorkspaceAttentionItem {
  isRunning?: boolean;
  hasPendingApproval?: boolean;
  hasUnseenActivity?: boolean;
}

/** Structural subset shared by SidebarWorkspace / sidebar local types. */
export interface WorkspaceStatusItem extends WorkspaceAttentionItem {
  id: string;
  latestProcessCompletedAt?: string;
  createdAt: string;
}

export function isWorkspaceNeedsAttention(w: WorkspaceAttentionItem): boolean {
  return Boolean(w.hasPendingApproval || (w.hasUnseenActivity && !w.isRunning));
}

export function isWorkspaceRunning(w: WorkspaceAttentionItem): boolean {
  return Boolean(w.isRunning && !isWorkspaceNeedsAttention(w));
}

export function isWorkspaceIdle(w: WorkspaceAttentionItem): boolean {
  return !w.isRunning && !isWorkspaceNeedsAttention(w);
}

function compareDesc(a: string | undefined, b: string | undefined): number {
  const at = a ? Date.parse(a) : Number.NaN;
  const bt = b ? Date.parse(b) : Number.NaN;
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return bt - at;
}

function compareCreated(a: WorkspaceStatusItem, b: WorkspaceStatusItem): number {
  return compareDesc(a.createdAt, b.createdAt) || b.id.localeCompare(a.id);
}

export function compareWorkspaceDashboardRecency(
  a: WorkspaceStatusItem,
  b: WorkspaceStatusItem
): number {
  return (
    compareDesc(a.latestProcessCompletedAt, b.latestProcessCompletedAt) ||
    compareCreated(a, b)
  );
}

export interface CategorizedWorkspaces<T extends WorkspaceStatusItem> {
  needsAttention: T[];
  running: T[];
  recentlyActive: T[];
}

export function categorizeWorkspacesForDashboard<
  T extends WorkspaceStatusItem,
>(active: readonly T[]): CategorizedWorkspaces<T> {
  const needsAttention = active
    .filter(isWorkspaceNeedsAttention)
    .sort(compareCreated);
  const running = active.filter(isWorkspaceRunning).sort(compareCreated);
  const recentlyActive = active
    .filter(isWorkspaceIdle)
    .sort(compareWorkspaceDashboardRecency);
  return { needsAttention, running, recentlyActive };
}

export interface WorkspaceBadgeCounts {
  runningCount: number;
  needsAttentionCount: number;
}

export function computeWorkspaceBadgeCounts(
  active: readonly WorkspaceStatusItem[]
): WorkspaceBadgeCounts {
  return {
    runningCount: active.filter(isWorkspaceRunning).length,
    needsAttentionCount: active.filter(isWorkspaceNeedsAttention).length,
  };
}
