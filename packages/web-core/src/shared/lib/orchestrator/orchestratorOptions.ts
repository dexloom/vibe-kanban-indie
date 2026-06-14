// The orchestrator's behavior is intentionally NOT defined here. It lives entirely
// in the `vibe-kanban-indie` plugin (the sombrax_plugins folder): the agent
// definition (`agents/orchestrator.md`) and its per-tick brief
// (`scripts/orchestrator.prompt.md`). The backend launches the orchestrator AS that
// agent (`--agent vibe-kanban-indie:orchestrator`), so this dialog must only arm the
// `/loop` timer and point the agent at its bundled per-tick brief — it must never
// re-state what the orchestrator does. (A full behavior prompt used to be hardcoded
// here; it duplicated the plugin and drifted out of sync, so it was removed.)

/** How often the orchestrator re-runs its dispatch sweep. */
export const ORCHESTRATOR_LOOP_INTERVAL = '5m';

/**
 * The `/loop`-wrapped spawn prompt. It carries no orchestrator behavior: it arms the
 * timer at {@link ORCHESTRATOR_LOOP_INTERVAL} and tells the agent (already launched
 * as `vibe-kanban-indie:orchestrator`) to run exactly one dispatch sweep per its
 * bundled per-tick brief. All behavior is sourced from the plugin, never from here.
 */
export function composeOrchestratorPrompt(): string {
  return (
    `/loop ${ORCHESTRATOR_LOOP_INTERVAL} Run exactly one orchestrator dispatch ` +
    `sweep now, following your agent definition and the per-tick brief at ` +
    '${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.prompt.md; then stop until the ' +
    `next tick.`
  );
}
