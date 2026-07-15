// The orchestrator is launched as the **default** Claude session (NOT
// `--agent vibe-kanban-indie:orchestrator`). Selecting a plugin agent as the
// top-level session agent leaves the plugin's sibling agents unregistered as
// spawnable subagent types, so `Agent(sweeper)` fails with `Agent type 'sweeper'
// not found` (and `--plugin-dir` does not fix it). The default agent registers
// every enabled plugin's agents as spawnable subagent types, so the loop manager
// can spawn `vibe-kanban-indie:sweeper` / `:decider` / `:intake`.
//
// Because there is no `orchestrator` *agent definition* backing the session, the
// loop-manager BEHAVIOR now travels in the `/loop` brief this file composes: it is
// self-contained (no `$CLAUDE_PLUGIN_ROOT`, no "your agent definition") and carries
// the whole tick — spawn one sweeper, relay verbatim, re-arm on CADENCE, operator
// triage. The heavy per-stage logic still lives in the plugin's `sweeper` /
// `intake` / `decider` agents (spawned by qualified name); this brief is only the
// thin loop-manager wrapper that drives them.
//
// This file also owns the spawn-dialog OPTIONS: the toggleable directives the
// operator picks for a run. Each directive is emitted as a thin FLAG (its `id`) in
// a byte-exact "Directives enabled for this run" block; the loop manager forwards
// that block verbatim to the sweeper, whose agent instructions define what each
// flag does. The block's header text is a contract with `agents/sweeper.md` — keep
// it byte-identical.

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

/** How often the orchestrator re-runs its sweep. */
export const ORCHESTRATOR_LOOP_INTERVAL = '5m';

/**
 * Compose the `/loop`-wrapped spawn prompt for the orchestrator's **default** Claude
 * session. It is SELF-CONTAINED: it arms the timer at
 * {@link ORCHESTRATOR_LOOP_INTERVAL} and carries the entire loop-manager behavior
 * inline (spawn one `vibe-kanban-indie:sweeper` per tick, relay its report verbatim,
 * re-arm only on the sweeper's `CADENCE:` line, and triage operator instructions to
 * `intake` / `decider`). It intentionally references neither `$CLAUDE_PLUGIN_ROOT`
 * nor an `orchestrator` agent definition — the session runs as the default agent, so
 * neither is available.
 *
 * The behavior lives in the recurring `/loop` body (not a system prompt) on purpose:
 * `/loop` re-submits this body each tick, so it survives context compaction over a
 * days-long run. Enabled directive FLAGS are appended as a byte-exact "Directives
 * enabled for this run" block that the manager forwards verbatim to the sweeper (its
 * instructions define what each flag does). Flags are emitted in declaration order so
 * the prompt is stable regardless of checkbox toggle order.
 */
export function composeOrchestratorPrompt(
  enabledIds: ReadonlySet<string>
): string {
  const base =
    `/loop ${ORCHESTRATOR_LOOP_INTERVAL} You are the vibe-kanban ORCHESTRATOR LOOP ` +
    `MANAGER, running as an ordinary Claude session. You own the TIMER and the ` +
    `RELAY; a fresh sweeper subagent owns each tick's board sweep. You never touch ` +
    `the board yourself and hold no board state — every tick you delegate to the ` +
    `sweeper and relay its short report, which keeps this session's context flat ` +
    `over a days-long run.\n\n` +
    `On the FIRST run, confirm the /loop timer is armed (CronList shows a recurring ` +
    `sweep job); if not, arm it before anything else. Then each tick:\n` +
    `1. SPAWN ONE SWEEPER, synchronously — spawn exactly one subagent of type ` +
    `vibe-kanban-indie:sweeper (Task/Agent tool; never twice, never zero) and tell ` +
    `it: "Run ONE full sweep of the vibe-kanban board per your agent definition, ` +
    `and end your report with the machine-readable CADENCE: line." Append to its ` +
    `task, each on its own line: LOOP INTERVAL: <interval> derived from the LIVE ` +
    `cron schedule via CronList (never from prompt text; omit the line if you ` +
    `cannot determine it); TRIGGER: scheduled (or, for an operator instruction ` +
    `routed here, TRIGGER: operator-instruction followed by an OPERATOR ` +
    `INSTRUCTION: heading with the operator's prompt byte-for-byte); and the ` +
    `"Directives enabled for this run" block at the END of this prompt, if any, ` +
    `copied BYTE-FOR-BYTE (paraphrasing it silently turns every directive off). If ` +
    `the sweeper errors, report it and end the tick — NEVER sweep the board ` +
    `yourself.\n` +
    `2. RELAY the sweeper's report verbatim to the console (and, under ` +
    `telegram-fanout, mirror it to the Orchestrate topic). Add nothing but a ` +
    `failure note; never re-run, summarize away, or contradict a sweep you did not ` +
    `run.\n` +
    `3. RE-ARM ONLY IF ASKED — read the report's LAST non-empty line. CADENCE: ` +
    `unchanged ⇒ do nothing. CADENCE: re-arm <interval> ⇒ CronList (capture the ` +
    `sweep job's exact id AND exact prompt), CronCreate the SAME prompt on the new ` +
    `schedule, then CronDelete the old id — CREATE BEFORE DELETE. Absent or ` +
    `unparseable ⇒ treat as unchanged and say so; never guess a re-arm.\n\n` +
    `OPERATOR INSTRUCTIONS (any prompt that is not the scheduled sweep) are triaged ` +
    `FIRST, precedence A→C→B: (A) create a card / attach a pipeline ⇒ YOU spawn ` +
    `vibe-kanban-indie:intake (never forward it); (C) a direct "answer that ` +
    `questionnaire" ⇒ YOU spawn vibe-kanban-indie:decider (never forward it — a ` +
    `subagent cannot spawn a subagent); (B) everything else ⇒ forward it VERBATIM ` +
    `to the sweeper under TRIGGER: operator-instruction. sweeper, decider and ` +
    `intake (all vibe-kanban-indie:*) are the only subagents you spawn.\n\n` +
    `Never auto-resume or auto-clear a card the sweeper reports as parked at an ` +
    `operator gate — that decision is the operator's. Then stop until the next tick.`;
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
