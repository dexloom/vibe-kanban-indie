import { useEffect } from 'react';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { pickChatDestination } from '@/shared/lib/workspaceStatus/workspaceStatus';

/**
 * Landing route for the "Chat" nav button. Jumps into the most relevant
 * workspace's chat: needs-attention → running → most-recently-active → else
 * the workspace-create flow.
 */
export function ChatLanding() {
  const appNavigation = useAppNavigation();
  const { activeWorkspaces, isWorkspacesListLoading } = useWorkspaceContext();

  useEffect(() => {
    if (isWorkspacesListLoading) return;
    const dest = pickChatDestination(activeWorkspaces);
    if (dest.kind === 'workspace') {
      appNavigation.goToWorkspace(dest.workspaceId, { replace: true });
    } else {
      appNavigation.goToWorkspacesCreate({ replace: true });
    }
  }, [isWorkspacesListLoading, activeWorkspaces, appNavigation]);

  return (
    <div className="flex h-full flex-1 items-center justify-center bg-primary">
      <SpinnerIcon className="size-6 animate-spin text-low" />
    </div>
  );
}
