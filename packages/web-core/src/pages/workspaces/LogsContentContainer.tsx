import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import {
  ButtonGroup,
  ButtonGroupItem,
} from '@vibe/ui/components/IconButtonGroup';
import {
  type LogEntry,
  VirtualizedProcessLogs,
} from '@/shared/components/VirtualizedProcessLogs';
import { useLogStream } from '@/shared/hooks/useLogStream';
import { useLogsPanel } from '@/shared/hooks/useLogsPanel';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { TerminalPanelContainer } from '@/shared/components/TerminalPanelContainer';
import {
  InteractiveControlBar,
  getInteractiveConfig,
} from './InteractiveControlBar';
import { HeadedApprovalsPanel } from './HeadedApprovalsPanel';
import { HeadedTerminalView } from './HeadedTerminalView';
import { ArrowsInSimpleIcon } from '@phosphor-icons/react';

export type LogsPanelContent =
  | { type: 'process'; processId: string }
  | {
      type: 'tool';
      toolName: string;
      content: string;
      command: string | undefined;
    }
  | { type: 'terminal' };

interface LogsContentContainerProps {
  className: string;
}

export function LogsContentContainer({ className }: LogsContentContainerProps) {
  const {
    logsPanelContent: content,
    logSearchQuery: searchQuery,
    logCurrentMatchIdx: currentMatchIndex,
    setLogMatchIndices: onMatchIndicesChange,
    collapseTerminal,
  } = useLogsPanel();
  const { t } = useTranslation('common');
  const { executionProcessesByIdVisible, executionProcessesByIdAll } =
    useExecutionProcessesContext();
  // Get logs for process content (only when type is 'process')
  const processId = content?.type === 'process' ? content.processId : '';
  const { logs, error } = useLogStream(processId);

  // Resolve the selected process so we can offer interactive (headed) controls.
  const selectedProcess = processId
    ? (executionProcessesByIdVisible[processId] ??
      executionProcessesByIdAll[processId])
    : undefined;
  const interactiveConfig = selectedProcess
    ? getInteractiveConfig(selectedProcess)
    : null;

  // A "live headed session" for the SELECTED process: a running coding-agent
  // execution with an interactive tmux config. This is stricter than the
  // `interactiveConfig` check that gates `InteractiveControlBar` (which also
  // shows for finished headed processes with its buttons disabled): the Terminal
  // view can only attach when the backend will accept it, i.e. the process is
  // actually running. Keyed off the selected process, NOT `useHeadedSession`
  // (which resolves the latest-running headed process for the workspace).
  const isLiveHeaded =
    !!selectedProcess &&
    selectedProcess.run_reason === 'codingagent' &&
    selectedProcess.status === 'running' &&
    interactiveConfig !== null;

  // The Log/Terminal choice, tied to the process it belongs to. The effective
  // view is derived at render time so it falls back to Log SYNCHRONOUSLY both
  // when the selected process changes (stored id no longer matches) and when the
  // process stops being a live headed session (`isLiveHeaded` goes false as its
  // status leaves `running`) — no effect lag, no transient terminal mount for a
  // freshly-selected process.
  const [viewState, setViewState] = useState<{
    processId: string | null;
    view: 'log' | 'terminal';
  }>({ processId: null, view: 'log' });
  const processView: 'log' | 'terminal' =
    isLiveHeaded && viewState.processId === processId ? viewState.view : 'log';

  // "Session ended" notice: show it only when the SAME process we were watching
  // in Terminal transitions from live-headed to not-live — never on ordinary
  // navigation to a different (non-live) process.
  const [sessionEndedNotice, setSessionEndedNotice] = useState(false);
  const prevProcessIdRef = useRef<string | null>(null);
  const wasLiveTerminalRef = useRef(false);
  useEffect(() => {
    const sameProcess = prevProcessIdRef.current === processId;
    if (!sameProcess) {
      setSessionEndedNotice(false);
    } else if (wasLiveTerminalRef.current && !isLiveHeaded) {
      setSessionEndedNotice(true);
    }
    prevProcessIdRef.current = processId;
    wasLiveTerminalRef.current = isLiveHeaded && processView === 'terminal';
  }, [processId, isLiveHeaded, processView]);

  // Get the current logs based on content type
  const currentLogs = useMemo(() => {
    if (content?.type === 'tool') {
      return content.content
        .split('\n')
        .map((line) => ({ type: 'STDOUT' as const, content: line }));
    }
    return logs;
  }, [content, logs]);

  // Compute which log indices match the search query (reversed for bottom-to-top)
  const matchIndices = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const matches = currentLogs
      .map((log, idx) => (log.content.toLowerCase().includes(query) ? idx : -1))
      .filter((idx) => idx !== -1);
    // Reverse so newest matches (bottom) come first
    return matches.reverse();
  }, [currentLogs, searchQuery]);

  // Report match indices to parent
  useEffect(() => {
    onMatchIndicesChange?.(matchIndices);
  }, [matchIndices, onMatchIndicesChange]);

  // Empty state
  if (!content) {
    return (
      <div className="w-full h-full bg-secondary flex items-center justify-center text-low">
        <p className="text-sm">{t('logs.selectProcessToView')}</p>
      </div>
    );
  }

  // Tool content - render static content using VirtualizedProcessLogs
  if (content.type === 'tool') {
    const toolLogs: LogEntry[] = content.content
      .split('\n')
      .map((line) => ({ type: 'STDOUT' as const, content: line }));

    return (
      <div className={cn('h-full bg-secondary flex flex-col', className)}>
        <div className="px-4 py-2 border-b border-border text-sm font-medium text-normal shrink-0">
          {content.toolName}
        </div>
        {content.command && (
          <div className="px-4 py-2 font-mono text-xs text-low border-b border-border bg-tertiary shrink-0">
            $ {content.command}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <VirtualizedProcessLogs
            logs={toolLogs}
            error={null}
            searchQuery={searchQuery}
            matchIndices={matchIndices}
            currentMatchIndex={currentMatchIndex}
          />
        </div>
      </div>
    );
  }

  // Terminal content - render terminal with collapse button
  if (content.type === 'terminal') {
    return (
      <div className={cn('h-full bg-secondary flex flex-col', className)}>
        <div className="px-4 py-1 flex items-center justify-between shrink-0 h-8">
          <span className="text-sm font-medium text-normal">
            {t('processes.terminal')}
          </span>
          <button
            type="button"
            onClick={collapseTerminal}
            className="text-low hover:text-normal transition-colors"
            title={t('actions.collapse')}
          >
            <ArrowsInSimpleIcon className="size-icon-sm" weight="bold" />
          </button>
        </div>
        <div className="flex-1 flex min-h-0 border-t border-border">
          <div className="flex-1 min-h-0 w-full">
            <TerminalPanelContainer />
          </div>
        </div>
      </div>
    );
  }

  // Process logs - render with VirtualizedProcessLogs, plus an interactive
  // control bar for headed (detached tmux) executions.
  return (
    <div className={cn('h-full bg-secondary flex flex-col', className)}>
      {isLiveHeaded && (
        <div className="px-base py-half flex items-center gap-base border-b border-border bg-tertiary shrink-0">
          <ButtonGroup>
            <ButtonGroupItem
              active={processView === 'log'}
              onClick={() => setViewState({ processId, view: 'log' })}
            >
              {t('processes.viewLog')}
            </ButtonGroupItem>
            <ButtonGroupItem
              active={processView === 'terminal'}
              onClick={() => setViewState({ processId, view: 'terminal' })}
            >
              {t('processes.viewTerminal')}
            </ButtonGroupItem>
          </ButtonGroup>
        </div>
      )}
      {sessionEndedNotice && (
        <div className="px-base py-half text-xs text-low border-b border-border bg-tertiary shrink-0">
          {t('processes.sessionEnded')}
        </div>
      )}
      {selectedProcess && interactiveConfig && (
        <>
          <InteractiveControlBar
            process={selectedProcess}
            config={interactiveConfig}
          />
          <HeadedApprovalsPanel executionProcessId={selectedProcess.id} />
        </>
      )}
      {processView === 'terminal' ? (
        <HeadedTerminalView processId={processId} />
      ) : (
        <div className="flex-1 min-h-0">
          <VirtualizedProcessLogs
            key={processId}
            logs={logs}
            error={error}
            searchQuery={searchQuery}
            matchIndices={matchIndices}
            currentMatchIndex={currentMatchIndex}
          />
        </div>
      )}
    </div>
  );
}
