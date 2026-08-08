import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { XIcon } from '@phosphor-icons/react';
import { SyncErrorProvider } from '@/shared/providers/SyncErrorProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';

import { NavbarContainer } from './NavbarContainer';
import { Sidebar } from '@vibe/ui/components/Sidebar';
import { MobileDrawer } from '@vibe/ui/components/MobileDrawer';
import { SidebarBottomActions } from './SidebarBottomActions';
import { SidebarProjectTasksRegistry } from '@/shared/components/sidebar/SidebarProjectTasksRegistry';

import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import type { ProjectTasksData } from '@vibe/ui/components/outliner/types';
import { getProjectDestination } from '@/shared/lib/routes/appNavigation';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import {
  CreateProjectDialog,
  type CreateProjectResult,
} from '@/shared/dialogs/CreateProjectDialog';
import { CreateProjectButton } from './CreateProjectButton';
import { useCommandBarShortcut } from '@/shared/hooks/useCommandBarShortcut';
import { useShape } from '@/shared/integrations/electric/hooks';
import { useProjects } from '@/shared/hooks/useProjects';
import { ProjectProvider } from '@/shared/providers/ProjectProvider';
import {
  sortProjectsByOrder,
  swapProjectSiblings,
} from '@/shared/lib/projectOrder';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
  type Project as RemoteProject,
} from 'shared/remote-types';
import { useWorkspaceProjectMembership } from '@/shared/hooks/useWorkspaceProjectMembership';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import type { OutlinerWorkspace } from '@vibe/ui/components/outliner/types';
import { DragProvider, type DragCompletion } from '@vibe/ui/components/dnd';
import { resolveDragEnd } from '@/shared/lib/resolveDragEnd';
import {
  persistIssues,
  persistIssueSwap,
  persistProjectReorder,
} from '@/shared/lib/persistIssues';
import {
  buildIssueDragLookup,
  type IssueDragLookupRow,
} from '@/shared/lib/issueLookup';
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

  // Sidebar state - projects (ADR-018: tenant-less, no org selection)
  const { data: projects = [], isLoading } = useProjects();
  const sortedProjects = useMemo(
    () => sortProjectsByOrder(projects),
    [projects]
  );
  const [orderedProjects, setOrderedProjects] =
    useState<RemoteProject[]>(sortedProjects);
  // Collapse-by-default (2026-08-07): the per-project Tasks loaders run for
  // ALL live projects (see SidebarProjectTasksRegistry) so the open-task
  // count badges render while sections are collapsed. The previous
  // open-state-gated loader set is no longer needed.
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
  // ADR-016: when the editor pane is open, light up the prompt row in
  // the tree (drives `aria-current` + the active styling). Always
  // piggy-backs on `projectDestination` — the editor is scoped to a
  // single project.
  const activeProjectPromptId =
    currentDestination?.kind === 'project-orchestrator-prompt'
      ? currentDestination.projectId
      : null;

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
  const handleSelectIssue = useCallback(
    (projectId: string, issueId: string, parentIssueId?: string | null) => {
      // Clicking a sub-issue in the left pane opens it on its PARENT's board
      // (the sub-board route — the regular board filtered to the parent's
      // children), so the user sees the sub-issue in context with its
      // siblings. A top-level issue opens its own panel on the main board.
      if (parentIssueId) {
        appNavigation.goToProjectIssueSubBoard(projectId, parentIssueId);
      } else {
        appNavigation.goToProjectIssue(projectId, issueId);
      }
    },
    [appNavigation]
  );

  const handleProjectClick = useCallback(
    (projectId: string) => {
      appNavigation.goToProject(projectId);
    },
    [appNavigation]
  );

  // Collapse-by-default (2026-08-07): the Workspaces section's open-page icon
  // opens the flat workspaces dashboard (per owner decision — there is no
  // per-project workspaces route).
  const handleOpenWorkspacesPage = useCallback(() => {
    appNavigation.goToWorkspaces();
  }, [appNavigation]);

  // ADR-016: open the per-project orchestrator-prompt editor pane.
  // Triggered by the sidebar tree's `+` menu item and the prompt row's
  // click. The editor IS the page (sidebar mode: 'closed').
  const handleSelectOrchestratorPrompt = useCallback(
    (projectId: string) => {
      appNavigation.goToProjectOrchestratorPrompt(projectId);
    },
    [appNavigation]
  );

  const handleCreateProject = useCallback(async () => {
    try {
      const result: CreateProjectResult = await CreateProjectDialog.show({});

      if (result.action === 'created' && result.project) {
        appNavigation.goToProject(result.project.id);
      }
    } catch {
      // Dialog cancelled — no-op.
    }
  }, [appNavigation]);

  // ADR-015: open the project-create dialog with `parentId` set so the new
  // project is created as a child board of the supplied project id. The
  // returned project is the child (regardless of depth), so navigation
  // targets the child's kanban directly.
  const handleCreateChildBoard = useCallback(
    async (parentId: string) => {
      try {
        const result: CreateProjectResult = await CreateProjectDialog.show({
          parentId,
        });

        if (result.action === 'created' && result.project) {
          appNavigation.goToProject(result.project.id);
        }
      } catch {
        // Dialog cancelled — no-op.
      }
    },
    [appNavigation]
  );

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
    if (!activeProjectId) return new Map<string, IssueDragLookupRow>();
    return buildIssueDragLookup(activeProjectIssues.data, activeProjectId);
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
  });
  dndContextRef.current = {
    activeProjectId,
    issuesById,
    statusIds,
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
            index: outcome.index ?? undefined,
          });
          return;
        case 'issue-swap': {
          const sourceIssue = byId.get(outcome.sourceIssueId);
          const targetIssue = byId.get(outcome.targetIssueId);
          if (!sourceIssue || !targetIssue) return;
          // Prefer the kanban board's handler: it commits the swap to the
          // local items map optimistically, so the drop doesn't flash back
          // to the old order while the shape refresh round-trips. Fall back
          // to a direct bulkUpdate when no board is mounted (tree-only view).
          //
          // P5-E6: the tree-only fallback is intentionally NOT gated on the
          // sort field. `issue-swap` candidates come from the card-on-card
          // (same-column swap) target path; the controller filters card
          // targets to `data-drop-target-status === source.statusId`, so a
          // and b necessarily share the same column. The kanban handler
          // already applies its own `isManualSort` gate inside
          // `handleKanbanMove` (P4-D2). The fallback below is ONLY
          // reachable when no board is mounted (tree-only view) — i.e. the
          // sort field lives in the board's filter store, which isn't
          // accessible here. Without a board, there's no sort-mode state to
          // gate on. The kanban handler is responsible for the
          // non-manual-sort no-op; this fallback just writes the swap.
          //
          // Log label matches `KanbanContainer.tsx:809`'s `'[dnd] kanban
          // swap failed:'` so a developer grep-ing for swap failures sees
          // both paths under the same label.
          if (kanbanHandlerRef.current) {
            kanbanHandlerRef.current({
              issueId: sourceIssue.id,
              fromStatusId: sourceIssue.status_id,
              toStatusId: targetIssue.status_id,
              swapWithIssueId: targetIssue.id,
            });
            return;
          }
          persistIssueSwap(sourceIssue, targetIssue, outcome.projectId, {
            onError: (err) => console.error('[dnd] kanban swap failed:', err),
          });
          return;
        }
        case 'move-issue':
          persistIssues(
            [
              {
                id: outcome.issueId,
                changes: { status_id: outcome.targetStatusId },
              },
            ],
            outcome.projectId,
            {
              onError: (err) =>
                console.error(
                  '[dnd] cross-surface move failed:',
                  err,
                  'issue',
                  outcome.issueId,
                  '→ status',
                  outcome.targetStatusId
                ),
            }
          );
          return;
        case 'project-reorder': {
          const aId = outcome.projectId;
          const bId = outcome.targetProjectId;
          const cur = orderedProjectsRef.current;
          const a = cur.find((p) => p.id === aId);
          const b = cur.find((p) => p.id === bId);
          // F-8: cross-parent reorder is out of scope (DnD's
          // `collectTargets` sibling filter currently screens this, but
          // a future relaxed filter would otherwise flow into a no-op
          // optimistic update + wasted DB write). Bail before the swap.
          if (!a || !b || (a.parent_id ?? null) !== (b.parent_id ?? null)) {
            return;
          }
          const swappedAll = swapProjectSiblings(cur, aId, bId);
          // Belt-and-suspenders: `swapProjectSiblings` always returns a
          // fresh array (see `projectOrder.test.ts`), so this identity
          // check is currently dead. Kept so a future change to its
          // contract (return-on-no-op) keeps the no-op behaviour intact.
          if (swappedAll === cur) return;
          orderedProjectsRef.current = swappedAll;
          setOrderedProjects(swappedAll);
          // ADR-013 / F-7: persist ONLY the swapped sibling group, not the
          // whole project list. Reassigning every project's sort_order
          // would rewrite unrelated sibling groups (other parents'
          // children) with a fresh i*STEP ladder and drift them away
          // from what the user actually moved. Slice to siblings of the
          // swapped pair's shared parent.
          const parentId =
            swappedAll.find((p) => p.id === aId)?.parent_id ?? null;
          const siblingGroup = swappedAll.filter(
            (p) => (p.parent_id ?? null) === parentId
          );
          // Renumber the sibling group's sort_order to a fresh ladder
          // (i*STEP). The default sort_order=0 on every project makes a
          // pairwise swap a no-op under the created_at tiebreak in
          // `sortProjectsByOrder`; rewriting just this group's rows
          // normalises the field and lets the tiebreak yield to the
          // swap. (P4-D3.)
          // ADR-018 — projects are tenant-less, no orgId param.
          persistProjectReorder(siblingGroup, {
            onError: (err) =>
              console.error(
                '[dnd] project reorder failed:',
                err,
                aId,
                '↔',
                bId
              ),
          });
          return;
        }
      }
    },
    []
  );

  // Workspace tree data: derive membership from the remote-shape workspaces
  // exposed by WorkspacesContext, then surface active/archived lists from the
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
      orderedProjects.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        parentId: p.parent_id ?? null,
        sortOrder: p.sort_order,
        // ADR-016: mirror wire `has_orchestrator_prompt` so the tree's
        // brand-coloured dot tracks the row on every refresh. The body
        // never ships on the list shape — the editor's `resolve` GET
        // fetches the resolved value with provenance.
        hasOrchestratorPrompt: p.has_orchestrator_prompt,
      })),
    [orderedProjects]
  );
  const realProjectIds = useMemo(
    () => sidebarProjects.map((project) => project.id),
    [sidebarProjects]
  );

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
            onTasksByProject={handleTasksByProject}
            onLoadingTasksProjectIds={handleLoadingTasks}
          />
          <ProjectProvider>
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
                  {/* Desktop sidebar: project tree + bottom notification/user
                slots. Spans the full left column; the top drag-region strip
                lives inside the Sidebar itself. */}
                  <Sidebar
                    projects={sidebarProjects}
                    activeProjectId={activeProjectId}
                    activeProjectPromptId={activeProjectPromptId}
                    activeWorkspaceId={workspaceId ?? null}
                    activeIssueId={activeIssueId}
                    tasksByProject={tasksByProject}
                    loadingTasksProjectIds={loadingTasksProjectIds}
                    onSelectIssue={handleSelectIssue}
                    workspaces={outlinerWorkspaces}
                    archivedWorkspaces={outlinerArchivedWorkspaces}
                    membership={membership}
                    isLoadingProjects={isLoading}
                    isLoadingWorkspaces={isWorkspacesListLoading}
                    onSelectWorkspace={(id) => appNavigation.goToWorkspace(id)}
                    onOpenProjectPage={handleProjectClick}
                    onOpenWorkspacesPage={handleOpenWorkspacesPage}
                    onSelectOrchestratorPrompt={handleSelectOrchestratorPrompt}
                    onCreateChildBoard={handleCreateChildBoard}
                    isMultiSelectActive={isMultiSelectActive}
                    headerActions={
                      <CreateProjectButton onClick={handleCreateProject} />
                    }
                    bottomActions={<SidebarBottomActions />}
                  />
                  {/* Content column: Navbar on top, Outlet below. */}
                  <div className="flex flex-col min-h-0 min-w-0">
                    <NavbarContainer
                      onOpenDrawer={() => setIsDrawerOpen(true)}
                    />
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
                  {/* Header: drawer close button. ADR-018 — no org name display. */}
                  <div className="flex items-center justify-end p-4 border-b border-border">
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
                      activeProjectPromptId={activeProjectPromptId}
                      activeWorkspaceId={workspaceId ?? null}
                      activeIssueId={activeIssueId}
                      tasksByProject={tasksByProject}
                      loadingTasksProjectIds={loadingTasksProjectIds}
                      onSelectIssue={handleSelectIssue}
                      workspaces={outlinerWorkspaces}
                      archivedWorkspaces={outlinerArchivedWorkspaces}
                      membership={membership}
                      isLoadingProjects={isLoading}
                      isLoadingWorkspaces={isWorkspacesListLoading}
                      onSelectWorkspace={(id) =>
                        appNavigation.goToWorkspace(id)
                      }
                      onOpenProjectPage={(id) => {
                        handleProjectClick(id);
                        setIsDrawerOpen(false);
                      }}
                      onOpenWorkspacesPage={() => {
                        handleOpenWorkspacesPage();
                        setIsDrawerOpen(false);
                      }}
                      onSelectOrchestratorPrompt={(id) => {
                        handleSelectOrchestratorPrompt(id);
                        setIsDrawerOpen(false);
                      }}
                      onCreateChildBoard={handleCreateChildBoard}
                      isMultiSelectActive={isMultiSelectActive}
                      headerActions={
                        <CreateProjectButton onClick={handleCreateProject} />
                      }
                      bottomActions={<SidebarBottomActions />}
                    />
                  </div>
                </div>
              </MobileDrawer>
            </div>
          </ProjectProvider>
        </KanbanDragHandlerProvider>
      </DragProvider>
    </SyncErrorProvider>
  );
}
