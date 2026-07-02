import { type Pipeline, type PipelineStep } from 'shared/types';

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

/** Matches an executor-pin line in any pinned form (any agent name). */
const EXECUTOR_LINE_RE =
  /^- Run this card with the \*\*.+\*\* execution agent:/;
/** Matches a generated numbered stage line, capturing its remainder. */
const NUMBERED_LINE_RE = /^\d+\.\s+(.*)$/;
/** Matches the `## Pipeline` / `## Pipeline: <name(s)>` heading. */
const HEADING_RE = /^## Pipeline\b/;

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

/** Normalize the `pipelines` argument to an array, dropping nulls. */
function normalizePipelines(
  pipelines: readonly Pipeline[] | Pipeline | null | undefined
): Pipeline[] {
  if (!pipelines) return [];
  const arr = Array.isArray(pipelines) ? pipelines : [pipelines];
  return arr.filter((p): p is Pipeline => p != null);
}

/**
 * Merge the FULL stage sequences of the given pipelines into one canonical
 * order via a stable topological sort (Kahn's algorithm), so a stage shared
 * by two pipelines appears once and the relative order declared by every
 * pipeline is respected. Tiebreak = first-seen index across pipelines in
 * selection order, which makes the result deterministic.
 */
export function canonicalStageOrder(
  pipelines: readonly Pipeline[]
): PipelineStep[] {
  const byId = new Map<string, PipelineStep>();
  const firstSeen = new Map<string, number>();
  let seenIdx = 0;
  for (const p of pipelines) {
    for (const s of p.stages) {
      if (!byId.has(s.id)) byId.set(s.id, s);
      if (!firstSeen.has(s.id)) firstSeen.set(s.id, seenIdx++);
    }
  }

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();
  for (const id of byId.keys()) {
    indegree.set(id, 0);
    adjacency.set(id, new Set());
  }
  for (const p of pipelines) {
    for (let i = 0; i < p.stages.length - 1; i++) {
      const from = p.stages[i].id;
      const to = p.stages[i + 1].id;
      const adj = adjacency.get(from);
      if (adj && !adj.has(to)) {
        adj.add(to);
        indegree.set(to, (indegree.get(to) ?? 0) + 1);
      }
    }
  }

  const remaining = new Set(byId.keys());
  let ready: string[] = [...remaining].filter(
    (id) => (indegree.get(id) ?? 0) === 0
  );
  const ordered: string[] = [];

  const takeSmallestFirstSeen = (ids: string[]): string => {
    let best = ids[0];
    let bestSeen = firstSeen.get(best) ?? Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const seen = firstSeen.get(id) ?? Number.POSITIVE_INFINITY;
      if (seen < bestSeen) {
        best = id;
        bestSeen = seen;
      }
    }
    return best;
  };

  while (ready.length > 0) {
    const next = takeSmallestFirstSeen(ready);
    ready = ready.filter((id) => id !== next);
    ordered.push(next);
    remaining.delete(next);
    for (const succ of adjacency.get(next) ?? []) {
      const deg = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, deg);
      if (deg === 0) ready.push(succ);
    }
  }

  // Safe fallback: if a cycle ever left nodes unprocessed (shouldn't happen
  // with well-formed pipeline files), append the remainder in first-seen
  // order rather than silently dropping stages.
  if (remaining.size > 0) {
    [...remaining]
      .sort((a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0))
      .forEach((id) => ordered.push(id));
  }

  return ordered.map((id) => byId.get(id)!);
}

/**
 * The canonical stage order for `pipelines`, filtered to the enabled union.
 * Shared by `composePipelineBlock` and `PipelineSection` so both use the
 * exact same ordering logic.
 */
export function orderedEnabledStages(
  pipelines: readonly Pipeline[],
  enabledIds: ReadonlySet<string> | readonly string[]
): PipelineStep[] {
  const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
  return canonicalStageOrder(pipelines).filter((s) => enabled.has(s.id));
}

/**
 * Extract the operator's manual/extra lines from a previously composed block:
 * everything that isn't a recognised generated line (heading, order
 * instruction, executor-pin line in any pinned form, or a numbered stage line
 * whose remainder exactly matches a fragment in `knownStageFragments`).
 *
 * `knownStageFragments` should be the FULL catalog of every available
 * pipeline's stage fragments (not just the currently selected/enabled ones),
 * so that deselecting a stage or an entire pipeline still recognises its old
 * generated line and drops it, instead of stranding it as "manual".
 */
function extractManualLines(
  block: string,
  knownStageFragments: ReadonlySet<string>
): string[] {
  const start = block.indexOf(PIPELINE_START);
  const endDelim = block.indexOf(PIPELINE_END);
  const inner =
    start === -1
      ? block
      : block.slice(
          start + PIPELINE_START.length,
          endDelim === -1 ? undefined : endDelim
        );

  const manual: string[] = [];
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim().length === 0) continue;
    if (HEADING_RE.test(line)) continue;
    if (line === ORDER_INSTRUCTION) continue;
    if (EXECUTOR_LINE_RE.test(line)) continue;
    const numbered = line.match(NUMBERED_LINE_RE);
    if (numbered && knownStageFragments.has(numbered[1])) continue;
    manual.push(line);
  }
  return manual;
}

/**
 * Compose the delimited `## Pipeline` markdown block for the chosen
 * pipeline(s). Enabled stages across all selected pipelines are merged into a
 * single **canonical, deduped order** (see `canonicalStageOrder`) and render
 * as an ordered numbered list, under a heading naming the pipeline(s),
 * preceded by an explicit "run in order" instruction. An optional pinned
 * execution agent leads the list.
 *
 * When `pipelines` is `null`/empty (the "None" option) stages are ignored
 * entirely: the block contains only the executor-pin line (if an agent is
 * pinned) and/or the operator's custom text. Returns an empty string when
 * there is nothing to emit, so callers can treat "no pipeline" as falsy.
 *
 * `options.previousBlock`, when given, is scanned for manual lines (any line
 * that isn't a recognised generated line) which are preserved verbatim after
 * the generated stages — this makes recompose non-destructive. Pass
 * `options.knownStageFragments` with the full catalog of every available
 * pipeline's stage fragments so deselected stages/pipelines are correctly
 * recognised and dropped rather than preserved as manual text.
 */
export function composePipelineBlock(
  pipelines: readonly Pipeline[] | Pipeline | null,
  enabledIds: ReadonlySet<string> | readonly string[],
  customText: string,
  executor?: string | null,
  options?: {
    previousBlock?: string | null;
    knownStageFragments?: ReadonlySet<string>;
  }
): string {
  const list = normalizePipelines(pipelines);
  const enabled = enabledIds instanceof Set ? enabledIds : new Set(enabledIds);
  const executorLine = composeExecutorLine(executor);
  const trimmedCustom = customText.trim();

  const stages = orderedEnabledStages(list, enabled);

  const knownFragments =
    options?.knownStageFragments ??
    new Set(list.flatMap((p) => p.stages.map((s) => s.prompt_fragment)));

  const manualLines = options?.previousBlock
    ? extractManualLines(options.previousBlock, knownFragments)
    : [];
  // Avoid duplicating a manual line that's also present verbatim in customText.
  const customLineSet = new Set(
    trimmedCustom.length > 0
      ? trimmedCustom.split('\n').map((l) => l.trim())
      : []
  );
  const extraManualLines = manualLines.filter(
    (l) => !customLineSet.has(l.trim())
  );

  if (
    stages.length === 0 &&
    !executorLine &&
    trimmedCustom.length === 0 &&
    extraManualLines.length === 0
  ) {
    return '';
  }

  const heading =
    list.length === 0
      ? '## Pipeline'
      : `## Pipeline: ${list.map((p) => p.name).join(' + ')}`;
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

  const trailing = [...extraManualLines];
  if (trimmedCustom.length > 0) trailing.push(trimmedCustom);
  if (trailing.length > 0) {
    if (stages.length > 0 || executorLine) lines.push('');
    lines.push(trailing.join('\n'));
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
 * Extract the delimited `## Pipeline` block (including delimiters) from a
 * card description, for seeding the edit-mode `PipelineSection`. Returns an
 * empty string when the description has no pipeline block.
 */
export function extractPipelineBlock(
  description: string | null | undefined
): string {
  if (!description) return '';
  const start = description.indexOf(PIPELINE_START);
  if (start === -1) return '';
  const endIdx = description.indexOf(PIPELINE_END, start);
  if (endIdx === -1) return description.slice(start);
  return description.slice(start, endIdx + PIPELINE_END.length);
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
