// The orchestrator's BEHAVIOR is intentionally NOT defined here. It lives entirely
// in the `vibe-kanban-indie` plugin (the sombrax_plugins folder): the agent
// definition (`agents/orchestrator.md`) and its per-tick brief
// (`scripts/orchestrator.prompt.md`). The backend launches the orchestrator AS that
// agent (`--agent vibe-kanban-indie:orchestrator`).
//
// This file owns only the spawn-dialog OPTIONS: the toggleable directives the
// operator picks for a run. Each directive is passed to the agent as a thin FLAG
// (its `id`) — never as a behavioral paragraph. What each flag does is encoded in
// the agent instructions, which read the enabled flags from the spawn prompt and
// act on them. (A full behavior prompt used to be hardcoded here; it duplicated the
// plugin and drifted out of sync, so the prose was removed while the options stayed.)

export interface OrchestratorDirective {
  /** Stable id; the localStorage key, i18n namespace, AND the flag passed to the
   *  agent. The agent instructions define this id's behavior. */
  id: string;
  /** i18n key in tasks.json (`spawnOrchestrator.options.<id>.label`). */
  labelKey: string;
  /** i18n key in tasks.json (`spawnOrchestrator.options.<id>.description`). */
  descriptionKey: string;
  /** Whether the checkbox is ticked by default for a fresh operator. */
  defaultEnabled: boolean;
}

// To add a future directive: append an entry here (with i18n label/description under
// `spawnOrchestrator.options.<id>` in tasks.json) AND define its behavior in the
// agent instructions keyed by the same `id`. Nothing behavioral belongs in this file.
export const ORCHESTRATOR_DIRECTIVES: OrchestratorDirective[] = [
  {
    id: 'auto-unblock',
    labelKey: 'spawnOrchestrator.options.auto-unblock.label',
    descriptionKey: 'spawnOrchestrator.options.auto-unblock.description',
    defaultEnabled: false,
  },
  {
    id: 'auto-answer-questions',
    labelKey: 'spawnOrchestrator.options.auto-answer-questions.label',
    descriptionKey:
      'spawnOrchestrator.options.auto-answer-questions.description',
    defaultEnabled: false,
  },
  {
    id: 'telegram-fanout',
    labelKey: 'spawnOrchestrator.options.telegram-fanout.label',
    descriptionKey: 'spawnOrchestrator.options.telegram-fanout.description',
    defaultEnabled: false,
  },
];

/** How often the orchestrator re-runs its sweep. */
export const ORCHESTRATOR_LOOP_INTERVAL = '5m';

/**
 * Compose the `/loop`-wrapped spawn prompt. It carries NO orchestrator behavior: it
 * arms the timer at {@link ORCHESTRATOR_LOOP_INTERVAL}, points the agent (already
 * launched as `vibe-kanban-indie:orchestrator`) at its bundled per-tick brief, and
 * lists which directive FLAGS are enabled this run. The agent instructions define
 * what each flag does. Flags are emitted in declaration order so the prompt is stable
 * regardless of checkbox toggle order.
 */
export function composeOrchestratorPrompt(
  enabledIds: ReadonlySet<string>
): string {
  const base =
    `/loop ${ORCHESTRATOR_LOOP_INTERVAL} Run exactly one orchestrator sweep now, ` +
    `following your agent definition and the per-tick brief at ` +
    '${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator.prompt.md; then stop until the ' +
    `next tick.`;
  const picked = ORCHESTRATOR_DIRECTIVES.filter((d) => enabledIds.has(d.id));
  if (picked.length === 0) return base;
  const flags = picked.map((d) => `- ${d.id}`).join('\n');
  return (
    `${base}\n\nDirectives enabled for this run — apply each one's behavior as ` +
    `defined in your agent instructions:\n${flags}`
  );
}

const DIRECTIVE_STORAGE_KEY = 'vk:orchestrator-directives';

/** Default enabled-state map derived from the directive declarations. */
export function defaultDirectiveState(): Record<string, boolean> {
  return Object.fromEntries(
    ORCHESTRATOR_DIRECTIVES.map((d) => [d.id, d.defaultEnabled])
  );
}

/**
 * Load persisted checkbox state, merging stored values over the declared defaults so
 * newly-added directives keep their default until the operator touches them.
 */
export function loadDirectiveState(): Record<string, boolean> {
  const defaults = defaultDirectiveState();
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(DIRECTIVE_STORAGE_KEY);
    if (!raw) return defaults;
    const stored = JSON.parse(raw) as Record<string, boolean>;
    for (const d of ORCHESTRATOR_DIRECTIVES) {
      if (typeof stored[d.id] === 'boolean') defaults[d.id] = stored[d.id];
    }
  } catch {
    // Corrupt/unparseable value — fall back to defaults.
  }
  return defaults;
}

/** Persist the operator's checkbox state for the next spawn. */
export function saveDirectiveState(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DIRECTIVE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode/quota) — non-fatal.
  }
}
