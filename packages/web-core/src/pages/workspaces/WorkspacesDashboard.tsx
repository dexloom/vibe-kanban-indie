import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOutIcon, FolderSimpleIcon } from '@phosphor-icons/react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { categorizeWorkspacesForDashboard } from '@/shared/lib/workspaceStatus/workspaceStatus';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { useWorkspaceProjectMembership } from '@/shared/hooks/useWorkspaceProjectMembership';
import { useProjects } from '@/shared/hooks/useProjects';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { WorkspaceStatusIcons } from '@vibe/ui/components/WorkspaceStatusIcons';
import { cn } from '@/shared/lib/utils';

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
      <FolderSimpleIcon
        className="size-icon-base shrink-0 text-low"
        weight="duotone"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-default">
          {workspace.name}
        </span>
        {workspace.branch ? (
          <span className="truncate text-xs text-muted">
            {workspace.branch}
          </span>
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
  const membership = useWorkspaceProjectMembership();
  const { data: projects = [] } = useProjects();
  const projectId = useUiPreferencesStore(
    (s) => s.workspacesDashboardProjectId
  );
  const setProjectId = useUiPreferencesStore(
    (s) => s.setWorkspacesDashboardProjectId
  );

  // When a project filter is active, narrow to workspaces whose membership
  // includes that project. A workspace with no membership row is "unassigned"
  // and excluded from a project filter.
  const filterByProject = (
    list: readonly SidebarWorkspace[]
  ): SidebarWorkspace[] => {
    if (!projectId) return [...list];
    return list.filter((ws) => {
      const projects = membership.get(ws.id);
      return !!projects && projects.has(projectId);
    });
  };

  const active = useMemo(
    () => filterByProject(activeWorkspaces),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- membership/activeWorkspaces captured via projectId + the deps below
    [activeWorkspaces, projectId, membership]
  );
  const archived = useMemo(
    () => filterByProject(archivedWorkspaces),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [archivedWorkspaces, projectId, membership]
  );

  const categorized = useMemo(
    () => categorizeWorkspacesForDashboard(active),
    [active]
  );

  const openWorkspace = useMemo(
    () => (id: string) => appNavigation.goToWorkspace(id),
    [appNavigation]
  );

  const filterProjectName = projectId
    ? (projects.find((p) => p.id === projectId)?.name ?? null)
    : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-primary p-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold leading-tight text-high">
            {t('workspaces.dashboard.title')}
          </h1>
          {/* All-vs-project switch. */}
          <div className="flex items-center gap-1 rounded-md border border-border bg-overlay p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setProjectId(null)}
              className={cn(
                'rounded-sm px-2 py-0.5 transition-colors',
                !projectId
                  ? 'bg-tertiary text-high'
                  : 'text-low hover:text-normal'
              )}
            >
              {t('workspaces.dashboard.filterAll')}
            </button>
            <button
              type="button"
              onClick={() => projectId && setProjectId(projectId)}
              disabled={!projectId}
              className={cn(
                'rounded-sm px-2 py-0.5 transition-colors',
                projectId
                  ? 'bg-tertiary text-high'
                  : 'text-low opacity-50 cursor-not-allowed'
              )}
            >
              {filterProjectName
                ? t('workspaces.dashboard.filterProject', {
                    name: filterProjectName,
                  })
                : t('workspaces.dashboard.filterProjectNone')}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted">
          {t('workspaces.dashboard.summary', {
            active: active.length,
            archived: archived.length,
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
          workspaces={categorized.idle}
          emptyText={t('workspaces.dashboard.emptyRecentlyActive')}
          onOpen={openWorkspace}
        />
        <WorkspaceSection
          title={t('workspaces.dashboard.sectionArchived')}
          workspaces={archived}
          emptyText={t('workspaces.dashboard.emptyArchived')}
          onOpen={openWorkspace}
        />
      </div>
    </div>
  );
}
