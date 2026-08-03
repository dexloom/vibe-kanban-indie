import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOutIcon, FolderSimpleIcon } from '@phosphor-icons/react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { categorizeWorkspacesForDashboard } from '@/shared/lib/workspaceStatus/workspaceStatus';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { WorkspaceStatusIcons } from '@vibe/ui/components/WorkspaceStatusIcons';

function DashboardWorkspaceRow({
  workspace,
  onOpen,
}: {
  workspace: SidebarWorkspace;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(workspace.id)}
      className="flex w-full items-center gap-3 rounded-md border border-border bg-overlay px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface/60"
    >
      <FolderSimpleIcon className="size-icon-base shrink-0 text-low" weight="duotone" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-default">
          {workspace.name}
        </span>
        {workspace.branch ? (
          <span className="truncate text-xs text-muted">{workspace.branch}</span>
        ) : null}
      </div>
      <WorkspaceStatusIcons
        isRunning={workspace.isRunning}
        hasPendingApproval={workspace.hasPendingApproval}
        hasUnseenActivity={workspace.hasUnseenActivity}
        latestProcessStatus={workspace.latestProcessStatus}
        prStatus={workspace.prStatus}
        isPinned={workspace.isPinned}
        size="default"
      />
      <ArrowSquareOutIcon className="size-icon-base shrink-0 text-low" />
    </button>
  );
}

function WorkspaceSection({
  title,
  workspaces,
  emptyText,
  onOpen,
}: {
  title: string;
  workspaces: readonly SidebarWorkspace[];
  emptyText: string;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        {title}
      </h3>
      {workspaces.length === 0 ? (
        <p className="py-2 text-sm text-subtle">{emptyText}</p>
      ) : (
        workspaces.map((ws) => (
          <DashboardWorkspaceRow key={ws.id} workspace={ws} onOpen={onOpen} />
        ))
      )}
    </section>
  );
}

export function WorkspacesDashboard() {
  const { t } = useTranslation('common');
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const appNavigation = useAppNavigation();

  const categorized = useMemo(
    () => categorizeWorkspacesForDashboard(activeWorkspaces),
    [activeWorkspaces]
  );

  const openWorkspace = useMemo(
    () => (id: string) => appNavigation.goToWorkspace(id),
    [appNavigation]
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-primary p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold leading-tight text-high">
          {t('workspaces.dashboard.title')}
        </h1>
        <p className="text-sm text-muted">
          {t('workspaces.dashboard.summary', {
            active: activeWorkspaces.length,
            archived: archivedWorkspaces.length,
            running: categorized.running.length,
            attention: categorized.needsAttention.length,
          })}
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <WorkspaceSection
          title={t('workspaces.dashboard.sectionNeedsAttention')}
          workspaces={categorized.needsAttention}
          emptyText={t('workspaces.dashboard.emptyNeedsAttention')}
          onOpen={openWorkspace}
        />
        <WorkspaceSection
          title={t('workspaces.dashboard.sectionRunning')}
          workspaces={categorized.running}
          emptyText={t('workspaces.dashboard.emptyRunning')}
          onOpen={openWorkspace}
        />
        <WorkspaceSection
          title={t('workspaces.dashboard.sectionRecentlyActive')}
          workspaces={categorized.recentlyActive}
          emptyText={t('workspaces.dashboard.emptyRecentlyActive')}
          onOpen={openWorkspace}
        />
        <WorkspaceSection
          title={t('workspaces.dashboard.sectionArchived')}
          workspaces={archivedWorkspaces}
          emptyText={t('workspaces.dashboard.emptyArchived')}
          onOpen={openWorkspace}
        />
      </div>
    </div>
  );
}
