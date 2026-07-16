import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_DIRECTIVES,
  ORCHESTRATOR_LOOP_INTERVAL,
  composeOrchestratorPrompt,
} from './orchestratorOptions';

// The byte-exact directives-block header — a contract with agents/orchestrator.md.
// Tests key off this distinguishing phrase (present only when the block itself is
// appended).
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

describe('composeOrchestratorPrompt — single-loop per-tick pointer', () => {
  it('arms the /loop timer at the configured interval', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    expect(prompt.startsWith(`/loop ${ORCHESTRATOR_LOOP_INTERVAL} `)).toBe(
      true
    );
  });

  it('points at the plugin agent definition, not a loop-manager brief', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    // The session runs AS the plugin's orchestrator agent; the pointer defers to
    // its agent definition and names the two-mode tick it should run.
    expect(prompt).toContain('vibe-kanban-indie:orchestrator');
    expect(prompt).toContain('MONITOR');
    expect(prompt).toContain('SWEEP');
  });

  it('never references the retired sweeper agent', () => {
    const prompt = composeOrchestratorPrompt(new Set(['telegram-fanout']));
    // The plugin removed `sweeper`; a brief that spawns it fails on the first
    // tick with `Agent type 'sweeper' not found`.
    expect(prompt.toLowerCase()).not.toContain('sweeper');
  });

  it('does NOT embed launcher concerns the agent resolves itself', () => {
    const prompt = composeOrchestratorPrompt(new Set(['telegram-fanout']));
    // Plugin-root resolution and agent selection are the launcher's job
    // (`orchestrator_executor_config` passes `--agent`); the /loop body carries
    // neither.
    expect(prompt).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(prompt).not.toContain('orchestrator.prompt.md');
    expect(prompt).not.toContain('--agent');
  });
});
