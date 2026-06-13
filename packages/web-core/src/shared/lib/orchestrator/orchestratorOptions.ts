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
    id: 'auto-unblock',
    labelKey: 'spawnOrchestrator.options.auto-unblock.label',
    descriptionKey: 'spawnOrchestrator.options.auto-unblock.description',
    defaultEnabled: false,
    fragment:
      'Approvals: auto-approve routine, plan-sanctioned tool requests via respond_to_approval; escalate anything destructive, expensive, or off-plan to the operator instead.',
  },
  {
    id: 'auto-answer-questions',
    labelKey: 'spawnOrchestrator.options.auto-answer-questions.label',
    descriptionKey:
      'spawnOrchestrator.options.auto-answer-questions.description',
    defaultEnabled: false,
    fragment:
      "Questionnaires: each sweep, list_pending_approvals(execution_process_id) for every running agent to find pending questions (AskUserQuestion / plan questionnaires) and their age_seconds. Give the operator a grace window — once a question's age_seconds is past ~two loop intervals (default ~600s) with no human answer — spawn the `decider` subagent (Agent(decider)) to read the card, spec, plan, and the question, pick the best-supported option for every stale question, and submit it via respond_to_approval(decision='answer'). Key the grace off age_seconds, not a remembered tick count.",
  },
  {
    id: 'telegram-fanout',
    labelKey: 'spawnOrchestrator.options.telegram-fanout.label',
    descriptionKey: 'spawnOrchestrator.options.telegram-fanout.description',
    defaultEnabled: false,
    fragment:
      'Use the sombrax-telegram channel: narrate status to the operator topic and converse with each headed agent over its per-workspace Telegram topic (topic = workspace branch). Requires the sombrax-telegram listener to be running.',
  },
];

const BASE_PROMPT = `Use the vibe-kanban-indie:orchestrator agent (via the Task tool) to check the vibe-kanban board and drive all actively running tasks to done. Each cycle: list non-archived workspaces and In Progress cards; adopt already-running agents before ever spawning (one agent per card); spawn an agent only for an In Progress card with no workspace, never for Todo; monitor executions (get_execution status and final_message); send each idle agent its next step from its plan; reflect progress on the board (In Progress -> In Review on pipeline complete -> Done only after operator-approved merge); finish the cycle with a short status summary of every card in flight. Each card's Pipeline section (the \`## Pipeline\` block in the card description) is the source of truth for which stages run: run exactly the stages it lists, in order, delegating the spec stage to the \`product\` agent and the plan stage to the \`planner\` agent (separate ephemeral agents that write \`SPEC.md\` / \`IMPLEMENTATION_PLAN.md\`) before the implementation agent, and don't advance a card past a stage its pipeline requires until that stage is done. If a card's Pipeline includes the \`Orchestrate\` stage, drive that card to done regardless of which column it is in — you may spawn for it even from Todo, overriding the usual In-Progress-only spawn gate.`;

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
