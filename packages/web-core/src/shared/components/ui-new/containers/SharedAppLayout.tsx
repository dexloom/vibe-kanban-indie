import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { XIcon, KanbanIcon } from '@phosphor-icons/react';
import { SyncErrorProvider } from '@/shared/providers/SyncErrorProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';

import { NavbarContainer } from './NavbarContainer';
import { Sidebar } from '@vibe/ui/components/Sidebar';
import { MobileDrawer } from '@vibe/ui/components/MobileDrawer';
import { SidebarBottomActions } from './SidebarBottomActions';
import { SidebarProjectTasksRegistry } from '@/shared/components/sidebar/SidebarProjectTasksRegistry';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';
import { useAuth } from '@/shared/hooks/auth/useAuth';

import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import type { ProjectTasksData } from '@vibe/ui/components/outliner/types';
import { getProjectDestination } from '@/shared/lib/routes/appNavigation';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import {
  CreateRemoteProjectDialog,
  type CreateRemoteProjectResult,
} from '@/shared/dialogs/org/CreateRemoteProjectDialog';
import { CreateProjectButton } from './CreateProjectButton';
import { useCommandBarShortcut } from '@/shared/hooks/useCommandBarShortcut';
import { useShape } from '@/shared/integrations/electric/hooks';
import { sortProjectsByOrder } from '@/shared/lib/projectOrder';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_MUTATION,
  PROJECT_PROJECT_STATUSES_SHAPE,
  PROJECTS_SHAPE,
  type Project as RemoteProject,
} from 'shared/remote-types';
import { useWorkspaceProjectMembership } from '@/shared/hooks/useWorkspaceProjectMembership';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { OutlinerWorkspace } from '@vibe/ui/components/outliner/types';
import {
  deriveOpenTasksProjectIds,
  readSidebarTreeOpenState,
} from '@vibe/ui/components/outliner/openState';
import { DragProvider, type DragCompletion } from '@vibe/ui/components/dnd';
import { resolveDragEnd } from '@/shared/lib/resolveDragEnd';
import { bulkUpdateIssues, bulkUpdateProjects } from '@/shared/lib/remoteApi';
import { refreshShapeSource } from '@/shared/lib/electric/collections';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import {
  KanbanDragHandlerProvider,
  type KanbanDragHandler,
} from './KanbanDragHandlerContext';

export function SharedAppLayout() {
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const { issueId: activeIssueId } = useCurrentKanbanRouteState();
  const isMobile = useIsMobile();
  const mobileFontScale = useUiPreferencesStore((s) => s.mobileFontScale);
  const { isSignedIn } = useAuth();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // `selectedIssueIds.size > 1` matches `useIssueMultiSelect`'s
  // `isMultiSelectActive` definition. We don't call the hook from web-core
  // here because it lives in web-core already — we just need the boolean
  // to gate tree card drag.
  const selectedIssueCount = useIssueSelectionStore(
    (s) => s.selectedIssueIds.size
  );
  const isMultiSelectActive = selectedIssueCount > 1;
  // Register CMD+K shortcut globally for all routes under SharedAppLayout
  useCommandBarShortcut(() => CommandBarDialog.show());

  // Apply mobile font scale CSS variable
  useEffect(() => {
    if (!isMobile) {
      document.documentElement.style.removeProperty('--mobile-font-scale');
      return;
    }
    const scaleMap = { default: '1', small: '0.9', smaller: '0.8' } as const;
    document.documentElement.style.setProperty(
      '--mobile-font-scale',
      scaleMap[mobileFontScale]
    );
    return () => {
      document.documentElement.style.removeProperty('--mobile-font-scale');
    };
  }, [isMobile, mobileFontScale]);

  // Sidebar state - organizations and projects
  const { data: orgsData } = useUserOrganizations();
  const organizations = useMemo(
    () => orgsData?.organizations ?? [],
    [orgsData?.organizations]
  );

  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);

  // Auto-select first org if none selected or selection is invalid
  useEffect(() => {
    if (organizations.length === 0) return;

    const hasValidSelection = selectedOrgId
      ? organizations.some((org) => org.id === selectedOrgId)
      : false;

    if (!selectedOrgId || !hasValidSelection) {
      const firstNonPersonal = organizations.find((org) => !org.is_personal);
      setSelectedOrgId((firstNonPersonal ?? organizations[0]).id);
    }
  }, [organizations, selectedOrgId, setSelectedOrgId]);

  const projectParams = useMemo(
    () => ({ organization_id: selectedOrgId || '' }),
    [selectedOrgId]
  );
  const { data: orgProjects = [], isLoading } = useShape(
    PROJECTS_SHAPE,
    projectParams,
    {
      enabled: isSignedIn && !!selectedOrgId,
      mutation: PROJECT_MUTATION,
    }
  );
  const sortedProjects = useMemo(
    () => sortProjectsByOrder(orgProjects),
    [orgProjects]
  );
  const [orderedProjects, setOrderedProjects] =
    useState<RemoteProject[]>(sortedProjects);
  // The gate effect (below) is the single setter for the Tasks-loader gate
  // set — it derives the gate from the persisted open-state blob once the
  // live project list is known. The previous up-front hydration was
  // superseded by that derivation (which uses the central `isTasksSectionOpen`
  // rule via `deriveOpenTasksProjectIds`).
  const [openTasksProjectIds, setOpenTasksProjectIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [tasksByProject, setTasksByProject] = useState<
    ReadonlyMap<string, ProjectTasksData>
  >(() => new Map());
  const [loadingTasksProjectIds, setLoadingTasksProjectIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    setOrderedProjects(sortedProjects);
  }, [sortedProjects]);

  // Navigation state for the left sidebar.
  const projectDestination = useMemo(
    () => getProjectDestination(currentDestination),
    [currentDestination]
  );
  const activeProjectId = projectDestination?.projectId ?? null;

  // Persist last selected project to scratch store
  const setSelectedProjectId = useUiPreferencesStore(
    (s) => s.setSelectedProjectId
  );
  useEffect(() => {
    if (activeProjectId) {
      setSelectedProjectId(activeProjectId);
    }
  }, [activeProjectId, setSelectedProjectId]);

  const handleTasksByProject = useCallback(
    (map: ReadonlyMap<string, ProjectTasksData>) => setTasksByProject(map),
    []
  );
  const handleLoadingTasks = useCallback(
    (projectIds: ReadonlySet<string>) => setLoadingTasksProjectIds(projectIds),
    []
  );
  const handleTasksExpansionChange = useCallback(
    (projectId: string, isOpen: boolean) => {
      setOpenTasksProjectIds((previous) => {
        const next = new Set(previous);
        if (isOpen) next.add(projectId);
        else next.delete(projectId);
        return next;
      });
    },
    []
  );
  const handleSelectIssue = useCallback(
    (projectId: string, issueId: string) => {
      appNavigation.goToProjectIssue(projectId, issueId);
    },
    [appNavigation]
  );

  const handleProjectClick = useCallback(
    (projectId: string) => {
      appNavigation.goToProject(projectId);
    },
    [appNavigation]
  );

  const handleCreateProject = useCallback(async () => {
    if (!selectedOrgId) return;

    try {
      const result: CreateRemoteProjectResult =
        await CreateRemoteProjectDialog.show({ organizationId: selectedOrgId });

      if (result.action === 'created' && result.project) {
        appNavigation.goToProject(result.project.id);
      }
    } catch {
      // Dialog cancelled — no-op.
    }
  }, [selectedOrgId, appNavigation]);

  // ADR-007: project reorder is disabled tree-wide (see PLAN-sidebar-kanban-cross-dnd);
  // project order is set by the sorted-projects effect below only.

  // ---------------------------------------------------------------------
  // Cross-surface drag-and-drop (ADR-012)
  // ---------------------------------------------------------------------
  //
  // `<DragProvider>` mounts here so its `DragController` can resolve a
  // single drag between the sidebar tree (sidebar contains
  // SidebarProjectTree) and the kanban board (Outlet: KanbanContainer).
  // `resolveDragEnd` classifies each drop; the kanban-internal path
  // delegates to the handler registered through
  // KanbanDragHandlerContext, while cross-surface / tree-internal moves
  // fire `bulkUpdateIssues` directly.
  //
  // `activeProjectId` and `issuesById` are read as values (not closures
  // over stale state) so each render gets a fresh dep array.
  const kanbanHandlerRef = useRef<KanbanDragHandler | null>(null);
  const registerKanbanHandler = useCallback((handler: KanbanDragHandler) => {
    kanbanHandlerRef.current = handler;
    return () => {
      kanbanHandlerRef.current = null;
    };
  }, []);
  const providerValue = useMemo(
    () => ({ registerHandler: registerKanbanHandler }),
    [registerKanbanHandler]
  );

  // Subscribe the active project's issues for the DnD resolver. The
  // shape collection dedupes with the kanban's ProjectProvider, so this
  // doesn't add network cost — it just lifts the project→id index up so
  // resolveDragEnd can verify the source issue and disambiguate
  // bare-UUID kanban columns from card targets.
  const activeProjectParams = useMemo<Record<string, string>>(
    () =>
      activeProjectId
        ? { project_id: activeProjectId as string }
        : ({ project_id: '' } as Record<string, string>),
    [activeProjectId]
  );
  const activeProjectIssues = useShape(
    PROJECT_ISSUES_SHAPE,
    activeProjectParams,
    {
      enabled: Boolean(activeProjectId),
    }
  );
  const activeProjectStatuses = useShape(
    PROJECT_PROJECT_STATUSES_SHAPE,
    activeProjectParams,
    {
      enabled: Boolean(activeProjectId),
    }
  );
  const issuesById = useMemo(() => {
    const map = new Map<
      string,
      { id: string; project_id: string; status_id: string }
    >();
    if (!activeProjectId) return map;
    for (const issue of activeProjectIssues.data) {
      // Defensive: a shape row from a stale project must never leak into
      // the resolver.
      if (issue.project_id !== activeProjectId) continue;
      map.set(issue.id, {
        id: issue.id,
        project_id: issue.project_id,
        status_id: issue.status_id,
      });
    }
    return map;
  }, [activeProjectIssues.data, activeProjectId]);
  // The active project's visible status-id set. The resolver threads
  // this through to `resolveDragEnd` so a stale `data-drop-target-id`
  // attr pointing at a deleted status is rejected instead of routing
  // a move into a `status_id` that no longer exists.
  const statusIds = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    if (!activeProjectId) return set;
    for (const status of activeProjectStatuses.data) {
      set.add(status.id);
    }
    return set;
  }, [activeProjectStatuses.data, activeProjectId]);

  // Latest-value refs for the cross-surface handler. Reading
  // activeProjectId / issuesById / statusIds through refs (not
  // useCallback deps) keeps the handler identity STABLE across renders.
  const dndContextRef = useRef({
    activeProjectId,
    issuesById,
    statusIds,
    selectedOrgId,
  });
  dndContextRef.current = {
    activeProjectId,
    issuesById,
    statusIds,
    selectedOrgId,
  };

  // Mirror of orderedProjects as a ref so the drag-end callback reads
  // the live post-swap state without re-creating the callback when
  // orderedProjects changes.
  const orderedProjectsRef = useRef(orderedProjects);
  orderedProjectsRef.current = orderedProjects;

  const handleCrossSurfaceDragEnd = useCallback(
    (completion: DragCompletion) => {
      const {
        activeProjectId: projectId,
        issuesById: byId,
        statusIds: statusIdsForResolve,
        selectedOrgId: orgId,
      } = dndContextRef.current;
      const outcome = resolveDragEnd(
        completion,
        projectId,
        byId,
        statusIdsForResolve
      );
      switch (outcome.type) {
        case 'no-op':
          return;
        case 'invalid':
          // Snap-back is automatic when no state change fires; console
          // for now so devs see why a drop was rejected during smoke.
          console.debug('[dnd] drop rejected:', outcome.reason);
          return;
        case 'kanban-internal':
          kanbanHandlerRef.current?.({
            issueId: outcome.issueId,
            fromStatusId: outcome.fromStatusId,
            toStatusId: outcome.toStatusId,
            destIndex: outcome.destIndex,
          });
          return;
        case 'move-issue':
          bulkUpdateIssues([
            {
              id: outcome.issueId,
              changes: { status_id: outcome.targetStatusId },
            },
          ])
            .then(() => {
              // bulkUpdateIssues bypasses the shape collection's mutation
              // handler (which would otherwise invalidate + refresh on its
              // own), so without this the sidebar tree + kanban only pick
              // up the move on the next ~30s fallback poll. Force-refresh
              // the active project's issues shape so the UI reflects the
              // drop immediately.
              refreshShapeSource(PROJECT_ISSUES_SHAPE, {
                project_id: outcome.projectId,
              });
            })
            .catch((err) => {
              console.error(
                '[dnd] cross-surface move failed:',
                err,
                'issue',
                outcome.issueId,
                '→ status',
                outcome.targetStatusId
              );
            });
          return;
        case 'project-reorder': {
          if (!orgId) return;
          const aId = outcome.projectId;
          const bId = outcome.targetProjectId;
          setOrderedProjects((prev) => {
            const ia = prev.findIndex((p) => p.id === aId);
            const ib = prev.findIndex((p) => p.id === bId);
            if (ia === -1 || ib === -1) return prev;
            const next = prev.slice();
            [next[ia], next[ib]] = [next[ib], next[ia]];
            return next;
          });
          // Recompute sort_order for the WHOLE ordered list (not just the
          // swapped pair). default `sort_order=0` on every project makes
          // a pairwise swap a no-op under the created_at tiebreak in
          // `sortProjectsByOrder`; rewriting all rows normalizes the field
          // and lets the tiebreak yield to the swap.
          const cur = orderedProjectsRef.current;
          const ia = cur.findIndex((p) => p.id === aId);
          const ib = cur.findIndex((p) => p.id === bId);
          if (ia === -1 || ib === -1) return;
          const swapped = cur.slice();
          [swapped[ia], swapped[ib]] = [swapped[ib], swapped[ia]];
          const STEP = 100;
          const updates = swapped.map((p, i) => ({
            id: p.id,
            changes: { sort_order: i * STEP },
          }));
          bulkUpdateProjects(updates)
            .then(() =>
              refreshShapeSource(PROJECTS_SHAPE, { organization_id: orgId })
            )
            .catch((err) => {
              console.error(
                '[dnd] project reorder failed:',
                err,
                aId,
                '↔',
                bId
              );
              refreshShapeSource(PROJECTS_SHAPE, { organization_id: orgId });
            });
          return;
        }
      }
    },
    []
  );

  const handleSignIn = useCallback(async () => {
    // Local-only fork: no OAuth flow.
  }, []);

  // Workspace tree data: derive membership from the remote-shape workspaces
  // exposed by UserContext, then surface active/archived lists from the
  // local workspace context so the tree stays in sync with live status.
  const membership = useWorkspaceProjectMembership();
  const {
    workspaceId,
    activeWorkspaces,
    archivedWorkspaces,
    isWorkspacesListLoading,
  } = useWorkspaceContext();

  const sidebarProjects = useMemo(
    () =>
      orderedProjects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    [orderedProjects]
  );
  const realProjectIds = useMemo(
    () => sidebarProjects.map((project) => project.id),
    [sidebarProjects]
  );

  // Enable the Tasks loader gate once the project list is known. The
  // persistence rule ("open unless explicitly closed") lives in
  // `@vibe/ui/components/outliner/openState.isTasksSectionOpen` and is applied
  // here via `deriveOpenTasksProjectIds` — single source of truth, no inline
  // re-derivation. Projects load asynchronously, so we must NOT run this while
  // realProjectIds is still empty — deriving then would drop every project's
  // gate before it ever arrives (reload loses all open Tasks).
  useEffect(() => {
    if (realProjectIds.length === 0) return;
    const stored = readSidebarTreeOpenState(new Set(realProjectIds));
    setOpenTasksProjectIds(() =>
      deriveOpenTasksProjectIds(stored, realProjectIds)
    );
  }, [realProjectIds]);

  // Single mapper used by both active and archived OutlinerWorkspace memos.
  // SidebarWorkspace is the union element type for both source arrays.
  const toOutlinerWorkspace = (ws: SidebarWorkspace): OutlinerWorkspace => ({
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
  });

  const outlinerWorkspaces = useMemo<OutlinerWorkspace[]>(
    () => activeWorkspaces.map(toOutlinerWorkspace),
    [activeWorkspaces]
  );

  const outlinerArchivedWorkspaces = useMemo<OutlinerWorkspace[]>(
    () => archivedWorkspaces.map(toOutlinerWorkspace),
    [archivedWorkspaces]
  );

  return (
    <SyncErrorProvider>
      <DragProvider onDrop={handleCrossSurfaceDragEnd}>
        <KanbanDragHandlerProvider value={providerValue}>
          <SidebarProjectTasksRegistry
            projectIds={realProjectIds}
            openTasksProjectIds={openTasksProjectIds}
            onTasksByProject={handleTasksByProject}
            onLoadingTasksProjectIds={handleLoadingTasks}
          />
          <div
            className={cn(
              'bg-primary',
              isMobile
                ? 'flex fixed inset-0 pb-[env(safe-area-inset-bottom)]'
                : 'grid grid-cols-[256px_1fr] grid-rows-[minmax(0,1fr)] h-screen'
            )}
          >
            {!isMobile && (
              <>
                {/* Desktop sidebar: project tree + bottom notification/org/user
                slots. Spans the full left column; the top drag-region strip
                lives inside the Sidebar itself. */}
                <Sidebar
                  projects={sidebarProjects}
                  activeProjectId={activeProjectId}
                  activeWorkspaceId={workspaceId ?? null}
                  activeIssueId={activeIssueId}
                  tasksByProject={tasksByProject}
                  loadingTasksProjectIds={loadingTasksProjectIds}
                  onTasksExpansionChange={handleTasksExpansionChange}
                  onSelectIssue={handleSelectIssue}
                  workspaces={outlinerWorkspaces}
                  archivedWorkspaces={outlinerArchivedWorkspaces}
                  membership={membership}
                  isLoadingProjects={isLoading}
                  isLoadingWorkspaces={isWorkspacesListLoading}
                  onSelectWorkspace={(id) => appNavigation.goToWorkspace(id)}
                  onSelectProject={handleProjectClick}
                  isMultiSelectActive={isMultiSelectActive}
                  headerActions={
                    <CreateProjectButton onClick={handleCreateProject} />
                  }
                  bottomActions={<SidebarBottomActions />}
                />
                {/* Content column: Navbar on top, Outlet below. */}
                <div className="flex flex-col min-h-0 min-w-0">
                  <NavbarContainer onOpenDrawer={() => setIsDrawerOpen(true)} />
                  <div className="relative flex-1 min-h-0 overflow-hidden">
                    <Outlet />
                  </div>
                </div>
              </>
            )}

            {isMobile && (
              <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                <NavbarContainer
                  mobileMode={isMobile}
                  onOpenDrawer={() => setIsDrawerOpen(true)}
                />
                <div className="flex-1 min-h-0 overflow-hidden">
                  <Outlet />
                </div>
              </div>
            )}

            {/* Mobile project navigation drawer (rebuilt on the same Sidebar
            primitives). */}
            <MobileDrawer
              open={isDrawerOpen && isMobile}
              onClose={() => setIsDrawerOpen(false)}
            >
              <div className="flex flex-col h-full">
                {/* Header: org name + close button */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <span className="text-sm font-medium text-high truncate">
                    {organizations.find((o) => o.id === selectedOrgId)?.name ??
                      'Organization'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsDrawerOpen(false)}
                    className="p-1 rounded-sm text-low hover:text-normal cursor-pointer"
                    aria-label="Close"
                  >
                    <XIcon className="h-4 w-4" weight="bold" />
                  </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  <Sidebar
                    projects={sidebarProjects}
                    activeProjectId={activeProjectId}
                    activeWorkspaceId={workspaceId ?? null}
                    activeIssueId={activeIssueId}
                    tasksByProject={tasksByProject}
                    loadingTasksProjectIds={loadingTasksProjectIds}
                    onTasksExpansionChange={handleTasksExpansionChange}
                    onSelectIssue={handleSelectIssue}
                    workspaces={outlinerWorkspaces}
                    archivedWorkspaces={outlinerArchivedWorkspaces}
                    membership={membership}
                    isLoadingProjects={isLoading}
                    isLoadingWorkspaces={isWorkspacesListLoading}
                    onSelectWorkspace={(id) => appNavigation.goToWorkspace(id)}
                    onSelectProject={(id) => {
                      handleProjectClick(id);
                      setIsDrawerOpen(false);
                    }}
                    isMultiSelectActive={isMultiSelectActive}
                    headerActions={
                      <CreateProjectButton onClick={handleCreateProject} />
                    }
                    bottomActions={<SidebarBottomActions />}
                  />
                </div>

                {!isSignedIn && (
                  <div className="p-3 border-t border-border">
                    <div className="px-4 py-6 text-center">
                      <KanbanIcon
                        className="h-8 w-8 mx-auto text-low"
                        weight="bold"
                      />
                      <p className="mt-3 text-sm font-medium text-high">
                        Kanban Boards
                      </p>
                      <p className="mt-1 text-xs text-low">
                        Sign in to organise your coding agents with kanban
                        boards.
                      </p>
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => {
                            handleSignIn();
                            setIsDrawerOpen(false);
                          }}
                          className="w-full px-3 py-2 rounded-md text-sm font-medium bg-brand text-on-brand hover:bg-brand-hover cursor-pointer"
                        >
                          Sign in
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </MobileDrawer>
          </div>
        </KanbanDragHandlerProvider>
      </DragProvider>
    </SyncErrorProvider>
  );
}
