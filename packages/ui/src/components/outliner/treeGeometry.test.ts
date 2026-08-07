import { describe, expect, it } from 'vitest';
import type { NodeApi } from 'react-arborist';
import { TREE_LAYOUT } from './layout';
import { guideLines, nearestProjectTint } from './treeGeometry';
import type { ProjectNode, SidebarTreeNode } from './types';

// --- test helpers --------------------------------------------------------
// Build a minimal NodeApi stand-in: just enough of the react-arborist
// surface (level, parent, nextSibling, data) for the pure geometry funcs.

type NodeLike = {
  id: string;
  level: number;
  parent: NodeLike | null;
  nextSibling: NodeLike | null;
  data: Partial<ProjectNode>;
};

function node(
  id: string,
  level: number,
  parent: NodeLike | null,
  nextSibling: NodeLike | null,
  color = '24 95% 53%'
): NodeLike {
  return {
    id,
    level,
    parent,
    nextSibling,
    data: { type: 'project' as const, id, color },
  };
}

function api(n: NodeLike): NodeApi<SidebarTreeNode> {
  return n as unknown as NodeApi<SidebarTreeNode>;
}

// ─────────────────────────── guideLines ─────────────────────────────────

describe('guideLines', () => {
  it('returns [] for a root row (level 0)', () => {
    const root = node('root', 0, null, null);
    expect(guideLines(api(root))).toEqual([]);
  });

  it('draws an L (└) for the last child of its parent', () => {
    // root → child (only child = last)
    const root = node('root', 0, null, null);
    const child = node('child', 1, root, null);
    const lines = guideLines(api(child));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      left: TREE_LAYOUT.caretHalf,
      drawVertical: true,
      isParent: true,
      isLastChild: true,
    });
  });

  it('draws a full ├/┬ for a non-last child of its parent', () => {
    // root → a, b (child "a" is not last)
    const root = node('root', 0, null, null);
    const b = node('b', 1, root, null);
    const a = node('a', 1, root, b);
    const lines = guideLines(api(a));
    expect(lines[0]).toMatchObject({
      drawVertical: true,
      isParent: true,
      isLastChild: false,
    });
  });

  it('does NOT draw the grandparent column past its last direct child', () => {
    // root → a (only child of root), a → deep (only child of a).
    // On "deep", the root column must be absent: root's last direct child
    // is "a", and we're deeper than it.
    const root = node('root', 0, null, null);
    const a = node('a', 1, root, null);
    const deep = node('deep', 2, a, null);
    const lines = guideLines(api(deep));
    // Level-1 ancestor (root): column stopped at "a" → drawVertical false.
    expect(lines[0]).toMatchObject({ drawVertical: false, isParent: false });
    // Parent column (a) still drawn as L.
    expect(lines[1]).toMatchObject({ isParent: true, isLastChild: true });
  });

  it('keeps the grandparent column when the parent is NOT its last direct child', () => {
    // root → a, b. a → deep. On "deep", root column continues (root has
    // another direct child "b" below).
    const root = node('root', 0, null, null);
    const b = node('b', 1, root, null);
    const a = node('a', 1, root, b);
    const deep = node('deep', 2, a, null);
    const lines = guideLines(api(deep));
    expect(lines[0]).toMatchObject({ drawVertical: true, isParent: false });
    expect(lines[1]).toMatchObject({ isParent: true, isLastChild: true });
  });

  it('positions each ancestor column at its caret-center', () => {
    // root → a → deep. left of root column = 0*indent + caretHalf,
    // left of a column = 1*indent + caretHalf.
    const root = node('root', 0, null, null);
    const a = node('a', 1, root, null);
    const deep = node('deep', 2, a, null);
    const lines = guideLines(api(deep));
    expect(lines.map((l) => l.left)).toEqual([
      TREE_LAYOUT.caretHalf,
      TREE_LAYOUT.indent + TREE_LAYOUT.caretHalf,
    ]);
  });
});

// ─────────────────────────── nearestProjectTint ─────────────────────────

describe('nearestProjectTint', () => {
  it('returns null when the node has no project ancestor', () => {
    // A hypothetical non-project node at the top (no parent, no project).
    const leaf: NodeLike = {
      id: 'x',
      level: 0,
      parent: null,
      nextSibling: null,
      data: { type: 'card' as never },
    };
    expect(nearestProjectTint(api(leaf), 'p1')).toBeNull();
  });

  it('marks inActiveSubtree true when walking through the active project', () => {
    const root = node('root', 0, null, null, '200 50% 40%');
    const sub = node('sub', 1, root, null, '120 50% 45%');
    const tint = nearestProjectTint(api(sub), 'root');
    expect(tint).toEqual({ color: '120 50% 45%', inActiveSubtree: true });
  });

  it('returns the nearest ancestor project color even when not active', () => {
    const root = node('root', 0, null, null, '200 50% 40%');
    const sub = node('sub', 1, root, null, '120 50% 45%');
    const tint = nearestProjectTint(api(sub), 'other-project');
    expect(tint).toEqual({ color: '120 50% 45%', inActiveSubtree: false });
  });

  it('handles activeProjectId === null (nothing selected)', () => {
    const root = node('root', 0, null, null);
    const sub = node('sub', 1, root, null);
    const tint = nearestProjectTint(api(sub), null);
    expect(tint).toEqual({ color: '24 95% 53%', inActiveSubtree: false });
  });

  it('uses the unassigned pseudo-project color when walking its subtree', () => {
    const unassigned = node('unassigned', 0, null, null, '0 0% 60%');
    // Non-project node under unassigned (e.g. a workspace leaf) — walk must
    // reach the unassigned project and use its grey.
    const leaf: NodeLike = {
      id: 'leaf',
      level: 1,
      parent: unassigned,
      nextSibling: null,
      data: { type: 'leaf' as never },
    };
    const tint = nearestProjectTint(api(leaf), null);
    expect(tint).toEqual({ color: '0 0% 60%', inActiveSubtree: false });
  });
});
