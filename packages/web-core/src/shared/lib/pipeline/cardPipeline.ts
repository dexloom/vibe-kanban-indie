import { type Pipeline } from 'shared/types';

/**
 * Delimiters bounding the generated `## Pipeline` block inside a card
 * description. They let us append/replace the block idempotently without
 * clobbering the operator's own prose.
 */
export const PIPELINE_START = '<!-- vk:pipeline:start -->';
export const PIPELINE_END = '<!-- vk:pipeline:end -->';

/**
 * Instruction line that leads the stage list. Pipelines are now authored by
 * vibe-kanban (from a pipeline file) and delivered pre-ordered, so the execution
 * agent runs them top-to-bottom rather than choosing which apply.
 */
const ORDER_INSTRUCTION =
  'Execute these stages in the order listed. Do not add, skip, or reorder stages.';

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
 * Compose the delimited `## Pipeline` markdown block for the chosen pipeline.
 * Enabled stages render as an **ordered numbered list in pipeline order**, under
 * a heading naming the pipeline, preceded by an explicit "run in order"
 * instruction. An optional pinned execution agent leads the list.
 *
 * When `pipeline` is `null` (the "None" option) stages are ignored entirely: the
 * block contains only the executor-pin line (if an agent is pinned) and/or the
 * operator's custom text. Returns an empty string when there is nothing to emit,
 * so callers can treat "no pipeline" as falsy.
 */
export function composePipelineBlock(
  pipeline: Pipeline | null,
  enabledIds: ReadonlySet<string> | readonly string[],
  customText: string,
  executor?: string | null
): string {
  const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
  const executorLine = composeExecutorLine(executor);
  const trimmedCustom = customText.trim();

  const stages = pipeline
    ? pipeline.stages.filter((s) => enabled.has(s.id))
    : [];

  if (stages.length === 0 && !executorLine && trimmedCustom.length === 0) {
    return '';
  }

  const heading = pipeline ? `## Pipeline: ${pipeline.name}` : '## Pipeline';
  const lines: string[] = [heading, ''];

  if (stages.length > 0) {
    lines.push(ORDER_INSTRUCTION, '');
  }
  // The execution-agent directive leads so the orchestrator sees it first.
  if (executorLine) {
    lines.push(executorLine);
    if (stages.length > 0) lines.push('');
  }
  stages.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.prompt_fragment}`);
  });
  if (trimmedCustom.length > 0) {
    if (stages.length > 0 || executorLine) lines.push('');
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
