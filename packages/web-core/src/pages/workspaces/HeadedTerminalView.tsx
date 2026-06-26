import { useEffect } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { XTermInstance } from '@/shared/components/XTermInstance';

interface HeadedTerminalViewProps {
  /** The running headed coding-agent execution process to attach to. */
  processId: string;
}

/**
 * In-pane live terminal attached to a headed agent's tmux session
 * (`vk-<processId>`). Mounted directly (not via the sidebar terminal tab list)
 * with a dedicated, self-namespaced `tabId` so it never collides with sidebar
 * `term-…` tabs. On unmount it fully tears down its WebSocket + xterm via
 * `disposeStandaloneTerminal` to avoid leaking the connection.
 */
export function HeadedTerminalView({ processId }: HeadedTerminalViewProps) {
  const { workspaceId } = useWorkspaceContext();
  const { disposeStandaloneTerminal } = useTerminal();

  // Dedicated namespace; never collides with sidebar `term-<ts>-<rand>` ids.
  const tabId = `headed-${processId}`;

  useEffect(() => {
    return () => {
      disposeStandaloneTerminal(tabId);
    };
  }, [tabId, disposeStandaloneTerminal]);

  if (!workspaceId) return null;

  return (
    <div className="flex-1 min-h-0">
      <XTermInstance
        tabId={tabId}
        workspaceId={workspaceId}
        isActive
        executionProcessId={processId}
      />
    </div>
  );
}
