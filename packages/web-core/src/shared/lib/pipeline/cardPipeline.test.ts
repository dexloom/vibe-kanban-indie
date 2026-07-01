import { describe, expect, it } from 'vitest';
import type { Pipeline } from 'shared/types';
import {
  PIPELINE_END,
  PIPELINE_START,
  appendPipelineToDescription,
  composePipelineBlock,
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
    },
    {
      id: 'plan',
      label: 'Create plan',
      prompt_fragment: 'Write a plan.',
      default_enabled: true,
    },
    {
      id: 'code-review',
      label: 'Review code',
      prompt_fragment: 'Review the code.',
      default_enabled: false,
    },
  ],
};

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
});
