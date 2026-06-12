// Single source of truth for the orchestrator spawn dialog's toggleable
// directives. To add a future checkbox, append an entry to
// ORCHESTRATOR_DIRECTIVES: provide an i18n label/description (under
// `spawnOrchestrator.options.<id>` in tasks.json), a default, and the prompt
// `fragment` appended under "Directives for this run:". Nothing else needs to
// change — the dialog, persistence, and prompt composition all derive from
// this list.

export interface OrchestratorDirective {
  /** Stable id; used as the localStorage key and i18n namespace. */
  id: string;
  /** i18n key in tasks.json (`spawnOrchestrator.options.<id>.label`). */
  labelKey: string;
  /** i18n key in tasks.json (`spawnOrchestrator.options.<id>.description`). */
  descriptionKey: string;
  /** Whether the checkbox is ticked by default for a fresh operator. */
  defaultEnabled: boolean;
  /** Appended verbatim as a bullet under "Directives for this run:". */
  fragment: string;
}

export const ORCHESTRATOR_DIRECTIVES: OrchestratorDirective[] = [
  {
    id: 'plan-review',
    labelKey: 'spawnOrchestrator.options.plan-review.label',
    descriptionKey: 'spawnOrchestrator.options.plan-review.description',
    defaultEnabled: true,
    fragment:
      'For every agent you spawn, run the full planning gate: have the agent write IMPLEMENTATION_PLAN.md (your plan.md prompt), then gate it with a codex plan review (your codex-review.md prompt in plan mode, `codex exec --sandbox read-only`) and loop on blockers until CODEX VERDICT: PASS before sending any development step.',
  },
  {
    id: 'codex-diff-review',
    labelKey: 'spawnOrchestrator.options.codex-diff-review.label',
    descriptionKey: 'spawnOrchestrator.options.codex-diff-review.description',
    defaultEnabled: true,
    fragment:
      'Before moving any card to In Review, require a codex diff review (your codex-review.md prompt in diff mode, `codex review --base <target branch>`) and loop on blockers until it PASSes.',
  },
  {
    id: 'auto-unblock',
    labelKey: 'spawnOrchestrator.options.auto-unblock.label',
    descriptionKey: 'spawnOrchestrator.options.auto-unblock.description',
    defaultEnabled: false,
    fragment:
      'Approvals: auto-approve routine, plan-sanctioned tool requests via respond_to_approval; escalate anything destructive, expensive, or off-plan to the operator instead.',
  },
  {
    id: 'telegram-fanout',
    labelKey: 'spawnOrchestrator.options.telegram-fanout.label',
    descriptionKey: 'spawnOrchestrator.options.telegram-fanout.description',
    defaultEnabled: false,
    fragment:
      'Use the sombrax-telegram channel: narrate status to the operator topic and converse with each headed agent over its per-workspace Telegram topic (topic = workspace branch). Requires the sombrax-telegram listener to be running.',
  },
  {
    id: 'spec-intake',
    labelKey: 'spawnOrchestrator.options.spec-intake.label',
    descriptionKey: 'spawnOrchestrator.options.spec-intake.description',
    defaultEnabled: false,
    fragment:
      'If the operator hands you a rough task brief, turn it into a development-ready card with the vibe-kanban-indie:product-manager skill before scheduling work; never start an agent from an unspecced brief.',
  },
];

const BASE_PROMPT = `Use the vibe-kanban-indie:orchestrator agent (via the Task tool) to check the vibe-kanban board and drive all actively running tasks to done. Each cycle: list non-archived workspaces and In Progress cards; adopt already-running agents before ever spawning (one agent per card); spawn an agent only for an In Progress card with no workspace, never for Todo; monitor executions (get_execution status and final_message); send each idle agent its next step from its plan; reflect progress on the board (In Progress -> In Review on pipeline complete -> Done only after operator-approved merge); finish the cycle with a short status summary of every card in flight.`;

/**
 * Compose the `/loop`-wrapped orchestration brief from the set of enabled
 * directive ids. Directives are emitted in declaration order so the prompt is
 * stable regardless of checkbox toggle order.
 */
export function composeOrchestratorPrompt(
  enabledIds: ReadonlySet<string>
): string {
  const picked = ORCHESTRATOR_DIRECTIVES.filter((d) => enabledIds.has(d.id));
  const directives = picked.length
    ? `\n\nDirectives for this run:\n${picked
        .map((d) => `- ${d.fragment}`)
        .join('\n')}`
    : '';
  return `/loop ${BASE_PROMPT}${directives}`;
}

const DIRECTIVE_STORAGE_KEY = 'vk:orchestrator-directives';

/** Default enabled-state map derived from the directive declarations. */
export function defaultDirectiveState(): Record<string, boolean> {
  return Object.fromEntries(
    ORCHESTRATOR_DIRECTIVES.map((d) => [d.id, d.defaultEnabled])
  );
}

/**
 * Load persisted checkbox state, merging stored values over the declared
 * defaults so newly-added directives keep their default until the operator
 * touches them.
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
