import { useCallback, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { getInteractiveConfig } from '@/shared/lib/interactive';
import { writeClipboardViaBridge } from '@/shared/lib/clipboard';

/** A single click-to-copy chip: `label value` with a copy/check affordance. */
function CopyChip({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await writeClipboardViaBridge(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      className="group flex items-center gap-1 min-w-0 rounded-sm px-1 py-0.5 text-low hover:text-normal hover:bg-panel transition-colors"
    >
      <span className="text-low/70 shrink-0">{label}</span>
      <span className="truncate">{value}</span>
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
        title={`Copy tmux session ${headed.tmuxSession}`}
      />
      <CopyChip
        label="claude"
        value={headed.sessionUuid}
        title={`Copy Claude session ${headed.sessionUuid}`}
      />
    </div>
  );
}
