import { LayoutIcon } from '@phosphor-icons/react';
import type { DropResult } from '@hello-pangea/dnd';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';
import { ProjectsGroup, type ProjectsGroupProject } from './ProjectsGroup';

interface SidebarProps {
  projects: ProjectsGroupProject[];
  activeProjectId: string | null;
  isSignedIn: boolean;
  isLoadingProjects?: boolean;
  isSavingProjectOrder?: boolean;
  onProjectClick: (projectId: string) => void;
  onCreateProject: () => void;
  onProjectsDragEnd: (result: DropResult) => void;

  /** Handler invoked when the user clicks the Workspaces shortcut button. */
  onOpenWorkspaces: () => void;
  /** Whether the current destination is a workspaces/chat destination. */
  isWorkspacesActive: boolean;

  notificationBell?: ReactNode;
  organizationsSwitcher?: ReactNode;
  userPopover?: ReactNode;
  appVersion?: string | null;
  updateVersion?: string | null;
  onUpdateClick?: () => void;

  className?: string;
}

export function Sidebar({
  projects,
  activeProjectId,
  isSignedIn,
  isLoadingProjects,
  isSavingProjectOrder,
  onProjectClick,
  onCreateProject,
  onProjectsDragEnd,
  onOpenWorkspaces,
  isWorkspacesActive,
  notificationBell,
  organizationsSwitcher,
  userPopover,
  appVersion,
  updateVersion,
  onUpdateClick,
  className,
}: SidebarProps) {
  const { t } = useTranslation('common');

  return (
    <aside
      aria-label="Primary sidebar"
      className={cn(
        'flex h-full w-[256px] shrink-0 flex-col gap-2 overflow-y-auto',
        'border-r border-border bg-secondary p-2',
        className
      )}
    >
      {/* Tauri drag strip — Windows/Linux only. On macOS the Navbar drag region
          covers the top; keeping the strip small and inert is harmless. */}
      <div data-tauri-drag-region className="h-7 shrink-0" aria-hidden="true" />

      <ProjectsGroup
        projects={projects}
        activeProjectId={activeProjectId}
        isSignedIn={isSignedIn}
        isLoading={isLoadingProjects ?? false}
        isSavingProjectOrder={isSavingProjectOrder}
        onProjectClick={onProjectClick}
        onCreateProject={onCreateProject}
        onProjectsDragEnd={onProjectsDragEnd}
      />

      <Tooltip content={t('appBar.workspaces')} side="right">
        <button
          type="button"
          onClick={onOpenWorkspaces}
          aria-label={t('appBar.workspaces')}
          aria-current={isWorkspacesActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5',
            'text-sm transition-colors cursor-pointer',
            isWorkspacesActive
              ? 'bg-tertiary text-high'
              : 'text-normal hover:bg-tertiary'
          )}
        >
          <LayoutIcon className="size-icon-xs" weight="bold" />
          <span className="truncate">{t('appBar.workspaces')}</span>
        </button>
      </Tooltip>

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
                'bg-brand text-on-brand hover:bg-brand-hover cursor-pointer transition-colors'
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