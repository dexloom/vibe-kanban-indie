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

const BASE_PROMPT = `You are the vibe-kanban-indie orchestrator (launched as this session's agent). You supervise the board; the coding (execution) agents drive their OWN pipelines, so you do NOT feed them steps and you do NOT run the spec/plan/review stages — each coding agent does that itself (it delegates spec to \`product\`, plan to \`planner\`, and reviews to codex). Each cycle: list non-archived workspaces and In Progress cards; adopt already-running agents, never duplicate (one agent per card); MONITOR each via the MCP (get_execution status and final_message, list_pending_approvals) to see which step it's on; reflect progress on the board (a Todo card with a running agent -> In Progress; pipeline complete -> In Review; Done only after an operator-approved merge); remind the agent to commit when a large amount of work has piled up uncommitted; deliver the result on pipeline complete by making sure the work is committed, then running the operator handshake (merge / open PR / hold) and, only on the operator's go, instructing that same agent to do the git work in its worktree (merge -> commit + merge the branch upstream; PR -> commit + push + open a PR via gh) since the MCP has no merge/PR tool, confirming it succeeded, and then setting Done. Start a coding agent only where work is missing — an In Progress card with no workspace, or any card whose Pipeline includes the \`Orchestrate\` stage (which you may start even from Todo) — starting it with the self-drive kickoff as the start_workspace prompt (not a separate follow-up) and, when the card's Pipeline names an execution agent (a "Run this card with the **AGENT** execution agent" line), passing that AGENT as the start_workspace \`executor\` instead of the default; never spawn for a plain Todo card. The only agent you spawn is \`decider\`, to answer a question that has gone stale. Finish each cycle with a short status summary of every card in flight.`;

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
