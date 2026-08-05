import { describe, expect, it } from 'vitest';
import { isColumnLikeTarget } from './targetKind';
import { SHARED_TARGET_ID_FIXTURE } from './targetKind.fixture';

describe('isColumnLikeTarget', () => {
  it('returns true for a bare UUID kanban column', () => {
    expect(isColumnLikeTarget('11111111-1111-4111-8111-111111111111')).toBe(
      true
    );
  });

  it('returns false for a tree-status target', () => {
    expect(isColumnLikeTarget('project-1:status:todo')).toBe(false);
  });

  it('returns false for a multi-colon tree-status id (anchored regex covers the trailing segment)', () => {
    expect(isColumnLikeTarget('project-1:status:x:y')).toBe(false);
  });

  it('returns true for a non-UUID bare word (controller only uses this as a "not tree-status" fast path)', () => {
    expect(isColumnLikeTarget('some-thing')).toBe(true);
  });
});

describe('target-grammar sync (ui mirror)', () => {
  // Mirror test for the web-core `isTreeStatusTarget` predicate. Lives in
  // both packages so a divergence in either implementation trips at least
  // one suite; the shared fixture is the canonical source of ids.
  function isTreeStatusTarget(id: string): boolean {
    return /^([^:]+):status:(.+)$/.test(id);
  }

  it('keeps isColumnLikeTarget and isTreeStatusTarget complementary on every fixture id', () => {
    for (const id of SHARED_TARGET_ID_FIXTURE) {
      expect(isColumnLikeTarget(id)).toBe(!isTreeStatusTarget(id));
    }
  });
});
