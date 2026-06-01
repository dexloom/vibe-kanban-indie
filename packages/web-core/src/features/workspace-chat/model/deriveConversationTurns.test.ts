import { describe, it, expect } from 'vitest';
import type { NormalizedEntryType } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import { isHeadedTurnIdle } from './deriveConversationTurns';

// Minimal NORMALIZED_ENTRY patch carrying only the fields isHeadedTurnIdle reads.
function entry(type: NormalizedEntryType['type']): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type } as NormalizedEntryType,
      content: '',
      timestamp: null,
    },
    patchKey: `k:${type}`,
    executionProcessId: 'p',
  } as PatchTypeWithKey;
}

describe('isHeadedTurnIdle', () => {
  it('is idle when the latest entry is the turn_complete marker', () => {
    expect(
      isHeadedTurnIdle([entry('assistant_message'), entry('turn_complete')])
    ).toBe(true);
  });

  it('ignores trailing token_usage_info after the marker', () => {
    expect(
      isHeadedTurnIdle([
        entry('assistant_message'),
        entry('turn_complete'),
        entry('token_usage_info'),
      ])
    ).toBe(true);
  });

  it('is not idle once a new turn starts after the marker', () => {
    expect(
      isHeadedTurnIdle([entry('turn_complete'), entry('user_message')])
    ).toBe(false);
    expect(
      isHeadedTurnIdle([entry('turn_complete'), entry('assistant_message')])
    ).toBe(false);
  });

  it('is not idle when there is no marker (headless / mid-turn)', () => {
    expect(isHeadedTurnIdle([entry('assistant_message')])).toBe(false);
    expect(isHeadedTurnIdle([])).toBe(false);
  });
});
