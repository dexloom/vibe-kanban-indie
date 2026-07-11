import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_DIRECTIVES,
  composeOrchestratorPrompt,
} from './orchestratorOptions';

describe('orchestrator directives', () => {
  it('registers nudge-stuck as an opt-in directive', () => {
    const d = ORCHESTRATOR_DIRECTIVES.find((x) => x.id === 'nudge-stuck');
    expect(d).toBeDefined();
    expect(d?.defaultEnabled).toBe(false);
  });

  it('emits the nudge-stuck flag when enabled', () => {
    const prompt = composeOrchestratorPrompt(new Set(['nudge-stuck']));
    expect(prompt).toContain('- nudge-stuck');
    expect(prompt).toContain('Directives enabled for this run');
  });

  it('emits no directives block when none are enabled', () => {
    const prompt = composeOrchestratorPrompt(new Set());
    expect(prompt).not.toContain('Directives enabled for this run');
    expect(prompt).not.toContain('- nudge-stuck');
  });
});
