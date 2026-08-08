export type AppDestination =
  | { kind: 'root' }
  | { kind: 'onboarding' }
  | { kind: 'workspaces'; hostId?: string }
  | { kind: 'chat' }
  | { kind: 'workspaces-create'; hostId?: string }
  | { kind: 'workspace'; workspaceId: string; hostId?: string }
  | { kind: 'workspace-vscode'; workspaceId: string; hostId?: string }
  | { kind: 'common-tasks' }
  | { kind: 'project'; projectId: string }
  | {
      kind: 'project-issue';
      projectId: string;
      issueId: string;
    }
  | {
      kind: 'project-issue-workspace';
      projectId: string;
      issueId: string;
      workspaceId: string;
      hostId?: string;
    }
  | {
      kind: 'project-issue-workspace-create';
      projectId: string;
      issueId: string;
      draftId: string;
      hostId?: string;
    }
  | {
      kind: 'project-workspace-create';
      projectId: string;
      draftId: string;
      hostId?: string;
    }
  // ADR-016: full-pane editor for the per-project orchestrator prompt.
  // `sidebarMode: 'closed'` — the editor IS the page, not a kanban side
  // panel. Wired to the prompt row's onActivate and the `+` menu's
  // "Orchestrator prompt" item.
  | { kind: 'project-orchestrator-prompt'; projectId: string }
  // Sub-issue board (2026-08-07): a full-page kanban of one parent issue's
  // children grouped by status. `parentIssueId` is the parent whose
  // children are shown. `sidebarMode: 'closed'` — it's its own page.
  | {
      kind: 'project-issue-sub-board';
      projectId: string;
      parentIssueId: string;
    };

export type NavigationTransition = {
  replace?: boolean;
};

export interface AppNavigation {
  resolveFromPath(path: string): AppDestination | null;
  goToRoot(transition?: NavigationTransition): void;
  goToOnboarding(transition?: NavigationTransition): void;
  goToWorkspaces(transition?: NavigationTransition): void;
  goToChat(transition?: NavigationTransition): void;
  goToWorkspacesCreate(transition?: NavigationTransition): void;
  goToWorkspace(workspaceId: string, transition?: NavigationTransition): void;
  goToWorkspaceVsCode(
    workspaceId: string,
    transition?: NavigationTransition
  ): void;
  goToCommonTasks(transition?: NavigationTransition): void;
  goToProject(projectId: string, transition?: NavigationTransition): void;
  goToProjectIssue(
    projectId: string,
    issueId: string,
    transition?: NavigationTransition
  ): void;
  goToProjectIssueWorkspace(
    projectId: string,
    issueId: string,
    workspaceId: string,
    transition?: NavigationTransition
  ): void;
  goToProjectIssueWorkspaceCreate(
    projectId: string,
    issueId: string,
    draftId: string,
    transition?: NavigationTransition
  ): void;
  goToProjectWorkspaceCreate(
    projectId: string,
    draftId: string,
    transition?: NavigationTransition
  ): void;
  goToProjectOrchestratorPrompt(
    projectId: string,
    transition?: NavigationTransition
  ): void;
  goToProjectIssueSubBoard(
    projectId: string,
    parentIssueId: string,
    transition?: NavigationTransition
  ): void;
}

type ProjectDestinationKind =
  | 'project'
  | 'project-issue'
  | 'project-issue-workspace'
  | 'project-issue-workspace-create'
  | 'project-workspace-create'
  | 'project-orchestrator-prompt'
  | 'project-issue-sub-board';

type WorkspaceDestinationKind =
  | 'workspaces'
  | 'workspaces-create'
  | 'workspace'
  | 'workspace-vscode';

export type ProjectDestination = Extract<
  AppDestination,
  { kind: ProjectDestinationKind }
>;

export type WorkspaceDestination = Extract<
  AppDestination,
  { kind: WorkspaceDestinationKind }
>;

export type KanbanSidebarMode =
  | 'closed'
  | 'issue'
  | 'issue-workspace'
  | 'workspace-create';

export interface KanbanRouteState {
  hostId: string | null;
  projectId: string | null;
  issueId: string | null;
  workspaceId: string | null;
  draftId: string | null;
  sidebarMode: KanbanSidebarMode | null;
  isCreateMode: boolean;
  isWorkspaceCreateMode: boolean;
  hasInvalidWorkspaceCreateDraftId: boolean;
  isPanelOpen: boolean;
  /** Sub-issue board mode (2026-08-07): when set, the regular kanban board
   *  is filtered to show only the children of this parent issue. */
  parentIssueId: string | null;
}

export function getDestinationHostId(
  destination: AppDestination | null
): string | null {
  if (!destination || !('hostId' in destination)) {
    return null;
  }

  return destination.hostId ?? null;
}

export function isProjectDestination(
  destination: AppDestination | null
): destination is ProjectDestination {
  if (!destination) {
    return false;
  }

  switch (destination.kind) {
    case 'project':
    case 'project-issue':
    case 'project-issue-workspace':
    case 'project-issue-workspace-create':
    case 'project-workspace-create':
    case 'project-orchestrator-prompt':
    case 'project-issue-sub-board':
      return true;
    default:
      return false;
  }
}

export function isWorkspacesDestination(
  destination: AppDestination | null
): destination is WorkspaceDestination {
  if (!destination) {
    return false;
  }

  switch (destination.kind) {
    case 'workspaces':
    case 'workspaces-create':
    case 'workspace':
    case 'workspace-vscode':
      return true;
    default:
      return false;
  }
}

export function isWorkspacesDashboardDestination(
  destination: AppDestination | null
): boolean {
  return destination?.kind === 'workspaces';
}

export function isWorkspaceChatDestination(
  destination: AppDestination | null
): boolean {
  return destination?.kind === 'chat' || destination?.kind === 'workspace';
}
export function isLocalWorkspacesDestination(
  destination: AppDestination | null
): destination is WorkspaceDestination {
  return (
    isWorkspacesDestination(destination) &&
    getDestinationHostId(destination) === null
  );
}

export function isRemoteWorkspacesDestination(
  destination: AppDestination | null
): destination is WorkspaceDestination {
  return (
    isWorkspacesDestination(destination) &&
    getDestinationHostId(destination) !== null
  );
}

export function getProjectDestination(
  destination: AppDestination | null
): ProjectDestination | null {
  return isProjectDestination(destination) ? destination : null;
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function resolveKanbanRouteState(
  destination: AppDestination | null
): KanbanRouteState {
  const projectDestination = getProjectDestination(destination);
  const projectId = projectDestination?.projectId ?? null;
  const hostId = getDestinationHostId(projectDestination);

  const issueId = (() => {
    if (!projectDestination) {
      return null;
    }

    switch (projectDestination.kind) {
      case 'project-issue':
      case 'project-issue-workspace':
      case 'project-issue-workspace-create':
        return projectDestination.issueId;
      default:
        return null;
    }
  })();

  const workspaceId =
    projectDestination?.kind === 'project-issue-workspace'
      ? projectDestination.workspaceId
      : null;

  const rawDraftId =
    projectDestination?.kind === 'project-issue-workspace-create' ||
    projectDestination?.kind === 'project-workspace-create'
      ? projectDestination.draftId
      : null;
  const draftId = rawDraftId && isValidUuid(rawDraftId) ? rawDraftId : null;

  const hasInvalidWorkspaceCreateDraftId =
    (projectDestination?.kind === 'project-issue-workspace-create' ||
      projectDestination?.kind === 'project-workspace-create') &&
    rawDraftId !== null &&
    !draftId;

  const isWorkspaceCreateMode =
    (projectDestination?.kind === 'project-issue-workspace-create' ||
      projectDestination?.kind === 'project-workspace-create') &&
    draftId !== null;

  const sidebarMode = (() => {
    if (!projectDestination) {
      return null;
    }

    switch (projectDestination.kind) {
      case 'project':
      case 'project-orchestrator-prompt':
      case 'project-issue-sub-board':
        // ADR-016 / sub-issue board: the page IS the content.
        // `sidebarMode: 'closed'` collapses the kanban side panel — there's
        // no card to edit.
        return 'closed';
      case 'project-issue':
        return 'issue';
      case 'project-issue-workspace':
        return 'issue-workspace';
      case 'project-issue-workspace-create':
      case 'project-workspace-create':
        return 'workspace-create';
    }
  })();

  return {
    hostId,
    projectId,
    issueId,
    workspaceId,
    draftId,
    sidebarMode,
    // Issue-create mode is route-independent and derived from composer state.
    isCreateMode: false,
    isWorkspaceCreateMode,
    hasInvalidWorkspaceCreateDraftId,
    // ADR-016: the orchestrator-prompt editor is a full-pane route —
    // the kanban side panel is OFF. Only issue/workspace flows open
    // the panel.
    isPanelOpen:
      !!projectDestination &&
      projectDestination.kind !== 'project' &&
      projectDestination.kind !== 'project-orchestrator-prompt' &&
      projectDestination.kind !== 'project-issue-sub-board',
    // Sub-issue board: the parent whose children the board is filtered to.
    parentIssueId:
      projectDestination?.kind === 'project-issue-sub-board'
        ? projectDestination.parentIssueId
        : null,
  };
}
