import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Workspace, Session, RepoWithTargetBranch } from 'shared/types';
import { createWorkspaceWithSession } from '@/shared/types/attempt';
import { WorkspacesMain } from '@vibe/ui/components/WorkspacesMain';
import {
  ButtonGroup,
  ButtonGroupItem,
} from '@vibe/ui/components/IconButtonGroup';
import { useHeadedSession } from '@/shared/hooks/useHeadedSession';
import { HeadedTerminalView } from './HeadedTerminalView';
import {
  ConversationList,
  type ConversationListHandle,
} from '@/features/workspace-chat/ui/ConversationListContainer';
import { SessionChatBoxContainer } from '@/features/workspace-chat/ui/SessionChatBoxContainer';
import { ContextBarContainer } from './ContextBarContainer';
import { EntriesProvider } from '@/features/workspace-chat/model/contexts/EntriesContext';
import { MessageEditProvider } from '@/features/workspace-chat/model/contexts/MessageEditContext';
import { RetryUiProvider } from '@/features/workspace-chat/model/contexts/RetryUiContext';
import { ApprovalFeedbackProvider } from '@/features/workspace-chat/model/contexts/ApprovalFeedbackContext';
import { forwardWheelToScroller } from '@/features/workspace-chat/ui/forwardWheelToScroller';
import { useDiffStats } from '@/shared/stores/useWorkspaceDiffStore';

/**
 * Isolated component that reads diffStats from WorkspaceContext.
 * By pushing the context subscription down to this leaf, the parent
 * WorkspacesMainContainer (and its ConversationList child) no longer
 * rerenders when diffs/comments/repos stream in.
 */
function ChatBoxWithDiffStats({
  session,
  workspaceId,
  isNewSessionMode,
  sessions,
  onSelectSession,
  onStartNewSession,
  onScrollToPreviousMessage,
  onScrollToBottom,
  onScrollToUserMessage,
  getActiveTurnPatchKey,
}: {
  session: Session | undefined;
  workspaceId: string | undefined;
  isNewSessionMode: boolean;
  sessions: Session[];
  onSelectSession: (sessionId: string) => void;
  onStartNewSession: () => void;
  onScrollToPreviousMessage: () => void;
  onScrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  onScrollToUserMessage: (patchKey: string) => void;
  getActiveTurnPatchKey: () => string | null;
}) {
  const diffStats = useDiffStats();

  return (
    <SessionChatBoxContainer
      {...(isNewSessionMode && workspaceId
        ? {
            mode: 'new-session' as const,
            workspaceId,
            onSelectSession,
          }
        : session
          ? {
              mode: 'existing-session' as const,
              session,
              onSelectSession,
              onStartNewSession,
            }
          : {
              mode: 'placeholder' as const,
            })}
      sessions={sessions}
      filesChanged={diffStats.files_changed}
      linesAdded={diffStats.lines_added}
      linesRemoved={diffStats.lines_removed}
      disableViewCode={false}
      showOpenWorkspaceButton={false}
      onScrollToPreviousMessage={onScrollToPreviousMessage}
      onScrollToBottom={onScrollToBottom}
      onScrollToUserMessage={onScrollToUserMessage}
      getActiveTurnPatchKey={getActiveTurnPatchKey}
    />
  );
}

export interface WorkspacesMainContainerHandle {
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
}

interface WorkspacesMainContainerProps {
  selectedWorkspace: Workspace | null;
  selectedSession: Session | undefined;
  selectedSessionId: string | undefined;
  sessions: Session[];
  repos: RepoWithTargetBranch[];
  onSelectSession: (sessionId: string) => void;
  isLoading: boolean;
  isSessionsLoading?: boolean;
  isNewSessionMode: boolean;
  onStartNewSession: () => void;
}

export const WorkspacesMainContainer = forwardRef<
  WorkspacesMainContainerHandle,
  WorkspacesMainContainerProps
>(function WorkspacesMainContainer(
  {
    selectedWorkspace,
    selectedSession,
    selectedSessionId,
    sessions,
    repos,
    onSelectSession,
    isLoading,
    isSessionsLoading: _isSessionsLoading,
    isNewSessionMode,
    onStartNewSession,
  },
  ref
) {
  const { t } = useTranslation('common');
  const containerRef = useRef<HTMLElement>(null);
  const conversationListRef = useRef<ConversationListHandle>(null);

  // Live headed (interactive tmux) session for the selected session, if any.
  // When present, the center pane offers a Log/Terminal switch so the operator
  // can flip the rendered conversation to a live terminal attached to the
  // agent's `vk-<processId>` tmux — right where they input data.
  const headed = useHeadedSession();
  const headedProcessId = headed?.processId ?? null;
  // View choice tied to the headed process it belongs to. Derived at render
  // time so it falls back to Log synchronously when the headed session changes
  // or ends (headedProcessId becomes null).
  const [viewState, setViewState] = useState<{
    processId: string | null;
    view: 'log' | 'terminal';
  }>({ processId: null, view: 'log' });
  const showTerminal =
    !!headedProcessId &&
    viewState.processId === headedProcessId &&
    viewState.view === 'terminal';

  const workspaceWithSession = useMemo(() => {
    if (!selectedWorkspace) return undefined;
    return createWorkspaceWithSession(selectedWorkspace, selectedSession);
  }, [selectedWorkspace, selectedSession]);

  const handleScrollToPreviousMessage = useCallback(() => {
    conversationListRef.current?.scrollToPreviousUserMessage();
  }, []);

  const handleScrollToUserMessage = useCallback((patchKey: string) => {
    conversationListRef.current?.scrollToEntryByPatchKey(patchKey);
  }, []);

  const handleGetActiveTurnPatchKey = useCallback(() => {
    return conversationListRef.current?.getVisibleUserMessagePatchKey() ?? null;
  }, []);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(isAtBottom);
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  const handleScrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'smooth') => {
      conversationListRef.current?.scrollToBottom(behavior);
    },
    []
  );

  const { session } = workspaceWithSession ?? {};

  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const chatBoxContainer = container.querySelector<HTMLElement>(
      '[data-chatbox-container="true"]'
    );
    if (!chatBoxContainer) return;

    let previousHeight = chatBoxContainer.getBoundingClientRect().height;

    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ??
        chatBoxContainer.getBoundingClientRect().height;

      if (Math.abs(nextHeight - previousHeight) < 0.5) return;
      const heightDelta = nextHeight - previousHeight;
      previousHeight = nextHeight;

      if (!isAtBottomRef.current) return;

      requestAnimationFrame(() => {
        if (!isAtBottomRef.current) return;
        conversationListRef.current?.adjustScrollBy(heightDelta);
      });
    });

    observer.observe(chatBoxContainer);

    return () => {
      observer.disconnect();
    };
  }, [workspaceWithSession?.id, session?.id]);

  const entriesProviderKey = workspaceWithSession
    ? `${workspaceWithSession.id}-${selectedSessionId ?? 'new'}`
    : 'empty';

  const conversationContent = workspaceWithSession ? (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      {headedProcessId && (
        <div className="flex justify-center shrink-0 pt-2 pb-1 @container pl-px">
          <div className="w-chat max-w-full flex items-center">
            <ButtonGroup>
              <ButtonGroupItem
                active={!showTerminal}
                onClick={() =>
                  setViewState({ processId: headedProcessId, view: 'log' })
                }
              >
                {t('processes.viewLog')}
              </ButtonGroupItem>
              <ButtonGroupItem
                active={showTerminal}
                onClick={() =>
                  setViewState({ processId: headedProcessId, view: 'terminal' })
                }
              >
                {t('processes.viewTerminal')}
              </ButtonGroupItem>
            </ButtonGroup>
          </div>
        </div>
      )}
      {showTerminal && headedProcessId ? (
        <div className="flex-1 min-h-0 flex justify-center @container pl-px">
          <div className="w-chat max-w-full h-full flex flex-col min-h-0">
            <HeadedTerminalView processId={headedProcessId} />
          </div>
        </div>
      ) : (
        <div
          className="flex-1 min-h-0 overflow-hidden flex justify-center"
          onWheel={(e) => forwardWheelToScroller(e, conversationListRef)}
        >
          <div className="w-chat max-w-full h-full">
            <RetryUiProvider workspaceId={workspaceWithSession.id}>
              <ConversationList
                key={entriesProviderKey}
                ref={conversationListRef}
                attempt={workspaceWithSession}
                repos={repos}
                onAtBottomChange={handleAtBottomChange}
                sessionScopeId={selectedSessionId}
              />
            </RetryUiProvider>
          </div>
        </div>
      )}
    </div>
  ) : null;

  const chatBoxContent = (
    <ChatBoxWithDiffStats
      session={session}
      workspaceId={workspaceWithSession?.id}
      isNewSessionMode={isNewSessionMode}
      sessions={sessions}
      onSelectSession={onSelectSession}
      onStartNewSession={onStartNewSession}
      onScrollToPreviousMessage={handleScrollToPreviousMessage}
      onScrollToBottom={handleScrollToBottom}
      onScrollToUserMessage={handleScrollToUserMessage}
      getActiveTurnPatchKey={handleGetActiveTurnPatchKey}
    />
  );

  const contextBarContent = workspaceWithSession ? (
    <ContextBarContainer containerRef={containerRef} />
  ) : null;

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (behavior = 'smooth') => {
        conversationListRef.current?.scrollToBottom(behavior);
      },
    }),
    []
  );

  return (
    <ApprovalFeedbackProvider>
      <EntriesProvider key={entriesProviderKey}>
        <MessageEditProvider>
          <WorkspacesMain
            workspaceWithSession={
              workspaceWithSession ? { id: workspaceWithSession.id } : undefined
            }
            isLoading={isLoading}
            containerRef={containerRef}
            conversationContent={conversationContent}
            chatBoxContent={chatBoxContent}
            contextBarContent={contextBarContent}
            isAtBottom={isAtBottom}
            onAtBottomChange={handleAtBottomChange}
            onScrollToBottom={handleScrollToBottom}
          />
        </MessageEditProvider>
      </EntriesProvider>
    </ApprovalFeedbackProvider>
  );
});
