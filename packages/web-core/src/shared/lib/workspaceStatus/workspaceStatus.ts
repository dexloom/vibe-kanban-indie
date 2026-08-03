import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { AppDestination } from '@/shared/lib/routes/appNavigation';
import { categorizeWorkspacesForDashboard } from '@vibe/ui/lib/workspaceStatus';

export type { WorkspaceStatusItem } from '@vibe/ui/lib/workspaceStatus';
export {
  categorizeWorkspacesForDashboard,
  compareWorkspaceDashboardRecency,
  computeWorkspaceBadgeCounts,
  isWorkspaceIdle,
  isWorkspaceNeedsAttention,
  isWorkspaceRunning,
} from '@vibe/ui/lib/workspaceStatus';

export function pickChatDestination(
  active: readonly SidebarWorkspace[]
): AppDestination {
  const categorized = categorizeWorkspacesForDashboard(active);
  const workspace =
    categorized.needsAttention[0] ??
    categorized.running[0] ??
    categorized.recentlyActive[0];
  return workspace
    ? { kind: 'workspace', workspaceId: workspace.id }
    : { kind: 'workspaces-create' };
}
