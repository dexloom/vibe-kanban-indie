import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import {
  SidebarProjectTree,
} from './SidebarProjectTree';
import type { SidebarProject } from './outliner/types';
import type {
  OutlinerWorkspace,
  WorkspaceProjectMembership,
} from './outliner/types';

export type { WorkspaceProjectMembership } from './outliner/types';

interface SidebarProps {
  /** All projects to render at the root of the tree. */
  projects: readonly SidebarProject[];
  /** Project id whose destination the user is currently on, if any. */
  activeProjectId: string | null;
  /** Active (non-archived) workspaces, fed into each project's tree. */
  workspaces: OutlinerWorkspace[];
  /** Archived workspaces. */
  archivedWorkspaces?: OutlinerWorkspace[];
  /** local_workspace_id → set of project ids (for tree grouping). */
  membership: WorkspaceProjectMembership;
  /** Workspace id whose destination the user is currently on, if any. */
  activeWorkspaceId: string | null;
  isLoadingProjects?: boolean;
  isLoadingWorkspaces?: boolean;
  /** Called after the user successfully reorders projects. */
  onProjectsReorder: (reorderedProjectIds: string[]) => void;
  onSelectWorkspace: (id: string) => void;
  onSelectProject: (id: string) => void;

  notificationBell?: ReactNode;
  organizationsSwitcher?: ReactNode;
  userPopover?: ReactNode;
  /** Right-aligned actions for the Projects section header (e.g. create-project button). */
  headerActions?: ReactNode;
  appVersion?: string | null;
  updateVersion?: string | null;
  onUpdateClick?: () => void;

  className?: string;
}

export function Sidebar({
  projects,
  activeProjectId,
  workspaces,
  archivedWorkspaces = [],
  membership,
  activeWorkspaceId,
  isLoadingProjects,
  isLoadingWorkspaces,
  onProjectsReorder,
  onSelectWorkspace,
  onSelectProject,
  notificationBell,
  organizationsSwitcher,
  userPopover,
  headerActions,
  appVersion,
  updateVersion,
  onUpdateClick,
  className,
}: SidebarProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  return (
    <aside
      aria-label="Primary sidebar"
      className={cn(
        'flex h-full w-[256px] shrink-0 flex-col gap-2 overflow-hidden',
        'border-r border-border bg-secondary p-2',
        className,
      )}
    >
      {/* Tauri drag strip — Windows/Linux only. On macOS the Navbar drag region
          covers the top; keeping the strip small and inert is harmless. */}
      <div data-tauri-drag-region className="h-7 shrink-0" aria-hidden="true" />

      <SidebarSectionHeader
        title={t('appBar.projects')}
        titleId={titleId}
        actions={headerActions}
      />

      <SidebarProjectTree
        projects={projects}
        activeProjectId={activeProjectId}
        workspaces={workspaces}
        archivedWorkspaces={archivedWorkspaces}
        membership={membership}
        activeWorkspaceId={activeWorkspaceId}
        isLoading={isLoadingProjects || isLoadingWorkspaces}
        onSelectWorkspace={onSelectWorkspace}
        onSelectProject={onSelectProject}
        onProjectsReorder={onProjectsReorder}
        ariaLabelledBy={titleId}
      />

      <div className="mt-auto flex flex-row items-center gap-1 pt-2">
        {notificationBell}
        {organizationsSwitcher}
        {userPopover}
        {updateVersion ? (
          <Tooltip content={`Update to v${updateVersion}`} side="right">
            <button
              type="button"
              onClick={onUpdateClick}
              className={cn(
                'flex items-center justify-center rounded-md px-2 py-1 text-xs',
                'bg-brand text-on-brand hover:bg-brand-hover cursor-pointer transition-colors',
              )}
            >
              Update
            </button>
          </Tooltip>
        ) : (
          appVersion && (
            <p
              className="text-2xs font-mono text-low text-center ml-auto"
              title={`v${appVersion}`}
            >
              v{appVersion}
            </p>
          )
        )}
      </div>
    </aside>
  );
}
