import { useMemo } from 'react';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { getInteractiveConfig } from '@/shared/lib/interactive';

export interface HeadedSession {
  /** The running headed coding-agent execution process. */
  processId: string;
  /** Deterministic tmux session name (`vk-<processId>`). */
  tmuxSession: string;
  /** Forced Claude session id for `--resume`. */
  sessionUuid: string;
}

/**
 * The live headed (interactive tmux) coding-agent session, if one is running.
 *
 * Shared single source of truth for both the Sessions block
 * (`HeadedSessionIds`) and the right-sidebar Terminal "attach" action so they
 * agree on whether a session exists and what its tmux name is. The list is
 * sorted created_at ascending; the latest running headed coding-agent process
 * owns the live tmux session. Returns `null` when there is no such session.
 */
export function useHeadedSession(): HeadedSession | null {
  const { executionProcessesAll } = useExecutionProcessesContext();

  return useMemo(() => {
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
}
