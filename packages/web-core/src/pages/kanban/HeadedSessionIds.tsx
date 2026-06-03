import { useCallback, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { getInteractiveConfig } from '@/shared/lib/interactive';
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

/**
 * A click-to-copy chip with two independent targets: clicking the `label`
 * copies the `command` (e.g. the full attach/resume command), while clicking
 * the displayed `value` copies just the bare id.
 */
function CopyChip({
  label,
  value,
  command,
  labelTitle,
  valueTitle,
}: {
  label: string;
  value: string;
  command: string;
  labelTitle: string;
  valueTitle: string;
}) {
  return (
    <span className="inline-flex items-center min-w-0">
      <CopyTarget copyValue={command} title={labelTitle} className="shrink-0">
        <span className="text-low/70">{label}</span>
      </CopyTarget>
      <CopyTarget copyValue={value} title={valueTitle} className="min-w-0">
        <span className="truncate">{value}</span>
      </CopyTarget>
    </span>
  );
}

/**
 * Surfaces the tmux + Claude Code session identifiers for a headed (interactive
 * tmux) coding-agent execution, rendered as a thin row under the panel header.
 * Clicking a chip copies that identifier. Renders nothing for non-headed sessions.
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
      tmuxSession: `vk-${process.id}`,
      sessionUuid: config.session_uuid,
    };
  }, [executionProcessesAll]);

  if (!headed) return null;

  return (
    <div className="flex items-center gap-2 px-base py-half border-b shrink-0 font-mono text-xs min-w-0">
      <CopyChip
        label="tmux"
        value={headed.tmuxSession}
        command={`tmux attach -t ${headed.tmuxSession}`}
        labelTitle={`Copy attach command: tmux attach -t ${headed.tmuxSession}`}
        valueTitle={`Copy tmux session id ${headed.tmuxSession}`}
      />
      <CopyChip
        label="claude"
        value={headed.sessionUuid}
        command={`claude --resume ${headed.sessionUuid}`}
        labelTitle={`Copy resume command: claude --resume ${headed.sessionUuid}`}
        valueTitle={`Copy Claude session id ${headed.sessionUuid}`}
      />
    </div>
  );
}
