import { useCallback } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import {
  WorkspaceOutliner,
  type OutlinerWorkspace,
} from '@vibe/ui/components/WorkspaceOutliner';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { isWorkspaceChatDestination } from '@/shared/lib/routes/appNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';

interface WorkspaceOutlinerContainerProps {
  /**
   * Optional reselect handler invoked when the user clicks the already-active
   * workspace leaf — typically wired to scroll the chat container to the
   * bottom. Accepts a workspace id so the handler can disambiguate which
   * leaf was re-clicked. An optional scroll behavior is forwarded so the
   * consumer (WorkspacesLayout) can reuse its existing handleScrollToBottom.
   */
  onReselect?: (
    workspaceId: string,
    behavior?: 'auto' | 'smooth'
  ) => void;
}

function toOutlinerWorkspace(ws: SidebarWorkspace): OutlinerWorkspace {
  return {
    id: ws.id,
    name: ws.name,
    createdAt: ws.createdAt,
    filesChanged: ws.filesChanged,
    linesAdded: ws.linesAdded,
    linesRemoved: ws.linesRemoved,
    isRunning: ws.isRunning,
    isPinned: ws.isPinned,
    kind: ws.kind,
    hasPendingApproval: ws.hasPendingApproval,
    hasRunningDevServer: ws.hasRunningDevServer,
    hasUnseenActivity: ws.hasUnseenActivity,
    latestProcessCompletedAt: ws.latestProcessCompletedAt,
    latestProcessStatus: ws.latestProcessStatus,
    prStatus: ws.prStatus,
  };
}

export function WorkspaceOutlinerContainer({
  onReselect,
}: WorkspaceOutlinerContainerProps = {}) {
  const {
    workspaceId: selectedWorkspaceId,
    activeWorkspaces,
    archivedWorkspaces,
    isWorkspacesListLoading,
    selectWorkspace,
  } = useWorkspaceContext();

  const currentDestination = useCurrentAppDestination();
  const isMobile = useIsMobile();
  const setMobileActiveTab = useUiPreferencesStore((s) => s.setMobileActiveTab);

  // Active workspace id derives from the URL destination so the outliner can
  // highlight the leaf even when the destination is in its transient `chat`
  // state (before the smart-redirect lands).
  const activeWorkspaceId =
    selectedWorkspaceId ??
    (isWorkspaceChatDestination(currentDestination)
      ? (currentDestination as { workspaceId?: string }).workspaceId ?? null
      : null);

  const handleSelectWorkspace = useCallback(
    (id: string) => {
      if (id === selectedWorkspaceId) {
        onReselect?.(id, 'smooth');
      } else {
        selectWorkspace(id);
      }
      if (isMobile) {
        setMobileActiveTab('chat');
      }
    },
    [selectedWorkspaceId, onReselect, selectWorkspace, isMobile, setMobileActiveTab]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-secondary">
      <WorkspaceOutliner
        workspaces={activeWorkspaces.map(toOutlinerWorkspace)}
        archivedWorkspaces={archivedWorkspaces.map(toOutlinerWorkspace)}
        activeWorkspaceId={activeWorkspaceId}
        isLoading={isWorkspacesListLoading}
        onSelectWorkspace={handleSelectWorkspace}
        className="px-base py-base"
      />
    </div>
  );
}