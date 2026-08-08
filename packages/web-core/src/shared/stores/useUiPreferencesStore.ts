import { useCallback, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { RepoAction } from '@vibe/ui/components/RepoCard';
import type { IssuePriority } from 'shared/remote-types';

export const RIGHT_MAIN_PANEL_MODES = {
  CHANGES: 'changes',
  LOGS: 'logs',
  PREVIEW: 'preview',
} as const;

export type RightMainPanelMode =
  (typeof RIGHT_MAIN_PANEL_MODES)[keyof typeof RIGHT_MAIN_PANEL_MODES];

export type LayoutMode = 'workspaces' | 'kanban';

export type MobileTab =
  | 'workspaces'
  | 'chat'
  | 'changes'
  | 'logs'
  | 'preview'
  | 'git';

export type MobileFontScale = 'default' | 'small' | 'smaller';
export const DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT = false;

const MOBILE_FONT_SCALE_KEY = 'vk-mobile-font-scale';

const loadMobileFontScale = (): MobileFontScale => {
  try {
    const stored = localStorage.getItem(MOBILE_FONT_SCALE_KEY);
    if (stored === 'small' || stored === 'smaller') return stored;
  } catch {
    // localStorage may be unavailable
  }
  return 'default';
};

// Theme variant ("skin") is a client-side visual preference applied on top
// of the Light/Dark/System mode. 'default' means no extra theme (the built-in
// look). Other values map to a drop-in CSS file under /themes/<id>.css.
export type ThemeVariant = string;
export const DEFAULT_THEME_VARIANT: ThemeVariant = 'default';

const THEME_VARIANT_KEY = 'vk-theme-variant';

// Persisted default pipeline id (single-select). Remembered so the next issue
// created starts on the operator's last-chosen pipeline.
const DEFAULT_PIPELINE_KEY = 'vk-default-pipeline';

const loadDefaultPipelineId = (): string | null => {
  try {
    const stored = localStorage.getItem(DEFAULT_PIPELINE_KEY);
    if (stored) return stored;
  } catch {
    // localStorage may be unavailable
  }
  return null;
};

// Animated (shimmering) border around the message box while the workspace is
// working. A subtle pulsating dot always shows; this toggles the border on top.
const ANIMATE_RUNNING_OUTLINE_KEY = 'vk-animate-running-outline';

const loadAnimateRunningOutline = (): boolean => {
  try {
    const stored = localStorage.getItem(ANIMATE_RUNNING_OUTLINE_KEY);
    if (stored !== null) return stored !== 'false';
  } catch {
    // localStorage may be unavailable
  }
  return true;
};

const loadThemeVariant = (): ThemeVariant => {
  try {
    const stored = localStorage.getItem(THEME_VARIANT_KEY);
    if (stored && stored !== DEFAULT_THEME_VARIANT) return stored;
  } catch {
    // localStorage may be unavailable
  }
  return DEFAULT_THEME_VARIANT;
};

export type KanbanViewMode = 'kanban' | 'list';

export type ContextBarPosition =
  | 'top-left'
  | 'top-right'
  | 'middle-left'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-right';

// Workspace-specific panel state
export type WorkspacePanelState = {
  rightMainPanelMode: RightMainPanelMode | null;
  isLeftMainPanelVisible: boolean;
};

const DEFAULT_WORKSPACE_PANEL_STATE: WorkspacePanelState = {
  rightMainPanelMode: null,
  isLeftMainPanelVisible: true,
};

// Kanban filter state
export type KanbanSortField =
  | 'sort_order'
  | 'priority'
  | 'created_at'
  | 'updated_at'
  | 'title';

export type KanbanFilterState = {
  searchQuery: string;
  priorities: IssuePriority[];
  tagIds: string[];
  sortField: KanbanSortField;
  sortDirection: 'asc' | 'desc';
};

export const DEFAULT_KANBAN_FILTER_STATE: KanbanFilterState = {
  searchQuery: '',
  priorities: [],
  tagIds: [],
  sortField: 'sort_order',
  sortDirection: 'asc',
};

export const KANBAN_PROJECT_VIEW_IDS = {
  TEAM: 'team',
  PERSONAL: 'personal',
} as const;

export const DEFAULT_KANBAN_PROJECT_VIEW_ID = KANBAN_PROJECT_VIEW_IDS.TEAM;
export const DEFAULT_KANBAN_SHOW_WORKSPACES = true;
export const DEFAULT_KANBAN_HIDE_BLOCKED = false;

export const getDefaultShowSubIssuesForView = (viewId: string): boolean =>
  viewId === KANBAN_PROJECT_VIEW_IDS.PERSONAL;

export type KanbanProjectView = {
  id: string;
  name: string;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

export type KanbanProjectViewSelection = {
  activeViewId: string;
};

export type KanbanProjectViewPreferences = {
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

export type ResolvedKanbanProjectState = {
  activeViewId: string;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hideBlocked: boolean;
};

const cloneKanbanFilters = (filters: KanbanFilterState): KanbanFilterState => ({
  searchQuery: filters.searchQuery,
  priorities: [...filters.priorities],
  tagIds: [...filters.tagIds],
  sortField: filters.sortField,
  sortDirection: filters.sortDirection,
});

const isKanbanProjectViewId = (
  viewId: string
): viewId is (typeof KANBAN_PROJECT_VIEW_IDS)[keyof typeof KANBAN_PROJECT_VIEW_IDS] =>
  viewId === KANBAN_PROJECT_VIEW_IDS.TEAM ||
  viewId === KANBAN_PROJECT_VIEW_IDS.PERSONAL;

const getKanbanDefaultView = (viewId: string): KanbanProjectView => {
  if (viewId === KANBAN_PROJECT_VIEW_IDS.PERSONAL) {
    return {
      id: KANBAN_PROJECT_VIEW_IDS.PERSONAL,
      name: 'Personal',
      filters: {
        ...cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
        sortField: 'priority',
        sortDirection: 'asc',
      },
      showSubIssues: getDefaultShowSubIssuesForView(
        KANBAN_PROJECT_VIEW_IDS.PERSONAL
      ),
      showWorkspaces: DEFAULT_KANBAN_SHOW_WORKSPACES,
      hideBlocked: DEFAULT_KANBAN_HIDE_BLOCKED,
    };
  }

  return {
    id: KANBAN_PROJECT_VIEW_IDS.TEAM,
    name: 'Team',
    filters: cloneKanbanFilters(DEFAULT_KANBAN_FILTER_STATE),
    showSubIssues: getDefaultShowSubIssuesForView(KANBAN_PROJECT_VIEW_IDS.TEAM),
    showWorkspaces: DEFAULT_KANBAN_SHOW_WORKSPACES,
    hideBlocked: DEFAULT_KANBAN_HIDE_BLOCKED,
  };
};

const createDefaultKanbanProjectViewPreferences = (
  viewId: string
): KanbanProjectViewPreferences => {
  const view = getKanbanDefaultView(viewId);
  return {
    filters: cloneKanbanFilters(view.filters),
    showSubIssues: view.showSubIssues,
    showWorkspaces: view.showWorkspaces,
    hideBlocked: view.hideBlocked,
  };
};

export const resolveKanbanProjectState = (
  projectSelection: KanbanProjectViewSelection | undefined
): ResolvedKanbanProjectState => {
  const requestedViewId = projectSelection?.activeViewId;
  const activeViewId = isKanbanProjectViewId(requestedViewId ?? '')
    ? (requestedViewId ?? DEFAULT_KANBAN_PROJECT_VIEW_ID)
    : DEFAULT_KANBAN_PROJECT_VIEW_ID;
  const activeView = getKanbanDefaultView(activeViewId);

  return {
    activeViewId,
    filters: cloneKanbanFilters(activeView.filters),
    showSubIssues: activeView.showSubIssues,
    showWorkspaces: activeView.showWorkspaces,
    hideBlocked: activeView.hideBlocked,
  };
};

// Centralized persist keys for type safety
export const PERSIST_KEYS = {
  // Right panel sections
  gitAdvancedSettings: 'git-advanced-settings',
  gitPanelRepositories: 'git-panel-repositories',
  gitPanelProject: 'git-panel-project',
  gitPanelAddRepositories: 'git-panel-add-repositories',
  rightPanelprocesses: 'right-panel-processes',
  rightPanelPreview: 'right-panel-preview',
  // Process panel sections
  processesSection: 'processes-section',
  // Changes panel sections
  changesSection: 'changes-section',
  // Preview panel sections
  devServerSection: 'dev-server-section',
  // Terminal panel section
  terminalSection: 'terminal-section',
  // Notes panel section
  notesSection: 'notes-section',
  // Headed session pane section
  sessionSection: 'session-section',
  // GitHub comments toggle
  showGitHubComments: 'show-github-comments',
  // Panel sizes
  rightMainPanel: 'right-main-panel',
  kanbanLeftPanel: 'kanban-left-panel',
  // Kanban issue panel sections
  kanbanIssueSubIssues: 'kanban-issue-sub-issues',
  kanbanIssueRelationships: 'kanban-issue-relationships',
  kanbanIssueAttachments: 'kanban-issue-attachments',
  // Dynamic keys (use helper functions)
  repoCard: (repoId: string) => `repo-card-${repoId}` as const,
} as const;

// Check if screen is wide enough to keep sidebar visible
const isWideScreen = () => window.innerWidth > 2048;

export type PersistKey =
  | typeof PERSIST_KEYS.gitAdvancedSettings
  | typeof PERSIST_KEYS.gitPanelRepositories
  | typeof PERSIST_KEYS.gitPanelProject
  | typeof PERSIST_KEYS.gitPanelAddRepositories
  | typeof PERSIST_KEYS.processesSection
  | typeof PERSIST_KEYS.changesSection
  | typeof PERSIST_KEYS.devServerSection
  | typeof PERSIST_KEYS.terminalSection
  | typeof PERSIST_KEYS.notesSection
  | typeof PERSIST_KEYS.sessionSection
  | typeof PERSIST_KEYS.showGitHubComments
  | typeof PERSIST_KEYS.rightMainPanel
  | typeof PERSIST_KEYS.rightPanelprocesses
  | typeof PERSIST_KEYS.rightPanelPreview
  | typeof PERSIST_KEYS.kanbanLeftPanel
  | typeof PERSIST_KEYS.kanbanIssueSubIssues
  | typeof PERSIST_KEYS.kanbanIssueRelationships
  | typeof PERSIST_KEYS.kanbanIssueAttachments
  | `repo-card-${string}`
  | `diff:${string}`
  | `edit:${string}`
  | `plan:${string}`
  | `tool:${string}`
  | `todo:${string}`
  | `subagent:${string}`
  | `user:${string}`
  | `system:${string}`
  | `error:${string}`
  | `entry:${string}`
  | `list-section-${string}`;

type State = {
  // UI preferences
  repoActions: Record<string, RepoAction>;
  expanded: Record<string, boolean>;
  contextBarPosition: ContextBarPosition;
  paneSizes: Record<string, number | string>;
  collapsedPaths: Record<string, string[]>;
  fileSearchRepoId: string | null;

  // Global layout state (applies across all workspaces)
  layoutMode: LayoutMode;
  isLeftSidebarVisible: boolean;
  isRightSidebarVisible: boolean;
  isTerminalVisible: boolean;
  previewRefreshKey: number;
  // Note: Kanban issue panel state (selectedKanbanIssueId, createMode, etc.)
  // is derived from URL via app navigation route state

  // Workspace-specific panel state
  workspacePanelStates: Record<string, WorkspacePanelState>;

  // Selected built-in kanban view per project
  kanbanProjectViewSelections: Record<string, KanbanProjectViewSelection>;

  // In-memory kanban runtime preferences per project and view
  kanbanProjectViewPreferences: Record<
    string,
    Record<string, KanbanProjectViewPreferences>
  >;

  // Kanban view mode state
  kanbanViewMode: KanbanViewMode;
  listViewStatusFilter: string | null;

  // Mobile tab state
  mobileActiveTab: MobileTab;

  // Mobile font scale
  mobileFontScale: MobileFontScale;

  // Theme variant ("skin"), applied on top of the light/dark mode
  themeVariant: ThemeVariant;

  // Persisted default pipeline id for the Create Issue dialog (single-select).
  defaultPipelineId: string | null;

  // Animated border around the working message box (toggleable in settings)
  animateRunningOutline: boolean;

  // Last selected project (persisted via scratch store).
  // ADR-018 — `selectedOrgId` removed.
  selectedProjectId: string | null;
  createDraftWorkspaceByDefault: boolean;

  // Workspaces dashboard project filter (2026-08-07): when set, the
  // /workspaces dashboard narrows to this project's workspaces. In-memory
  // only (not persisted) — set by the sidebar Workspaces section icon and
  // cleared via the dashboard's "All workspaces" toggle.
  workspacesDashboardProjectId: string | null;
  setWorkspacesDashboardProjectId: (projectId: string | null) => void;

  // UI preferences actions
  setRepoAction: (repoId: string, action: RepoAction) => void;
  setExpanded: (key: string, value: boolean) => void;
  toggleExpanded: (key: string, defaultValue?: boolean) => void;
  setExpandedAll: (keys: string[], value: boolean) => void;
  setContextBarPosition: (position: ContextBarPosition) => void;
  setPaneSize: (key: string, size: number | string) => void;
  setCollapsedPaths: (key: string, paths: string[]) => void;
  setFileSearchRepo: (repoId: string | null) => void;

  // Layout actions
  setLayoutMode: (mode: LayoutMode) => void;
  toggleLayoutMode: () => void;
  toggleLeftSidebar: () => void;
  toggleLeftMainPanel: (workspaceId?: string) => void;
  toggleRightSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalVisible: (value: boolean) => void;
  // Note: Kanban panel actions (openKanbanIssuePanel, closeKanbanIssuePanel, etc.)
  // are handled by app navigation
  toggleRightMainPanelMode: (
    mode: RightMainPanelMode,
    workspaceId?: string
  ) => void;
  setRightMainPanelMode: (
    mode: RightMainPanelMode | null,
    workspaceId?: string
  ) => void;
  setLeftSidebarVisible: (value: boolean) => void;
  setLeftMainPanelVisible: (value: boolean, workspaceId?: string) => void;
  triggerPreviewRefresh: () => void;

  // Workspace-specific panel state actions
  getWorkspacePanelState: (workspaceId: string) => WorkspacePanelState;
  setWorkspacePanelState: (
    workspaceId: string,
    state: Partial<WorkspacePanelState>
  ) => void;

  // Kanban view selection actions
  setKanbanProjectView: (projectId: string, viewId: string) => void;
  setKanbanProjectViewFilters: (
    projectId: string,
    viewId: string,
    filters: KanbanFilterState
  ) => void;
  setKanbanProjectViewShowSubIssues: (
    projectId: string,
    viewId: string,
    show: boolean
  ) => void;
  setKanbanProjectViewShowWorkspaces: (
    projectId: string,
    viewId: string,
    show: boolean
  ) => void;
  setKanbanProjectViewHideBlocked: (
    projectId: string,
    viewId: string,
    hide: boolean
  ) => void;
  clearKanbanProjectViewPreferences: (
    projectId: string,
    viewId: string
  ) => void;

  // Kanban view mode actions
  setKanbanViewMode: (mode: KanbanViewMode) => void;
  setListViewStatusFilter: (statusId: string | null) => void;

  // Mobile tab actions
  setMobileActiveTab: (tab: MobileTab) => void;

  // Mobile font scale actions
  setMobileFontScale: (scale: MobileFontScale) => void;

  // Theme variant actions
  setThemeVariant: (variant: ThemeVariant) => void;

  // Default pipeline actions
  setDefaultPipelineId: (id: string | null) => void;

  // Animated running outline actions
  setAnimateRunningOutline: (value: boolean) => void;

  // Last selected project actions
  setSelectedProjectId: (projectId: string | null) => void;
  setCreateDraftWorkspaceByDefault: (value: boolean) => void;
};

export const useUiPreferencesStore = create<State>()((set, get) => ({
  // UI preferences state
  repoActions: {},
  expanded: {},
  contextBarPosition: 'middle-right',
  paneSizes: {},
  collapsedPaths: {},
  fileSearchRepoId: null,

  // Global layout state
  layoutMode: 'workspaces' as LayoutMode,
  isLeftSidebarVisible: true,
  isRightSidebarVisible: true,
  isTerminalVisible: true,
  previewRefreshKey: 0,

  // Workspace-specific panel state
  workspacePanelStates: {},

  // Kanban per-project view selection
  kanbanProjectViewSelections: {},
  kanbanProjectViewPreferences: {},

  // Kanban view mode state
  kanbanViewMode: 'kanban' as KanbanViewMode,
  listViewStatusFilter: null,

  // Mobile tab state
  mobileActiveTab: 'chat' as MobileTab,

  // Mobile font scale
  mobileFontScale: loadMobileFontScale(),

  // Theme variant
  themeVariant: loadThemeVariant(),

  // Persisted default pipeline id (single-select Create Issue dialog)
  defaultPipelineId: loadDefaultPipelineId(),

  // Animated running outline (default on)
  animateRunningOutline: loadAnimateRunningOutline(),

  // Last selected project (ADR-018 — `selectedOrgId` removed)
  selectedProjectId: null,
  createDraftWorkspaceByDefault: DEFAULT_CREATE_DRAFT_WORKSPACE_BY_DEFAULT,

  // Workspaces dashboard project filter (in-memory only).
  workspacesDashboardProjectId: null,

  // UI preferences actions
  setRepoAction: (repoId, action) =>
    set((s) => ({ repoActions: { ...s.repoActions, [repoId]: action } })),
  setExpanded: (key, value) =>
    set((s) => ({ expanded: { ...s.expanded, [key]: value } })),
  toggleExpanded: (key, defaultValue = true) =>
    set((s) => ({
      expanded: {
        ...s.expanded,
        [key]: !(s.expanded[key] ?? defaultValue),
      },
    })),
  setExpandedAll: (keys, value) =>
    set((s) => ({
      expanded: {
        ...s.expanded,
        ...Object.fromEntries(keys.map((k) => [k, value])),
      },
    })),
  setContextBarPosition: (position) => set({ contextBarPosition: position }),
  setPaneSize: (key, size) =>
    set((s) => ({ paneSizes: { ...s.paneSizes, [key]: size } })),
  setCollapsedPaths: (key, paths) =>
    set((s) => ({ collapsedPaths: { ...s.collapsedPaths, [key]: paths } })),
  setFileSearchRepo: (repoId) => set({ fileSearchRepoId: repoId }),

  // Layout actions
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  toggleLayoutMode: () =>
    set((s) => ({
      layoutMode: s.layoutMode === 'workspaces' ? 'kanban' : 'workspaces',
    })),
  toggleLeftSidebar: () =>
    set((s) => ({ isLeftSidebarVisible: !s.isLeftSidebarVisible })),

  toggleLeftMainPanel: (workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    if (wsState.isLeftMainPanelVisible && wsState.rightMainPanelMode === null)
      return;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          isLeftMainPanelVisible: !wsState.isLeftMainPanelVisible,
        },
      },
    });
  },

  toggleRightSidebar: () =>
    set((s) => ({ isRightSidebarVisible: !s.isRightSidebarVisible })),

  toggleTerminal: () =>
    set((s) => ({ isTerminalVisible: !s.isTerminalVisible })),

  setTerminalVisible: (value) => set({ isTerminalVisible: value }),

  toggleRightMainPanelMode: (mode, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    const isCurrentlyActive = wsState.rightMainPanelMode === mode;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          rightMainPanelMode: isCurrentlyActive ? null : mode,
        },
      },
      isLeftSidebarVisible: isCurrentlyActive
        ? true
        : isWideScreen()
          ? state.isLeftSidebarVisible
          : false,
      ...(isMobile &&
        !isCurrentlyActive && { mobileActiveTab: mode as MobileTab }),
    });
  },

  setRightMainPanelMode: (mode, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          rightMainPanelMode: mode,
        },
      },
      ...(mode !== null && {
        isLeftSidebarVisible: isWideScreen()
          ? state.isLeftSidebarVisible
          : false,
      }),
      ...(isMobile && mode !== null && { mobileActiveTab: mode as MobileTab }),
    });
  },

  setLeftSidebarVisible: (value) => set({ isLeftSidebarVisible: value }),

  setLeftMainPanelVisible: (value, workspaceId) => {
    if (!workspaceId) return;
    const state = get();
    const wsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...wsState,
          isLeftMainPanelVisible: value,
        },
      },
    });
  },

  triggerPreviewRefresh: () =>
    set((s) => ({ previewRefreshKey: s.previewRefreshKey + 1 })),

  // Workspace-specific panel state actions
  getWorkspacePanelState: (workspaceId) => {
    const state = get();
    return (
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE
    );
  },

  setWorkspacePanelState: (workspaceId, panelState) => {
    const state = get();
    const currentWsState =
      state.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE;
    set({
      workspacePanelStates: {
        ...state.workspacePanelStates,
        [workspaceId]: {
          ...currentWsState,
          ...panelState,
        },
      },
    });
  },

  // Kanban view selection actions
  setKanbanProjectView: (projectId, viewId) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => ({
      kanbanProjectViewSelections: {
        ...s.kanbanProjectViewSelections,
        [projectId]: { activeViewId: viewId },
      },
    }));
  },

  setKanbanProjectViewFilters: (projectId, viewId, filters) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              filters: cloneKanbanFilters(filters),
            },
          },
        },
      };
    });
  },

  setKanbanProjectViewShowSubIssues: (projectId, viewId, show) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              showSubIssues: show,
            },
          },
        },
      };
    });
  },

  setKanbanProjectViewShowWorkspaces: (projectId, viewId, show) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              showWorkspaces: show,
            },
          },
        },
      };
    });
  },

  setKanbanProjectViewHideBlocked: (projectId, viewId, hide) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences =
        s.kanbanProjectViewPreferences[projectId] ?? {};
      const existingPreferences =
        projectPreferences[viewId] ??
        createDefaultKanbanProjectViewPreferences(viewId);

      return {
        kanbanProjectViewPreferences: {
          ...s.kanbanProjectViewPreferences,
          [projectId]: {
            ...projectPreferences,
            [viewId]: {
              ...existingPreferences,
              hideBlocked: hide,
            },
          },
        },
      };
    });
  },

  clearKanbanProjectViewPreferences: (projectId, viewId) => {
    if (!isKanbanProjectViewId(viewId)) {
      return;
    }

    set((s) => {
      const projectPreferences = s.kanbanProjectViewPreferences[projectId];
      if (!projectPreferences || !projectPreferences[viewId]) {
        return {};
      }

      const nextProjectPreferences = { ...projectPreferences };
      delete nextProjectPreferences[viewId];

      const nextAllPreferences = { ...s.kanbanProjectViewPreferences };
      if (Object.keys(nextProjectPreferences).length === 0) {
        delete nextAllPreferences[projectId];
      } else {
        nextAllPreferences[projectId] = nextProjectPreferences;
      }

      return {
        kanbanProjectViewPreferences: nextAllPreferences,
      };
    });
  },

  // Kanban view mode actions
  setKanbanViewMode: (mode) => set({ kanbanViewMode: mode }),

  setListViewStatusFilter: (statusId) =>
    set({ listViewStatusFilter: statusId }),

  // Mobile tab actions
  setMobileActiveTab: (tab) => set({ mobileActiveTab: tab }),

  // Mobile font scale actions
  setMobileFontScale: (scale) => {
    try {
      if (scale === 'default') {
        localStorage.removeItem(MOBILE_FONT_SCALE_KEY);
      } else {
        localStorage.setItem(MOBILE_FONT_SCALE_KEY, scale);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ mobileFontScale: scale });
  },

  // Theme variant actions
  setThemeVariant: (variant) => {
    try {
      if (variant === DEFAULT_THEME_VARIANT) {
        localStorage.removeItem(THEME_VARIANT_KEY);
      } else {
        localStorage.setItem(THEME_VARIANT_KEY, variant);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ themeVariant: variant });
  },

  // Default pipeline actions
  setDefaultPipelineId: (id) => {
    try {
      if (id) {
        localStorage.setItem(DEFAULT_PIPELINE_KEY, id);
      } else {
        localStorage.removeItem(DEFAULT_PIPELINE_KEY);
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ defaultPipelineId: id });
  },

  // Animated running outline actions
  setAnimateRunningOutline: (value) => {
    try {
      if (value) {
        localStorage.removeItem(ANIMATE_RUNNING_OUTLINE_KEY);
      } else {
        localStorage.setItem(ANIMATE_RUNNING_OUTLINE_KEY, 'false');
      }
    } catch {
      // localStorage may be unavailable
    }
    set({ animateRunningOutline: value });
  },

  // Last selected project actions
  setSelectedProjectId: (projectId) => set({ selectedProjectId: projectId }),
  setWorkspacesDashboardProjectId: (projectId) =>
    set({ workspacesDashboardProjectId: projectId }),
  setCreateDraftWorkspaceByDefault: (value) =>
    set({ createDraftWorkspaceByDefault: value }),
}));

// Hook for repo action preference
export function useRepoAction(
  repoId: string,
  defaultAction: RepoAction = 'pull-request'
): [RepoAction, (action: RepoAction) => void] {
  const action = useUiPreferencesStore(
    (s) => s.repoActions[repoId] ?? defaultAction
  );
  const setAction = useUiPreferencesStore((s) => s.setRepoAction);
  return [action, (a) => setAction(repoId, a)];
}

// Hook for persisted expanded state
export function usePersistedExpanded(
  key: PersistKey,
  defaultValue = true
): [boolean, (value?: boolean) => void] {
  const expanded = useUiPreferencesStore(
    (s) => s.expanded[key] ?? defaultValue
  );
  const setExpanded = useUiPreferencesStore((s) => s.setExpanded);
  const toggleExpanded = useUiPreferencesStore((s) => s.toggleExpanded);

  const set = (value?: boolean) => {
    if (typeof value === 'boolean') setExpanded(key, value);
    else toggleExpanded(key, defaultValue);
  };

  return [expanded, set];
}

// Hook for context bar position
export function useContextBarPosition(): [
  ContextBarPosition,
  (position: ContextBarPosition) => void,
] {
  const position = useUiPreferencesStore((s) => s.contextBarPosition);
  const setPosition = useUiPreferencesStore((s) => s.setContextBarPosition);
  return [position, setPosition];
}

// Hook for pane size preference
export function usePaneSize(
  key: PersistKey,
  defaultSize: number | string
): [number | string, (size: number | string) => void] {
  const size = useUiPreferencesStore((s) => s.paneSizes[key] ?? defaultSize);
  const setSize = useUiPreferencesStore((s) => s.setPaneSize);
  return [size, (s) => setSize(key, s)];
}

// Hook for bulk expanded state operations
export function useExpandedAll() {
  const expanded = useUiPreferencesStore((s) => s.expanded);
  const setExpanded = useUiPreferencesStore((s) => s.setExpanded);
  const setExpandedAll = useUiPreferencesStore((s) => s.setExpandedAll);
  return { expanded, setExpanded, setExpandedAll };
}

// Hook for persisted file tree collapsed paths (per workspace)
export function usePersistedCollapsedPaths(
  workspaceId: string | undefined
): [
  Set<string>,
  (paths: Set<string> | ((prev: Set<string>) => Set<string>)) => void,
] {
  const key = workspaceId ? `file-tree:${workspaceId}` : '';
  const paths = useUiPreferencesStore((s) => s.collapsedPaths[key] ?? []);
  const setPaths = useUiPreferencesStore((s) => s.setCollapsedPaths);

  const pathSet = useMemo(() => new Set(paths), [paths]);
  const pathSetRef = useRef(pathSet);
  pathSetRef.current = pathSet;

  const setPathSet = useCallback(
    (newPaths: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (!key) return;
      const resolved =
        typeof newPaths === 'function'
          ? newPaths(pathSetRef.current)
          : newPaths;
      setPaths(key, [...resolved]);
    },
    [key, setPaths]
  );

  return [pathSet, setPathSet];
}

// Hook for mobile active tab
export function useMobileActiveTab() {
  const tab = useUiPreferencesStore((s) => s.mobileActiveTab);
  const set = useUiPreferencesStore((s) => s.setMobileActiveTab);
  return [tab, set] as const;
}

// Hook for mobile font scale
export function useMobileFontScale() {
  const scale = useUiPreferencesStore((s) => s.mobileFontScale);
  const set = useUiPreferencesStore((s) => s.setMobileFontScale);
  return [scale, set] as const;
}

// Hook for theme variant ("skin")
export function useThemeVariant() {
  const variant = useUiPreferencesStore((s) => s.themeVariant);
  const set = useUiPreferencesStore((s) => s.setThemeVariant);
  return [variant, set] as const;
}

// Hook for the persisted default pipeline id (single-select Create Issue dialog)
export function useDefaultPipelineId() {
  const id = useUiPreferencesStore((s) => s.defaultPipelineId);
  const set = useUiPreferencesStore((s) => s.setDefaultPipelineId);
  return [id, set] as const;
}

// Hook for the animated running outline toggle
export function useAnimateRunningOutline() {
  const value = useUiPreferencesStore((s) => s.animateRunningOutline);
  const set = useUiPreferencesStore((s) => s.setAnimateRunningOutline);
  return [value, set] as const;
}

// Hook for workspace-specific panel state
export function useWorkspacePanelState(workspaceId: string | undefined) {
  // Subscribe only to this workspace's panel state slice (not the entire map)
  const wsState = useUiPreferencesStore((s) =>
    workspaceId
      ? (s.workspacePanelStates[workspaceId] ?? DEFAULT_WORKSPACE_PANEL_STATE)
      : DEFAULT_WORKSPACE_PANEL_STATE
  );

  // Global state (sidebars are global)
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  const isRightSidebarVisible = useUiPreferencesStore(
    (s) => s.isRightSidebarVisible
  );
  const isTerminalVisible = useUiPreferencesStore((s) => s.isTerminalVisible);

  // Actions from store
  const toggleRightMainPanelMode = useUiPreferencesStore(
    (s) => s.toggleRightMainPanelMode
  );
  const setRightMainPanelMode = useUiPreferencesStore(
    (s) => s.setRightMainPanelMode
  );
  const setLeftMainPanelVisible = useUiPreferencesStore(
    (s) => s.setLeftMainPanelVisible
  );
  const setLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.setLeftSidebarVisible
  );

  // Memoized callbacks that include workspaceId
  const toggleRightMainPanelModeForWorkspace = useCallback(
    (mode: RightMainPanelMode) => toggleRightMainPanelMode(mode, workspaceId),
    [toggleRightMainPanelMode, workspaceId]
  );

  const setRightMainPanelModeForWorkspace = useCallback(
    (mode: RightMainPanelMode | null) =>
      setRightMainPanelMode(mode, workspaceId),
    [setRightMainPanelMode, workspaceId]
  );

  const setLeftMainPanelVisibleForWorkspace = useCallback(
    (value: boolean) => setLeftMainPanelVisible(value, workspaceId),
    [setLeftMainPanelVisible, workspaceId]
  );

  return {
    // Workspace-specific state
    rightMainPanelMode: wsState.rightMainPanelMode,
    isLeftMainPanelVisible: wsState.isLeftMainPanelVisible,

    // Global state (sidebars and terminal)
    isLeftSidebarVisible,
    isRightSidebarVisible,
    isTerminalVisible,

    // Workspace-specific actions
    toggleRightMainPanelMode: toggleRightMainPanelModeForWorkspace,
    setRightMainPanelMode: setRightMainPanelModeForWorkspace,
    setLeftMainPanelVisible: setLeftMainPanelVisibleForWorkspace,

    // Global actions
    setLeftSidebarVisible,
  };
}
