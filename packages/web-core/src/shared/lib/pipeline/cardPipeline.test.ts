import { describe, expect, it } from 'vitest';
import type { Pipeline } from 'shared/types';
import {
  PIPELINE_END,
  PIPELINE_START,
  appendPipelineToDescription,
  canonicalStageOrder,
  composePipelineBlock,
  extractPipelineBlock,
  orderedEnabledStages,
  parsePipelineStages,
} from './cardPipeline';

const pipeline: Pipeline = {
  id: 'basic',
  name: 'Basic',
  description: 'Classic dev flow.',
  stages: [
    {
      id: 'spec',
      label: 'Create spec',
      prompt_fragment: 'Write a spec.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'plan',
      label: 'Create plan',
      prompt_fragment: 'Write a plan.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'code-review',
      label: 'Review code',
      prompt_fragment: 'Review the code.',
      default_enabled: false,
      heavy: false,
    },
  ],
};

// Fixtures mirroring the real `basic` + `wikillm` pipeline files: same stage
// ids/order/default-enabled sets, including the non-default-enabled stages
// that interleave in the real files (to prove they don't perturb the
// canonical merge once the result is filtered to the enabled union).
const basicPipeline: Pipeline = {
  id: 'basic',
  name: 'Basic',
  description: 'Classic dev flow.',
  stages: [
    {
      id: 'orchestrate',
      label: 'Orchestrate (auto-drive)',
      prompt_fragment: 'Orchestrate.',
      default_enabled: false,
      heavy: false,
    },
    {
      id: 'spec',
      label: 'Create spec',
      prompt_fragment: 'Write a spec.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'plan',
      label: 'Create plan',
      prompt_fragment: 'Write a plan.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'plan-review',
      label: 'Review plan',
      prompt_fragment: 'Review the plan.',
      default_enabled: false,
      heavy: false,
    },
    {
      id: 'code-review',
      label: 'Review via Codex',
      prompt_fragment: 'Review the code.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'merge',
      label: 'Merge to base',
      prompt_fragment: 'Merge to base.',
      default_enabled: false,
      heavy: false,
    },
  ],
};

const wikillmPipeline: Pipeline = {
  id: 'wikillm',
  name: 'WikiLLM',
  description: 'Knowledge-augmented dev flow.',
  stages: [
    {
      id: 'orchestrate',
      label: 'Orchestrate (auto-drive)',
      prompt_fragment: 'Orchestrate.',
      default_enabled: false,
      heavy: false,
    },
    {
      id: 'spec',
      label: 'Create spec',
      prompt_fragment: 'Write a spec.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'recall-knowledge',
      label: 'Recall prior knowledge',
      prompt_fragment: 'Recall prior knowledge.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'plan',
      label: 'Create plan',
      prompt_fragment: 'Write a plan.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'code-review',
      label: 'Review via Codex',
      prompt_fragment: 'Review the code.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'enrich-knowledge',
      label: 'Enrich knowledge base',
      prompt_fragment: 'Enrich the knowledge base.',
      default_enabled: true,
      heavy: false,
    },
    {
      id: 'merge',
      label: 'Merge to base',
      prompt_fragment: 'Merge to base.',
      default_enabled: false,
      heavy: false,
    },
  ],
};

/** Union of the two fixtures' default-enabled stage ids. */
const basicWikillmEnabledUnion = [
  ...new Set([
    ...basicPipeline.stages.filter((s) => s.default_enabled).map((s) => s.id),
    ...wikillmPipeline.stages.filter((s) => s.default_enabled).map((s) => s.id),
  ]),
];

// Fixture mirroring the real `async-sonnet.toml` pipeline file (the split of
// the former `async.toml` into Async Sonnet / Async Fable): same stage
// ids/order/default-enabled flags, including the `plan-review-codex` stage
// between `plan` and `code-subagent`, and the canonical `code-review` id
// (the same one the `basicPipeline`/`wikillmPipeline` fixtures use, so it
// dedupes against theirs in a merge). There is no `review-fable` stage here —
// that stage was removed entirely when Async split into Sonnet/Fable
// variants (code review is Codex-only in both).
const asyncPipeline: Pipeline = {
  id: 'async-sonnet',
  name: 'Async Sonnet',
  description: 'Subagent fan-out flow.',
  stages: [
    {
      id: 'orchestrate',
      label: 'Orchestrate (auto-drive)',
      prompt_fragment: 'Orchestrate.',
      default_enabled: false,
    },
    {
      id: 'spec',
      label: 'Spec via Sonnet subagent',
      prompt_fragment: 'Write a spec.',
      default_enabled: true,
    },
    {
      id: 'plan',
      label: 'Plan via Sonnet subagent',
      prompt_fragment: 'Write a plan.',
      default_enabled: true,
    },
    {
      id: 'plan-review-codex',
      label: 'Codex plan review',
      prompt_fragment: 'Have Codex review the plan.',
      default_enabled: true,
    },
    {
      id: 'code-subagent',
      label: 'Code via Sonnet subagent',
      prompt_fragment: 'Code via a Sonnet subagent.',
      default_enabled: true,
    },
    {
      id: 'code-review',
      label: 'Review via Codex',
      prompt_fragment: 'Review the code.',
      default_enabled: true,
    },
    {
      id: 'merge',
      label: 'Merge to base',
      prompt_fragment: 'Merge to base.',
      default_enabled: false,
    },
    {
      id: 'pr',
      label: 'Open pull request',
      prompt_fragment: 'Open a pull request.',
      default_enabled: false,
    },
  ],
};

/** Union of `basicPipeline`'s and `asyncPipeline`'s default-enabled stage ids. */
const basicAsyncEnabledUnion = [
  ...new Set([
    ...basicPipeline.stages.filter((s) => s.default_enabled).map((s) => s.id),
    ...asyncPipeline.stages.filter((s) => s.default_enabled).map((s) => s.id),
  ]),
];

describe('composePipelineBlock', () => {
  it('renders enabled stages as an ordered numbered list in pipeline order', () => {
    const block = composePipelineBlock(pipeline, ['plan', 'spec'], '', null);
    expect(block).toContain('## Pipeline: Basic');
    expect(block).toContain(
      'Execute these stages in the order listed. Do not add, skip, or reorder stages.'
    );
    // Order follows the pipeline definition, not the enabledIds argument order.
    expect(block).toContain('1. Write a spec.');
    expect(block).toContain('2. Write a plan.');
    expect(block.startsWith(PIPELINE_START)).toBe(true);
    expect(block.endsWith(PIPELINE_END)).toBe(true);
  });

  it('instructs the agent to emit a VK-PIPELINE-STAGE marker per stage', () => {
    const block = composePipelineBlock(pipeline, ['plan', 'spec'], '', null);
    expect(block).toContain('VK-PIPELINE-STAGE: N');
    expect(block).toContain('As you begin each numbered stage');
  });

  it('does not instruct marker reporting when there are no stages', () => {
    const block = composePipelineBlock(null, [], '', 'CLAUDE_CODE');
    expect(block).not.toContain('VK-PIPELINE-STAGE');
  });

  it('leads with the executor-pin line before the stages', () => {
    const block = composePipelineBlock(pipeline, ['spec'], '', 'CODEX');
    const execIdx = block.indexOf('Run this card with the **CODEX**');
    const stageIdx = block.indexOf('1. Write a spec.');
    expect(execIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeGreaterThan(execIdx);
  });

  it('returns empty string when nothing is selected', () => {
    expect(composePipelineBlock(pipeline, [], '', null)).toBe('');
  });

  it('null pipeline with an executor emits an executor-only block', () => {
    const block = composePipelineBlock(null, [], '', 'CLAUDE_CODE');
    expect(block).toContain('## Pipeline');
    expect(block).toContain('Run this card with the **CLAUDE_CODE**');
    expect(block).not.toContain('1.');
  });

  it('null pipeline without executor or custom text is empty', () => {
    expect(composePipelineBlock(null, ['spec'], '', null)).toBe('');
  });

  it('appends and replaces idempotently in a description', () => {
    const block = composePipelineBlock(pipeline, ['spec'], '', null);
    const withBlock = appendPipelineToDescription('My card body.', block);
    expect(withBlock).toContain('My card body.');
    expect(withBlock).toContain('1. Write a spec.');
    // Re-appending a new block replaces, not stacks.
    const block2 = composePipelineBlock(pipeline, ['plan'], '', null);
    const replaced = appendPipelineToDescription(withBlock, block2);
    expect(replaced).toContain('1. Write a plan.');
    expect(replaced).not.toContain('Write a spec.');
    expect(replaced.match(/vk:pipeline:start/g)?.length).toBe(1);
  });

  it('also accepts a single pipeline wrapped in an array (back-compat)', () => {
    const single = composePipelineBlock(pipeline, ['spec'], '', null);
    const wrapped = composePipelineBlock([pipeline], ['spec'], '', null);
    expect(wrapped).toBe(single);
  });

  it('LOCKED: basic + wikillm default-enabled union yields the canonical merge order', () => {
    const block = composePipelineBlock(
      [basicPipeline, wikillmPipeline],
      basicWikillmEnabledUnion,
      '',
      null
    );
    expect(block).toContain('## Pipeline: Basic + WikiLLM');

    const stageLines = block
      .split('\n')
      .filter((l) => /^\d+\.\s/.test(l))
      .map((l) => l.replace(/^\d+\.\s+/, ''));

    expect(stageLines).toEqual([
      'Write a spec.',
      'Recall prior knowledge.',
      'Write a plan.',
      'Review the code.',
      'Enrich the knowledge base.',
    ]);
  });

  it('LOCKED: Async Sonnet default-enabled order places the Codex plan review between plan and the coder stage', () => {
    const asyncEnabledIds = asyncPipeline.stages
      .filter((s) => s.default_enabled)
      .map((s) => s.id);
    const block = composePipelineBlock(
      [asyncPipeline],
      asyncEnabledIds,
      '',
      null
    );
    expect(block).toContain('## Pipeline: Async Sonnet');

    const stageLines = block
      .split('\n')
      .filter((l) => /^\d+\.\s/.test(l))
      .map((l) => l.replace(/^\d+\.\s+/, ''));

    // spec -> plan -> plan-review-codex -> code-subagent -> code-review: the
    // Codex plan review sits immediately after `plan` and immediately before
    // the coder stage, and the Codex code review is the final
    // default-enabled stage, per spec. (There is no `review-fable` stage in
    // Async Sonnet — code review is Codex-only.)
    expect(stageLines).toEqual([
      'Write a spec.',
      'Write a plan.',
      'Have Codex review the plan.',
      'Code via a Sonnet subagent.',
      'Review the code.',
    ]);
  });

  it("dedupes Basic's and Async Sonnet's shared code-review stage: one Codex review, after the coder stage", () => {
    const block = composePipelineBlock(
      [basicPipeline, asyncPipeline],
      basicAsyncEnabledUnion,
      '',
      null
    );
    expect(block).toContain('## Pipeline: Basic + Async Sonnet');

    const stageLines = block
      .split('\n')
      .filter((l) => /^\d+\.\s/.test(l))
      .map((l) => l.replace(/^\d+\.\s+/, ''));

    // Unifying the id gives `code-review` an incoming edge from the async
    // pipeline's `plan-review-codex -> code-subagent -> code-review` chain,
    // so it sorts after `code-subagent`. The full merged order is LOCKED
    // here for visibility: the Codex code review appears exactly once, last.
    expect(stageLines).toEqual([
      'Write a spec.',
      'Write a plan.',
      'Have Codex review the plan.',
      'Code via a Sonnet subagent.',
      'Review the code.',
    ]);

    // basic's own (default-off) `plan-review` stage stays hidden by default,
    // per spec *Decisions* — only the Codex plan review renders.
    expect(block).not.toContain('Review the plan.');

    // Acceptance criterion 1: the deduped Codex review appears exactly once.
    expect(stageLines.filter((l) => l === 'Review the code.')).toHaveLength(1);

    // plan < plan-review-codex < code-subagent < code-review.
    const planIdx = stageLines.indexOf('Write a plan.');
    const planReviewCodexIdx = stageLines.indexOf(
      'Have Codex review the plan.'
    );
    const coderIdx = stageLines.indexOf('Code via a Sonnet subagent.');
    const codeReviewIdx = stageLines.indexOf('Review the code.');
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(planReviewCodexIdx).toBeGreaterThan(planIdx);
    expect(coderIdx).toBeGreaterThan(planReviewCodexIdx);
    expect(codeReviewIdx).toBeGreaterThan(coderIdx);
  });

  it('orderedEnabledStages produces the same order composePipelineBlock uses', () => {
    const stages = orderedEnabledStages(
      [basicPipeline, wikillmPipeline],
      basicWikillmEnabledUnion
    );
    expect(stages.map((s) => s.id)).toEqual([
      'spec',
      'recall-knowledge',
      'plan',
      'code-review',
      'enrich-knowledge',
    ]);
  });

  it('manual-line preservation: an extra operator line survives recompose', () => {
    const first = composePipelineBlock(pipeline, ['spec', 'plan'], '', null);
    const withManualLine = first.replace(
      '2. Write a plan.',
      '2. Write a plan.\nAlso double-check the migration script.'
    );

    const allFragments = new Set(pipeline.stages.map((s) => s.prompt_fragment));
    const recomposed = composePipelineBlock(
      pipeline,
      ['spec', 'plan', 'code-review'],
      '',
      null,
      { previousBlock: withManualLine, knownStageFragments: allFragments }
    );

    expect(recomposed).toContain('Also double-check the migration script.');
    expect(recomposed).toContain('1. Write a spec.');
    expect(recomposed).toContain('2. Write a plan.');
    expect(recomposed).toContain('3. Review the code.');
  });

  it('deselecting a stage removes its generated line instead of stranding it as manual', () => {
    const first = composePipelineBlock(
      pipeline,
      ['spec', 'plan', 'code-review'],
      '',
      null
    );
    const allFragments = new Set(pipeline.stages.map((s) => s.prompt_fragment));

    // Untick `plan`.
    const recomposed = composePipelineBlock(
      pipeline,
      ['spec', 'code-review'],
      '',
      null,
      { previousBlock: first, knownStageFragments: allFragments }
    );

    expect(recomposed).not.toContain('Write a plan.');
    expect(recomposed).toContain('Write a spec.');
    expect(recomposed).toContain('Review the code.');
  });

  it('deselecting an entire pipeline removes its stage lines instead of stranding them as manual', () => {
    const first = composePipelineBlock(
      [basicPipeline, wikillmPipeline],
      basicWikillmEnabledUnion,
      '',
      null
    );
    const allFragments = new Set(
      [basicPipeline, wikillmPipeline].flatMap((p) =>
        p.stages.map((s) => s.prompt_fragment)
      )
    );

    // Drop wikillm entirely; keep basic's default-enabled stages.
    const basicEnabled = basicPipeline.stages
      .filter((s) => s.default_enabled)
      .map((s) => s.id);
    const recomposed = composePipelineBlock(
      [basicPipeline],
      basicEnabled,
      '',
      null,
      { previousBlock: first, knownStageFragments: allFragments }
    );

    expect(recomposed).not.toContain('Enrich the knowledge base.');
    expect(recomposed).not.toContain('Recall prior knowledge.');
    expect(recomposed).toContain('Write a spec.');
    expect(recomposed).toContain('Write a plan.');
    expect(recomposed).toContain('Review the code.');
  });

  it('a hand-edited stage line no longer matches any fragment and is preserved as manual', () => {
    const first = composePipelineBlock(pipeline, ['spec', 'plan'], '', null);
    const edited = first.replace(
      '2. Write a plan.',
      '2. Write a plan, focusing on the migration risk.'
    );
    const allFragments = new Set(pipeline.stages.map((s) => s.prompt_fragment));

    const recomposed = composePipelineBlock(
      pipeline,
      ['spec', 'plan'],
      '',
      null,
      { previousBlock: edited, knownStageFragments: allFragments }
    );

    // The edited line no longer matches the `plan` fragment, so it's treated
    // as manual text and preserved verbatim, alongside the freshly generated
    // (unedited) stage lines.
    expect(recomposed).toContain(
      '2. Write a plan, focusing on the migration risk.'
    );
    expect(recomposed).toContain('1. Write a spec.');
    expect(recomposed).toContain('2. Write a plan.');
  });
});

describe('canonicalStageOrder', () => {
  it('returns a single pipeline in its own declared order', () => {
    const ordered = canonicalStageOrder([pipeline]);
    expect(ordered.map((s) => s.id)).toEqual(['spec', 'plan', 'code-review']);
  });

  it('dedupes a stage shared by two pipelines, keeping one copy', () => {
    const ordered = canonicalStageOrder([basicPipeline, wikillmPipeline]);
    const ids = ordered.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('spec');
    expect(ids.filter((id) => id === 'spec').length).toBe(1);
  });
});

describe('extractPipelineBlock', () => {
  it('extracts the delimited block from a description', () => {
    const block = composePipelineBlock(pipeline, ['spec'], '', null);
    const description = appendPipelineToDescription('Some prose.', block);
    expect(extractPipelineBlock(description)).toBe(block);
  });

  it('returns an empty string when there is no pipeline block', () => {
    expect(extractPipelineBlock('Just some prose.')).toBe('');
    expect(extractPipelineBlock(null)).toBe('');
    expect(extractPipelineBlock(undefined)).toBe('');
  });
});

describe('parsePipelineStages', () => {
  it('counts the numbered stages, ignoring the order instruction and executor-pin lines', () => {
    const block = composePipelineBlock(pipeline, ['spec', 'plan'], '', 'CODEX');
    const stages = parsePipelineStages(block);
    expect(stages).toEqual([
      { index: 1, label: 'Write a spec.' },
      { index: 2, label: 'Write a plan.' },
    ]);
  });

  it('does not count numbered custom text that follows a blank line after the stage list', () => {
    const block = composePipelineBlock(
      pipeline,
      ['spec'],
      '1. Not a real stage\n2. Also not a stage',
      null
    );
    expect(parsePipelineStages(block)).toEqual([
      { index: 1, label: 'Write a spec.' },
    ]);
  });

  it('returns [] when the description has no pipeline block', () => {
    expect(parsePipelineStages(null)).toEqual([]);
    expect(parsePipelineStages('Just some regular card prose.')).toEqual([]);
  });

  it('returns [] when the pipeline block has no numbered list', () => {
    const block = composePipelineBlock(null, [], '', 'CLAUDE_CODE');
    expect(parsePipelineStages(block)).toEqual([]);
  });

  it('tolerates a post-creation hand-edited block (still within the delimiters)', () => {
    const edited = [
      PIPELINE_START,
      '## Pipeline: Custom',
      '',
      '1. Do the first thing',
      '2. Do the second thing',
      '3. Do the third thing',
      PIPELINE_END,
    ].join('\n');
    expect(parsePipelineStages(edited)).toEqual([
      { index: 1, label: 'Do the first thing' },
      { index: 2, label: 'Do the second thing' },
      { index: 3, label: 'Do the third thing' },
    ]);
  });

  it('falls back to the ## Pipeline heading when delimiters are absent', () => {
    const noDelimiters = [
      'Some card prose up top.',
      '',
      '## Pipeline',
      '1. First stage',
      '2. Second stage',
    ].join('\n');
    expect(parsePipelineStages(noDelimiters)).toEqual([
      { index: 1, label: 'First stage' },
      { index: 2, label: 'Second stage' },
    ]);
  });
});
