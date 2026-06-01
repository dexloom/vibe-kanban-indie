import type { ExecutionProcess, InteractiveTmuxConfig } from 'shared/types';

/**
 * Interactive (detached tmux / "headed") config for a process, if it is a headed
 * coding-agent execution. Narrows the generated `ExecutorActionType` union before
 * reading `interactive` (Script/Review requests have no such field).
 */
export function getInteractiveConfig(
  process: ExecutionProcess
): InteractiveTmuxConfig | null {
  const typ = process.executor_action.typ;
  if (
    typ.type === 'CodingAgentInitialRequest' ||
    typ.type === 'CodingAgentFollowUpRequest'
  ) {
    return typ.interactive ?? null;
  }
  return null;
}
