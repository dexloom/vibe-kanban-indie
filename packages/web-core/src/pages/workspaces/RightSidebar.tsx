import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileTreeContainer } from './FileTreeContainer';
import { ProcessListContainer } from './ProcessListContainer';
import { PreviewControlsContainer } from './PreviewControlsContainer';
import { GitPanelContainer } from './GitPanelContainer';
import { TerminalPanelContainer } from '@/shared/components/TerminalPanelContainer';
import { WorkspaceNotesContainer } from './WorkspaceNotesContainer';
import { HeadedSessionIds } from '@/pages/kanban/HeadedSessionIds';
import { useDiffs } from '@/shared/stores/useWorkspaceDiffStore';
import {
  ArrowsOutSimpleIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useLogsPanel } from '@/shared/hooks/useLogsPanel';
import { useHeadedSession } from '@/shared/hooks/useHeadedSession';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { workspacesApi } from '@/shared/lib/api';
import type { RepoWithTargetBranch, Workspace } from 'shared/types';
import {
  PERSIST_KEYS,
  PersistKey,
  RIGHT_MAIN_PANEL_MODES,
  type RightMainPanelMode,
  usePersistedExpanded,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import {
  CollapsibleSectionHeader,
  type SectionAction,
} from '@vibe/ui/components/CollapsibleSectionHeader';

type SectionDef = {
  title: string;
  persistKey: PersistKey;
  visible: boolean;
  expanded: boolean;
  content: React.ReactNode;
  actions: SectionAction[];
};

export interface RightSidebarProps {
  rightMainPanelMode: RightMainPanelMode | null;
  selectedWorkspace: Workspace | undefined;
  repos: RepoWithTargetBranch[];
}

export const RightSidebar = memo(function RightSidebar({
  rightMainPanelMode,
  selectedWorkspace,
  repos,
}: RightSidebarProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const diffs = useDiffs();
  const isTerminalVisible = useUiPreferencesStore((s) => s.isTerminalVisible);
  const { expandTerminal, isTerminalExpanded } = useLogsPanel();
  const headedSession = useHeadedSession();
  const { openOrFocusTab } = useTerminal();

  const openExternalTerminal = useCallback(() => {
    if (!selectedWorkspace) return;
    workspacesApi.openTerminal(selectedWorkspace.id).catch((err) => {
      console.error('Failed to open workspace terminal', err);
    });
  }, [selectedWorkspace]);

  // Open an in-app terminal attached to the running agent's tmux session. Reveal
  // it with `expandTerminal()` — the same path the neighbouring expand icon uses
  // — so it shows regardless of the in-sidebar Terminal section's collapse state.
  const openAttachTerminal = useCallback(() => {
    if (!headedSession?.live || !selectedWorkspace?.container_ref) return;
    // Idempotent: focuses the existing attach tab if this session is already
    // attached, otherwise opens one. Never stacks duplicate sessions.
    openOrFocusTab(
      selectedWorkspace.id,
      selectedWorkspace.container_ref,
      headedSession.processId
    );
    expandTerminal();
  }, [headedSession, selectedWorkspace, openOrFocusTab, expandTerminal]);

  const [changesExpanded] = usePersistedExpanded(
    PERSIST_KEYS.changesSection,
    true
  );
  const [processesExpanded] = usePersistedExpanded(
    PERSIST_KEYS.processesSection,
    true
  );
  const [devServerExpanded] = usePersistedExpanded(
    PERSIST_KEYS.devServerSection,
    true
  );
  const [gitExpanded] = usePersistedExpanded(
    PERSIST_KEYS.gitPanelRepositories,
    true
  );
  const [terminalExpanded] = usePersistedExpanded(
    PERSIST_KEYS.terminalSection,
    false
  );
  const [notesExpanded] = usePersistedExpanded(
    PERSIST_KEYS.notesSection,
    false
  );

  const hasUpperContent =
    rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES ||
    rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS ||
    rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW;

  const upperExpanded = (() => {
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES)
      return changesExpanded;
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.LOGS)
      return processesExpanded;
    if (rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.PREVIEW)
      return devServerExpanded;
    return false;
  })();

  const sections: SectionDef[] = useMemo(() => {
    const result: SectionDef[] = [
      {
        title: 'Git',
        persistKey: PERSIST_KEYS.gitPanelRepositories,
        visible: true,
        expanded: gitExpanded,
        content: (
          <GitPanelContainer
            selectedWorkspace={selectedWorkspace}
            repos={repos}
          />
        ),
        actions: [],
      },
      {
        title: 'Terminal',
        persistKey: PERSIST_KEYS.terminalSection,
        visible: isTerminalVisible && !isTerminalExpanded,
        expanded: terminalExpanded,
        content: <TerminalPanelContainer />,
        actions: [
          {
            icon: TerminalWindowIcon,
            onClick: openExternalTerminal,
            title: 'Open workspace in terminal',
          },
          // Only when a headed (interactive tmux) agent is live for this
          // workspace: attach the in-app terminal to its tmux session.
          ...(headedSession?.live && selectedWorkspace?.container_ref
            ? [
                {
                  icon: PlugsConnectedIcon,
                  onClick: openAttachTerminal,
                  title: 'Attach to running agent (tmux)',
                },
              ]
            : []),
          { icon: ArrowsOutSimpleIcon, onClick: expandTerminal },
        ],
      },
      {
        title: t('common:sections.notes'),
        persistKey: PERSIST_KEYS.notesSection,
        visible: true,
        expanded: notesExpanded,
        content: <WorkspaceNotesContainer />,
        actions: [],
      },
    ];

    switch (rightMainPanelMode) {
      case RIGHT_MAIN_PANEL_MODES.CHANGES:
        if (selectedWorkspace) {
          result.unshift({
            title: 'Changes',
            persistKey: PERSIST_KEYS.changesSection,
            visible: hasUpperContent,
            expanded: upperExpanded,
            content: (
              <FileTreeContainer
                key={selectedWorkspace.id}
                workspaceId={selectedWorkspace.id}
                diffs={diffs}
                className=""
              />
            ),
            actions: [],
          });
        }
        break;
      case RIGHT_MAIN_PANEL_MODES.LOGS:
        result.unshift({
          title: 'Logs',
          persistKey: PERSIST_KEYS.rightPanelprocesses,
          visible: hasUpperContent,
          expanded: upperExpanded,
          content: <ProcessListContainer />,
          actions: [],
        });
        break;
      case RIGHT_MAIN_PANEL_MODES.PREVIEW:
        if (selectedWorkspace) {
          result.unshift({
            title: 'Preview',
            persistKey: PERSIST_KEYS.rightPanelPreview,
            visible: hasUpperContent,
            expanded: upperExpanded,
            content: (
              <PreviewControlsContainer
                workspaceId={selectedWorkspace.id}
                className=""
              />
            ),
            actions: [],
          });
        }
        break;
      case null:
        break;
    }

    return result;
  }, [
    rightMainPanelMode,
    selectedWorkspace,
    repos,
    diffs,
    gitExpanded,
    terminalExpanded,
    notesExpanded,
    changesExpanded,
    processesExpanded,
    devServerExpanded,
    isTerminalVisible,
    isTerminalExpanded,
    hasUpperContent,
    upperExpanded,
    expandTerminal,
    openExternalTerminal,
    openAttachTerminal,
    headedSession,
    t,
  ]);

  return (
    <div className="h-full border-l bg-secondary overflow-y-auto">
      {/* Headed (interactive tmux) session pane; renders null for non-headed sessions */}
      <HeadedSessionIds workspace={selectedWorkspace} />
      <div className="divide-y border-b">
        {sections
          .filter((section) => section.visible)
          .map((section) => (
            <div
              key={section.persistKey}
              className="max-h-[max(50vh,400px)] flex flex-col overflow-hidden"
            >
              <CollapsibleSectionHeader
                title={section.title}
                persistKey={section.persistKey}
                defaultExpanded={section.expanded}
                actions={section.actions}
              >
                <div className="flex flex-1 border-t min-h-[200px] w-full overflow-auto">
                  {section.content}
                </div>
              </CollapsibleSectionHeader>
            </div>
          ))}
      </div>
    </div>
  );
});
