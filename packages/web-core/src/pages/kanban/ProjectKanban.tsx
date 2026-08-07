import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type IssuePriority, type Project } from 'shared/remote-types';
import { Group, Layout, Panel, Separator } from 'react-resizable-panels';
import { useProjects } from '@/shared/hooks/useProjects';
import { useProjectsContext } from '@/shared/providers/ProjectProvider';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useActions } from '@/shared/hooks/useActions';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { KanbanContainer } from '@/features/kanban/ui/KanbanContainer';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { ProjectRightSidebarContainer } from './ProjectRightSidebarContainer';
import {
  PERSIST_KEYS,
  usePaneSize,
} from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  type ProjectIssueCreateOptions,
} from '@/shared/stores/useKanbanIssueComposerStore';
import {
  CreateIssueDialog,
  type CreateIssueDialogPriorityOption,
  type CreateIssueDialogStatusOption,
} from '@/shared/dialogs/kanban/CreateIssueDialog';

const PRIORITY_ORDER: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];
/**
 * Component that registers project mutations with ActionsContext.
 * Must be rendered inside both ActionsProvider and ProjectProvider.
 */
function ProjectMutationsRegistration({ children }: { children: ReactNode }) {
  const { registerProjectMutations } = useActions();
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const hostId = useHostId();
  const {
    projectId,
    statuses,
    issues,
    issuesById,
    getIssue,
    insertIssue,
    updateIssue,
    removeIssue,
  } = useProjectContext();

  // Use ref to always access latest issues (avoid stale closure)
  const issuesRef = useRef(issues);
  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

  const statusOptions: CreateIssueDialogStatusOption[] = useMemo(
    () =>
      [...statuses]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((status) => ({ id: status.id, name: status.name })),
    [statuses]
  );

  const priorityOptions: CreateIssueDialogPriorityOption[] = useMemo(
    () =>
      PRIORITY_ORDER.map((value) => ({
        value,
        label: t(`createIssueDialog.priority.${value}`),
      })),
    [t]
  );

  const openCreateIssue = useCallback(
    async (options?: ProjectIssueCreateOptions): Promise<string | null> => {
      const defaultStatusId = options?.statusId ?? statusOptions[0]?.id ?? '';

      // Resolve parent issue's simple_id for the dialog hint.
      const parentIssueSimpleId = options?.parentIssueId
        ? (issuesById.get(options.parentIssueId)?.simple_id ??
          getIssue(options.parentIssueId)?.simple_id ??
          null)
        : null;

      // Close any open composer for this project so the right sidebar doesn't
      // collide with the modal. We close BEFORE awaiting creation so the
      // modal flow is unblocked by the existing sidebar.
      const composerKey = buildKanbanIssueComposerKey(hostId, projectId);
      closeKanbanIssueComposer(composerKey);

      const res = await CreateIssueDialog.show({
        projectId,
        statuses: statusOptions,
        defaultStatusId,
        priorities: priorityOptions,
        parentIssueSimpleId,
        onCreate: async ({
          title,
          description,
          statusId,
          priority,
          extensionMetadata,
        }): Promise<string> => {
          // Top-of-column sort_order: min sort_order of issues in the target
          // status, minus 1 (so the new card lands at the top). Fall back to
          // 0 when the column is empty.
          const statusIssues = issuesRef.current.filter(
            (issue) => issue.status_id === statusId
          );
          const minSortOrder =
            statusIssues.length > 0
              ? Math.min(...statusIssues.map((issue) => issue.sort_order))
              : 0;

          const { persisted } = insertIssue({
            project_id: projectId,
            status_id: statusId,
            title,
            description,
            priority,
            sort_order: minSortOrder - 1,
            start_date: null,
            target_date: null,
            completed_at: null,
            parent_issue_id: options?.parentIssueId ?? null,
            parent_issue_sort_order: null,
            extension_metadata: extensionMetadata ?? {},
          });

          const syncedIssue = await persisted;

          return syncedIssue.id;
        },
        onUpdate: (issueId, changes) => {
          updateIssue(issueId, {
            title: changes.title,
            description: changes.description,
            status_id: changes.statusId,
            priority: changes.priority,
            extension_metadata: changes.extensionMetadata,
          });
        },
      });

      if (res.action === 'created') {
        appNavigation.goToProjectIssue(projectId, res.issueId);
        return res.issueId;
      }
      return null;
    },
    [
      statusOptions,
      priorityOptions,
      issuesById,
      getIssue,
      insertIssue,
      updateIssue,
      appNavigation,
      hostId,
      projectId,
      t,
    ]
  );

  useEffect(() => {
    registerProjectMutations({
      removeIssue: (id) => {
        removeIssue(id);
      },
      duplicateIssue: (issueId) => {
        const issue = getIssue(issueId);
        if (!issue) return;

        // Use ref to get current issues (not stale closure)
        const currentIssues = issuesRef.current;
        const statusIssues = currentIssues.filter(
          (i) => i.status_id === issue.status_id
        );
        const minSortOrder =
          statusIssues.length > 0
            ? Math.min(...statusIssues.map((i) => i.sort_order))
            : 0;

        insertIssue({
          project_id: issue.project_id,
          status_id: issue.status_id,
          title: `${issue.title} (Copy)`,
          description: issue.description,
          priority: issue.priority,
          sort_order: minSortOrder - 1,
          start_date: issue.start_date,
          target_date: issue.target_date,
          completed_at: null,
          parent_issue_id: issue.parent_issue_id,
          parent_issue_sort_order: issue.parent_issue_sort_order,
          extension_metadata: issue.extension_metadata,
        });
      },
      getIssue,
      createIssue: openCreateIssue,
    });

    return () => {
      registerProjectMutations(null);
    };
  }, [
    registerProjectMutations,
    removeIssue,
    insertIssue,
    getIssue,
    openCreateIssue,
  ]);

  return <>{children}</>;
}

function ProjectKanbanBoard() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1">
        <KanbanContainer />
      </div>
    </div>
  );
}

function ProjectKanbanLayout({ projectName }: { projectName: string }) {
  const { issueId, isPanelOpen } = useCurrentKanbanRouteState();
  const isMobile = useIsMobile();
  const { getIssue } = useProjectContext();
  const issue = issueId ? getIssue(issueId) : undefined;
  usePageTitle(issue?.title, projectName);
  const [kanbanLeftPanelSize, setKanbanLeftPanelSize] = usePaneSize(
    PERSIST_KEYS.kanbanLeftPanel,
    75
  );

  const isRightPanelOpen = isPanelOpen;

  if (isMobile) {
    return isRightPanelOpen ? (
      <div className="h-full w-full overflow-hidden bg-secondary">
        <ProjectRightSidebarContainer />
      </div>
    ) : (
      <div className="h-full w-full overflow-hidden bg-primary">
        <ProjectKanbanBoard />
      </div>
    );
  }

  const kanbanDefaultLayout: Layout =
    typeof kanbanLeftPanelSize === 'number'
      ? {
          'kanban-left': kanbanLeftPanelSize,
          'kanban-right': 100 - kanbanLeftPanelSize,
        }
      : { 'kanban-left': 75, 'kanban-right': 25 };

  const onKanbanLayoutChange = (layout: Layout) => {
    if (isRightPanelOpen) {
      setKanbanLeftPanelSize(layout['kanban-left']);
    }
  };

  return (
    <Group
      orientation="horizontal"
      className="flex-1 min-w-0 h-full"
      defaultLayout={kanbanDefaultLayout}
      onLayoutChange={onKanbanLayoutChange}
    >
      <Panel
        id="kanban-left"
        minSize="20%"
        className="min-w-0 h-full overflow-hidden bg-primary"
      >
        <ProjectKanbanBoard />
      </Panel>

      {isRightPanelOpen && (
        <Separator
          id="kanban-separator"
          className="w-1 bg-panel outline-none hover:bg-brand/50 transition-colors cursor-col-resize"
        />
      )}

      {isRightPanelOpen && (
        <Panel
          id="kanban-right"
          minSize="400px"
          maxSize="800px"
          className="min-w-0 h-full overflow-hidden bg-secondary"
        >
          <ProjectRightSidebarContainer />
        </Panel>
      )}
    </Group>
  );
}

/**
 * Inner component that renders the Kanban board once we have the project list
 * from the flat projects layer (ADR-018).
 */
function ProjectKanbanInner({ projectId }: { projectId: string }) {
  const { t } = useTranslation('common');
  const { projects, isLoading } = useProjectsContext();

  const project = projects.find((p) => p.id === projectId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('states.loading')}</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  return (
    <ProjectProvider projectId={projectId}>
      <ProjectMutationsRegistration>
        <ProjectKanbanLayout projectName={project.name} />
      </ProjectMutationsRegistration>
    </ProjectProvider>
  );
}

/**
 * ProjectKanban page - displays the Kanban board for a specific project
 *
 * URL patterns:
 * - /projects/:projectId - Kanban board with no issue selected
 * - /projects/:projectId/issues/:issueId - Kanban with issue panel open
 * - /projects/:projectId/issues/:issueId/workspaces/:workspaceId - Kanban with workspace session panel open
 * - /projects/:projectId/issues/:issueId/workspaces/create/:draftId - Kanban with workspace create panel
 *
 * Note: issue creation is composer-store state on top of /projects/:projectId.
 *
 * Note: This component is rendered inside SharedAppLayout which provides
 * NavbarContainer, AppBar, SyncErrorProvider, and ProjectProvider
 * (the flat projects layer — ADR-018).
 */
export function ProjectKanban() {
  const { projectId, hostId, hasInvalidWorkspaceCreateDraftId } =
    useCurrentKanbanRouteState();
  const appNavigation = useAppNavigation();
  const { t } = useTranslation('common');
  const issueComposerKey = useMemo(() => {
    if (!projectId) {
      return null;
    }
    return buildKanbanIssueComposerKey(hostId, projectId);
  }, [hostId, projectId]);
  const previousIssueComposerKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousKey = previousIssueComposerKeyRef.current;
    if (previousKey && previousKey !== issueComposerKey) {
      closeKanbanIssueComposer(previousKey);
    }

    previousIssueComposerKeyRef.current = issueComposerKey;
  }, [issueComposerKey]);

  // Redirect invalid workspace-create draft URLs back to the closed project view.
  useEffect(() => {
    if (!projectId) return;

    if (hasInvalidWorkspaceCreateDraftId) {
      appNavigation.goToProject(projectId, {
        replace: true,
      });
    }
  }, [projectId, hasInvalidWorkspaceCreateDraftId, appNavigation]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  // ProjectProvider (the flat projects layer) is already mounted by
  // SharedAppLayout — we look up the project directly via the same hook.
  const { data: projects } = useProjects();
  const project = projects.find((p: Project) => p.id === projectId);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  return <ProjectKanbanInner projectId={projectId} />;
}
