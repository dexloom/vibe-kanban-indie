import { useMemo } from 'react';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { getInteractiveConfig } from '@/shared/lib/interactive';

export interface HeadedSession {
  /** The headed coding-agent execution process (may or may not still be running). */
  processId: string;
  /** Deterministic tmux session name (`vk-<processId>`). */
  tmuxSession: string;
  /** Forced Claude session id for `--resume`. */
  sessionUuid: string;
  /** `true` when the underlying process is `running`, i.e. the `vk-<id>` tmux
   * session is still alive and attachable. `false` once tmux has exited (the
   * session can still be resumed into a fresh tmux, but attach/send-input are
   * no longer possible). */
  live: boolean;
}

/**
 * The latest headed (interactive tmux) coding-agent session, whether or not
 * its tmux is still live.
 *
 * Shared single source of truth for both the Sessions block
 * (`HeadedSessionIds`) and the right-sidebar Terminal "attach" action so they
 * agree on whether a session exists and what its tmux name is. The list is
 * sorted created_at ascending; the latest headed coding-agent process (by
 * creation order) is returned regardless of status, with `live` distinguishing
 * a running tmux (`vk-<id>`) from one that has already exited. Consumers that
 * need a live tmux to attach or send input must gate on `.live` themselves.
 * Returns `null` only when there is no headed coding-agent process at all.
 */
export function useHeadedSession(): HeadedSession | null {
  const { executionProcessesAll } = useExecutionProcessesContext();

  return useMemo(() => {
    const process = [...executionProcessesAll]
      .reverse()
      .find(
        (p) =>
          p.run_reason === 'codingagent' && getInteractiveConfig(p) !== null
      );
    if (!process) return null;
    const config = getInteractiveConfig(process);
    if (!config) return null;
    return {
      processId: process.id,
      tmuxSession: `vk-${process.id}`,
      sessionUuid: config.session_uuid,
      live: process.status === 'running',
    };
  }, [executionProcessesAll]);
}
