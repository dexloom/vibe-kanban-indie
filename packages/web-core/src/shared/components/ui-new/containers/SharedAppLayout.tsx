import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DropResult } from '@hello-pangea/dnd';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { XIcon, KanbanIcon } from '@phosphor-icons/react';
import { SyncErrorProvider } from '@/shared/providers/SyncErrorProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';

import { NavbarContainer } from './NavbarContainer';
import { Sidebar } from '@vibe/ui/components/Sidebar';
import { MobileDrawer } from '@vibe/ui/components/MobileDrawer';
import { AppBarUserPopoverContainer } from './AppBarUserPopoverContainer';
import { OrganizationSwitcherButton } from './OrganizationSwitcherButton';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';
import { useAuth } from '@/shared/hooks/auth/useAuth';

import { useAppUpdateStore } from '@/shared/stores/useAppUpdateStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import {
  getProjectDestination,
  isWorkspacesDashboardDestination,
  isWorkspaceChatDestination,
} from '@/shared/lib/routes/appNavigation';
import {
  CreateRemoteProjectDialog,
  type CreateRemoteProjectResult,
} from '@/shared/dialogs/org/CreateRemoteProjectDialog';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { useCommandBarShortcut } from '@/shared/hooks/useCommandBarShortcut';
import { useShape } from '@/shared/integrations/electric/hooks';
import { sortProjectsByOrder } from '@/shared/lib/projectOrder';
import {
  PROJECT_MUTATION,
  PROJECTS_SHAPE,
  type Project as RemoteProject,
} from 'shared/remote-types';
import { AppBarNotificationBellContainer } from '@/pages/workspaces/AppBarNotificationBellContainer';

export function SharedAppLayout() {
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const isMobile = useIsMobile();
  const mobileFontScale = useUiPreferencesStore((s) => s.mobileFontScale);
  const { isSignedIn } = useAuth();
  // Display the build-time product version (bumped by the release process in
  // package.json), not the backend crate version which is tracked separately.
  const appVersion = __APP_VERSION__;
  const updateVersion = useAppUpdateStore((s) => s.updateVersion);
  const restartForUpdate = useAppUpdateStore((s) => s.restart);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const navigate = useNavigate();
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
  const {
    data: orgProjects = [],
    isLoading,
    updateMany: updateManyProjects,
  } = useShape(PROJECTS_SHAPE, projectParams, {
    enabled: isSignedIn && !!selectedOrgId,
    mutation: PROJECT_MUTATION,
  });
  const sortedProjects = useMemo(
    () => sortProjectsByOrder(orgProjects),
    [orgProjects]
  );
  const [orderedProjects, setOrderedProjects] =
    useState<RemoteProject[]>(sortedProjects);
  const [isSavingProjectOrder, setIsSavingProjectOrder] = useState(false);

  useEffect(() => {
    if (isSavingProjectOrder) {
      return;
    }
    setOrderedProjects(sortedProjects);
  }, [isSavingProjectOrder, sortedProjects]);

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

  const handleProjectClick = useCallback(
    (projectId: string) => {
      appNavigation.goToProject(projectId);
    },
    [appNavigation]
  );

  const handleProjectsDragEnd = useCallback(
    async ({ source, destination }: DropResult) => {
      if (isSavingProjectOrder) {
        return;
      }
      if (!destination || source.index === destination.index) {
        return;
      }

      const previousOrder = orderedProjects;
      const reordered = [...orderedProjects];
      const [moved] = reordered.splice(source.index, 1);

      if (!moved) {
        return;
      }

      reordered.splice(destination.index, 0, moved);
      setOrderedProjects(reordered);
      setIsSavingProjectOrder(true);

      try {
        await updateManyProjects(
          reordered.map((project, index) => ({
            id: project.id,
            changes: { sort_order: index },
          }))
        ).persisted;
      } catch (error) {
        console.error('Failed to reorder projects:', error);
        setOrderedProjects(previousOrder);
      } finally {
        setIsSavingProjectOrder(false);
      }
    },
    [isSavingProjectOrder, orderedProjects, updateManyProjects]
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
      // Dialog cancelled
    }
  }, [selectedOrgId, appNavigation]);

  const handleSignIn = useCallback(async () => {
    // Local-only fork: no OAuth flow.
  }, []);

  // Workspaces shortcut: highlight when the user is on the workspaces
  // dashboard OR on a workspace/chat destination. Both predicates live in
  // @/shared/lib/routes/appNavigation.
  const isWorkspacesActive = useMemo(
    () =>
      isWorkspacesDashboardDestination(currentDestination) ||
      isWorkspaceChatDestination(currentDestination),
    [currentDestination]
  );

  const onOpenWorkspaces = useCallback(() => {
    void navigate({ to: '/workspaces' });
  }, [navigate]);

  return (
    <SyncErrorProvider>
      <div
        className={cn(
          'bg-primary',
          isMobile
            ? 'flex fixed inset-0 pb-[env(safe-area-inset-bottom)]'
            : 'grid grid-cols-[256px_1fr] h-screen'
        )}
      >
        {!isMobile && (
          <>
            {/* Desktop sidebar (Projects + Workspaces shortcut + bottom
                notification/org/user slots). Spans the full left column; the
                top drag-region strip lives inside the Sidebar itself. */}
            <Sidebar
              projects={orderedProjects}
              activeProjectId={activeProjectId}
              isSignedIn={isSignedIn}
              isLoadingProjects={isLoading}
              isSavingProjectOrder={isSavingProjectOrder}
              onProjectClick={handleProjectClick}
              onCreateProject={handleCreateProject}
              onProjectsDragEnd={handleProjectsDragEnd}
              onOpenWorkspaces={onOpenWorkspaces}
              isWorkspacesActive={isWorkspacesActive}
              notificationBell={
                isSignedIn ? <AppBarNotificationBellContainer /> : undefined
              }
              organizationsSwitcher={<OrganizationSwitcherButton />}
              userPopover={<AppBarUserPopoverContainer />}
              appVersion={appVersion}
              updateVersion={updateVersion}
              onUpdateClick={restartForUpdate ?? undefined}
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
                projects={orderedProjects}
                activeProjectId={activeProjectId}
                isSignedIn={isSignedIn}
                isLoadingProjects={isLoading}
                isSavingProjectOrder={isSavingProjectOrder}
                onProjectClick={(id) => {
                  handleProjectClick(id);
                  setIsDrawerOpen(false);
                }}
                onCreateProject={() => {
                  void handleCreateProject();
                  setIsDrawerOpen(false);
                }}
                onProjectsDragEnd={handleProjectsDragEnd}
                onOpenWorkspaces={() => {
                  onOpenWorkspaces();
                  setIsDrawerOpen(false);
                }}
                isWorkspacesActive={isWorkspacesActive}
                organizationsSwitcher={<OrganizationSwitcherButton />}
                userPopover={<AppBarUserPopoverContainer />}
                appVersion={appVersion}
                updateVersion={updateVersion}
                onUpdateClick={restartForUpdate ?? undefined}
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
                    Sign in to organise your coding agents with kanban boards.
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
    </SyncErrorProvider>
  );
}