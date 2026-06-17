import { useCallback, useMemo, useState } from 'react';
import {
  ArrowsClockwiseIcon,
  CheckIcon,
  CopyIcon,
  FolderIcon,
  SpinnerIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { getInteractiveConfig } from '@/shared/lib/interactive';
import { executionProcessesApi } from '@/shared/lib/api';
import { writeClipboardViaBridge } from '@/shared/lib/clipboard';
import { cn } from '@/shared/lib/utils';

/** A copy-on-click target showing `text`, copying `copyValue` to the clipboard. */
function CopyTarget({
  children,
  copyValue,
  title,
  className,
}: {
  children: React.ReactNode;
  copyValue: string;
  title: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await writeClipboardViaBridge(copyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [copyValue]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      className={cn(
        'group inline-flex items-center gap-1 min-w-0 rounded-sm px-1 py-0.5 text-low hover:text-normal hover:bg-panel transition-colors',
        className
      )}
    >
      {children}
      {copied ? (
        <CheckIcon className="size-icon-sm shrink-0" weight="bold" />
      ) : (
        <CopyIcon
          className="size-icon-sm shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          weight="regular"
        />
      )}
    </button>
  );
}

type RowStatus = 'idle' | 'busy' | 'success' | 'error';

/**
 * A Session-pane action row: an icon + label + optional monospace value whose
 * primary click runs an async backend action, with a transient in-flight /
 * success / error indicator. An optional `secondary` slot (e.g. a copy button)
 * sits at the end of the row.
 */
function SessionActionRow({
  icon,
  label,
  value,
  title,
  onAction,
  secondary,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  title: string;
  onAction: () => Promise<void>;
  secondary?: React.ReactNode;
}) {
  const [status, setStatus] = useState<RowStatus>('idle');
  const run = useCallback(async () => {
    setStatus((prev) => {
      if (prev === 'busy') return prev;
      return 'busy';
    });
    try {
      await onAction();
      setStatus('success');
      setTimeout(() => setStatus('idle'), 1500);
    } catch (err) {
      console.error(`Session pane: ${label} action failed`, err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2500);
    }
  }, [onAction, label]);

  return (
    <div className="flex items-center min-w-0">
      <button
        type="button"
        onClick={run}
        disabled={status === 'busy'}
        title={title}
        className="group flex flex-1 items-center gap-1.5 min-w-0 rounded-sm px-1 py-0.5 text-low hover:text-normal hover:bg-panel transition-colors disabled:opacity-60"
      >
        <span className="shrink-0 text-low/70">{icon}</span>
        <span className="text-low/70 shrink-0">{label}</span>
        {value && <span className="truncate">{value}</span>}
        <span className="ml-auto shrink-0 inline-flex size-icon-sm justify-center items-center">
          {status === 'busy' && (
            <SpinnerIcon className="size-icon-sm animate-spin" weight="bold" />
          )}
          {status === 'success' && (
            <CheckIcon className="size-icon-sm" weight="bold" />
          )}
          {status === 'error' && (
            <WarningCircleIcon className="size-icon-sm" weight="bold" />
          )}
        </span>
      </button>
      {secondary}
    </div>
  );
}

/**
 * The Session pane for a headed (interactive tmux) coding-agent execution.
 * Renders three action rows in the right sidebar:
 *  - **tmux** — open a new terminal tab attached to the live `vk-<id>` session.
 *  - **claude** — open a NEW tmux session running `claude --resume <uuid>`.
 *  - **workspace** — open a terminal in the workspace dir AND reveal it in the
 *    OS file manager (Finder / xdg-open).
 * Each row's id is also copy-on-click (where applicable). Renders nothing when
 * there is no live headed session.
 */
export function HeadedSessionIds() {
  const { executionProcessesAll } = useExecutionProcessesContext();

  const headed = useMemo(() => {
    // The list is sorted created_at ascending; the latest running headed
    // coding-agent process owns the live tmux session.
    const process = [...executionProcessesAll]
      .reverse()
      .find(
        (p) =>
          p.run_reason === 'codingagent' &&
          p.status === 'running' &&
          getInteractiveConfig(p) !== null
      );
    if (!process) return null;
    const config = getInteractiveConfig(process);
    if (!config) return null;
    return {
      processId: process.id,
      tmuxSession: `vk-${process.id}`,
      sessionUuid: config.session_uuid,
    };
  }, [executionProcessesAll]);

  if (!headed) return null;

  const { processId, tmuxSession, sessionUuid } = headed;

  return (
    <div className="flex flex-col gap-0.5 px-base py-half border-b shrink-0 font-mono text-xs min-w-0">
      <SessionActionRow
        icon={<TerminalWindowIcon className="size-icon-sm" weight="regular" />}
        label="tmux"
        value={tmuxSession}
        title={`Open a terminal tab attached to ${tmuxSession}`}
        onAction={() => executionProcessesApi.openTerminal(processId)}
        secondary={
          <CopyTarget
            copyValue={`tmux attach -t ${tmuxSession}`}
            title={`Copy attach command: tmux attach -t ${tmuxSession}`}
            className="shrink-0"
          >
            <span className="sr-only">Copy attach command</span>
          </CopyTarget>
        }
      />
      <SessionActionRow
        icon={<ArrowsClockwiseIcon className="size-icon-sm" weight="regular" />}
        label="claude"
        value={sessionUuid}
        title={`Open a new tmux session running claude --resume ${sessionUuid}`}
        onAction={() => executionProcessesApi.openClaudeResume(processId)}
        secondary={
          <CopyTarget
            copyValue={`claude --resume ${sessionUuid}`}
            title={`Copy resume command: claude --resume ${sessionUuid}`}
            className="shrink-0"
          >
            <span className="sr-only">Copy resume command</span>
          </CopyTarget>
        }
      />
      <SessionActionRow
        icon={<FolderIcon className="size-icon-sm" weight="regular" />}
        label="workspace"
        title="Open a terminal in the workspace and reveal the folder in Finder"
        onAction={() => executionProcessesApi.openWorkspaceAndReveal(processId)}
      />
    </div>
  );
}
