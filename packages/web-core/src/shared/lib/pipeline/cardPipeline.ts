import {
  type Config,
  DEFAULT_PIPELINE_STEPS,
  type PipelineStep,
} from 'shared/types';

/**
 * Delimiters bounding the generated `## Pipeline` block inside a card
 * description. They let us append/replace the block idempotently without
 * clobbering the operator's own prose.
 */
export const PIPELINE_START = '<!-- vk:pipeline:start -->';
export const PIPELINE_END = '<!-- vk:pipeline:end -->';

/**
 * The effective pipeline-step catalog for the current config: the operator's
 * customised list when set, otherwise the built-in defaults (single source of
 * truth defined in Rust, exported as `DEFAULT_PIPELINE_STEPS`).
 */
export function effectiveSteps(
  config: Config | null | undefined
): PipelineStep[] {
  return config?.pipeline_steps ?? DEFAULT_PIPELINE_STEPS;
}

/**
 * Compose the directive line that pins the card to a specific execution agent.
 * The orchestrator reads this from the description and passes the named agent as
 * the `executor` when it starts the workspace. Returns an empty string when no
 * agent is selected (the orchestrator then uses its default). `executor` is a
 * `BaseCodingAgent` key (e.g. `CODEX`, `CLAUDE_CODE`).
 */
export function composeExecutorLine(
  executor: string | null | undefined
): string {
  const trimmed = (executor ?? '').trim();
  if (!trimmed) return '';
  return `- Run this card with the **${trimmed}** execution agent: pass \`executor: "${trimmed}"\` when starting the workspace.`;
}

/**
 * Compose the delimited `## Pipeline` markdown block from the ticked steps (in
 * catalog order), an optional pinned execution agent, plus any free-text the
 * operator added. Returns an empty string when nothing is selected and there is
 * no custom text, so callers can treat "no pipeline" as falsy.
 */
export function composePipelineBlock(
  steps: PipelineStep[],
  enabledIds: ReadonlySet<string> | readonly string[],
  customText: string,
  executor?: string | null
): string {
  const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
  const stepBullets = steps
    .filter((s) => enabled.has(s.id))
    .map((s) => `- ${s.prompt_fragment}`);
  const executorLine = composeExecutorLine(executor);
  // The execution-agent directive leads so the orchestrator sees it first.
  const bullets = executorLine ? [executorLine, ...stepBullets] : stepBullets;
  const trimmedCustom = customText.trim();

  if (bullets.length === 0 && trimmedCustom.length === 0) {
    return '';
  }

  const lines = ['## Pipeline', ''];
  lines.push(...bullets);
  if (trimmedCustom.length > 0) {
    if (bullets.length > 0) lines.push('');
    lines.push(trimmedCustom);
  }

  return `${PIPELINE_START}\n${lines.join('\n')}\n${PIPELINE_END}`;
}

/**
 * Strip any previously-appended pipeline block from a description, returning the
 * remaining prose with trailing whitespace trimmed.
 */
function stripPipelineBlock(description: string): string {
  const start = description.indexOf(PIPELINE_START);
  if (start === -1) return description;
  const endIdx = description.indexOf(PIPELINE_END, start);
  const after =
    endIdx === -1 ? '' : description.slice(endIdx + PIPELINE_END.length);
  return (description.slice(0, start) + after).replace(/\s+$/, '');
}

/**
 * Append (or replace) the pipeline block at the end of a description. Idempotent:
 * any existing delimited block is removed first, so re-appending never stacks
 * duplicates. Passing an empty block strips the existing one.
 */
export function appendPipelineToDescription(
  description: string | null,
  block: string
): string {
  const base = stripPipelineBlock(description ?? '');
  if (!block) return base;
  return base.length > 0 ? `${base}\n\n${block}` : block;
}
