import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_DIRECTIVES,
  ORCHESTRATOR_LOOP_INTERVAL,
  composeOrchestratorPrompt,
} from './orchestratorOptions';

// The byte-exact directives-block header — a contract with agents/sweeper.md. The
// base brief mentions the block by name in its instructions, so tests key off this
// distinguishing phrase (present only when the block itself is appended).
const DIRECTIVES_BLOCK_HEADER =
  "apply each one's behavior as defined in your agent instructions";

describe('orchestrator directives', () => {
  it('registers nudge-stuck as an opt-in directive', () => {
    const d = ORCHESTRATOR_DIRECTIVES.find((x) => x.id === 'nudge-stuck');
    expect(d).toBeDefined();
    expect(d?.defaultEnabled).toBe(false);
  });

  it('emits the nudge-stuck flag when enabled', () => {
    const prompt = composeOrchestratorPrompt(new Set(['nudge-stuck']));
    expect(prompt).toContain('- nudge-stuck');
    expect(prompt).toContain(DIRECTIVES_BLOCK_HEADER);
  });

  it('emits no directives block when none are enabled', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    expect(prompt).not.toContain(DIRECTIVES_BLOCK_HEADER);
    expect(prompt).not.toContain('- nudge-stuck');
  });
});

describe('composeOrchestratorPrompt — self-contained default-agent brief', () => {
  it('arms the /loop timer at the configured interval', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    expect(prompt.startsWith(`/loop ${ORCHESTRATOR_LOOP_INTERVAL} `)).toBe(
      true
    );
  });

  it('spawns the sibling agents by fully-qualified plugin name', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    // The default agent registers plugin agents under their qualified names, so
    // the brief must spawn them qualified — a bare `sweeper` would not resolve.
    expect(prompt).toContain('vibe-kanban-indie:sweeper');
    expect(prompt).toContain('vibe-kanban-indie:intake');
    expect(prompt).toContain('vibe-kanban-indie:decider');
  });

  it('does NOT depend on the plugin agent definition or plugin root', () => {
    const prompt = composeOrchestratorPrompt(new Set(['telegram-fanout']));
    // The session runs as the DEFAULT agent: neither $CLAUDE_PLUGIN_ROOT nor a
    // `--agent vibe-kanban-indie:orchestrator` selection is available to it.
    expect(prompt).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(prompt).not.toContain('orchestrator.prompt.md');
    expect(prompt).not.toContain('--agent');
  });

  it('carries the tick behavior inline (spawn → relay → re-arm on CADENCE)', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    expect(prompt).toContain('CADENCE:');
    expect(prompt).toContain('RELAY');
    expect(prompt).toContain('SPAWN ONE SWEEPER');
  });
});
