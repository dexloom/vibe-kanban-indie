// The orchestrator is launched as the plugin's own session agent
// (`claude --agent vibe-kanban-indie:orchestrator` — see
// `orchestrator_executor_config` in crates/server/src/routes/workspaces/create.rs).
// The plugin's SINGLE-LOOP orchestrator owns the whole tick itself (monitor-first
// two-mode loop; the retired `sweeper` subagent is gone), so its behavior lives in
// the plugin agent definition — the `/loop` body this file composes is only the
// SHORT per-tick pointer, mirroring the plugin's own launcher pointer
// (`scripts/orchestrator.prompt.md` in sombrax_plugins). Keep the two aligned when
// the plugin's pointer changes.
//
// This file also owns the spawn-dialog OPTIONS: the toggleable directives the
// operator picks for a run. Each directive is emitted as a thin FLAG (its `id`) in
// a byte-exact "Directives enabled for this run" block appended to the end of the
// spawn prompt; the agent's plugin instructions (`reference/directives.md`) define
// what each flag does. The block's header text is a contract with
// `agents/orchestrator.md` — keep it byte-identical.

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
  {
    id: 'nudge-stuck',
    labelKey: 'spawnOrchestrator.options.nudge-stuck.label',
    descriptionKey: 'spawnOrchestrator.options.nudge-stuck.description',
    defaultEnabled: false,
  },
];

/** The orchestrator's ACTIVE cadence — the interval the `/loop` timer is armed at.
 *  The agent adapts its own cron afterwards (5m active ↔ 30m idle). */
export const ORCHESTRATOR_LOOP_INTERVAL = '5m';

/**
 * Compose the `/loop`-wrapped spawn prompt for the orchestrator session
 * (`claude --agent vibe-kanban-indie:orchestrator`). It arms the timer at
 * {@link ORCHESTRATOR_LOOP_INTERVAL} with the SHORT per-tick pointer — the agent's
 * full behavior (monitor-first two-mode tick, dispatch, status reflection, adaptive
 * cadence) lives in the plugin's `agents/orchestrator.md`, so the pointer stays tiny
 * and `/loop` re-submits it each tick, surviving context compaction over a days-long
 * run. The pointer mirrors the plugin's own `scripts/orchestrator.prompt.md`.
 *
 * Enabled directive FLAGS are appended as a byte-exact "Directives enabled for this
 * run" block ENDING the prompt (the agent expects the directive list to end its spawn
 * prompt; its plugin instructions define what each flag does). Flags are emitted in
 * declaration order so the prompt is stable regardless of checkbox toggle order.
 */
export function composeOrchestratorPrompt(
  enabledIds: ReadonlySet<string>
): string {
  const base =
    `/loop ${ORCHESTRATOR_LOOP_INTERVAL} Run one tick of the board loop per your ` +
    `agent definition (vibe-kanban-indie:orchestrator): pick the mode from retained ` +
    `context — MONITOR the active cards by default; run a full SWEEP only when a ` +
    `sweep trigger fires (nothing active, a lane freed, an operator instruction, or ` +
    `the periodic backstop). Triage any operator instruction first (intake / ` +
    `decider / handle directly).`;
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
