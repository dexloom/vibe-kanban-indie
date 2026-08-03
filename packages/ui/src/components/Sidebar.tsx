import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { SidebarBar } from './SidebarBar';
import { SidebarBucketBar } from './SidebarBucketBar';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { SidebarSeparator } from './SidebarSeparator';
import { SidebarProjectTree } from './SidebarProjectTree';
import type { ProjectTasksData } from './outliner/types';
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
  tasksByProject?: ReadonlyMap<string, ProjectTasksData>;
  loadingTasksProjectIds?: ReadonlySet<string>;
  activeIssueId?: string | null;
  onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
  onSelectIssue?: (projectId: string, issueId: string) => void;
  isLoadingProjects?: boolean;
  isLoadingWorkspaces?: boolean;
  /** Called after the user successfully reorders projects. */
  onProjectsReorder: (reorderedProjectIds: string[]) => void;
  onSelectWorkspace: (id: string) => void;
  onSelectProject: (id: string) => void;

  /** Right-aligned actions for the Projects section header (e.g. create-project button). */
  headerActions?: ReactNode;
  /** Bottom bar content (e.g. Notifications / Settings buttons), rendered in
   *  a shared SidebarBar pinned to the bottom. */
  bottomActions?: ReactNode;
  className?: string;
}

export function Sidebar({
  projects,
  activeProjectId,
  workspaces,
  archivedWorkspaces = [],
  membership,
  activeWorkspaceId,
  tasksByProject,
  loadingTasksProjectIds,
  activeIssueId,
  onTasksExpansionChange,
  onSelectIssue,
  isLoadingProjects,
  isLoadingWorkspaces,
  onProjectsReorder,
  onSelectWorkspace,
  onSelectProject,
  headerActions,
  bottomActions,
  className,
}: SidebarProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  return (
    <aside
      aria-label="Primary sidebar"
      className={cn(
        'flex h-full w-[256px] shrink-0 flex-col gap-2 overflow-hidden',
        'border-r border-border bg-secondary px-2 pt-2 pb-2',
        className,
      )}
    >
      <SidebarBucketBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
      />

      <SidebarSeparator />

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
        tasksByProject={tasksByProject}
        loadingTasksProjectIds={loadingTasksProjectIds}
        activeIssueId={activeIssueId}
        onTasksExpansionChange={onTasksExpansionChange}
        onSelectIssue={onSelectIssue}
        isLoading={isLoadingProjects || isLoadingWorkspaces}
        onSelectWorkspace={onSelectWorkspace}
        onSelectProject={onSelectProject}
        onProjectsReorder={onProjectsReorder}
        ariaLabelledBy={titleId}
      />

      {bottomActions && (
        <SidebarBar
          aria-label={t('sidebar.bottomBarLabel')}
          className="mt-auto pt-2"
        >
          {bottomActions}
        </SidebarBar>
      )}
    </aside>
  );
}
