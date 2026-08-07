import type { NodeApi } from 'react-arborist';
import { TREE_LAYOUT } from './layout';
import type { SidebarTreeNode } from './types';

/**
 * Pure tree-geometry helpers for the sidebar outliner — kept free of React
 * so the hierarchy logic is unit-testable (a react-arborist upgrade that
 * changes `node.level` / `nextSibling` semantics breaks tests, not just
 * pixels).
 */

export type GuideLine = {
  left: number;
  drawVertical: boolean;
  isParent: boolean;
  /** True when the parent is this row's parent AND this row is its last
   *  child — renders the L (└, vertical top→middle) instead of ├/┬. */
  isLastChild?: boolean;
};

/**
 * Compute VSCode-style hierarchy guides for a row. `level` (0-based) is the
 * node's depth in the tree; for each ancestor depth `d` in 0..level-1 we may
 * draw a vertical line at that ancestor's caret-column center.
 *
 * VSCode rules per ancestor:
 * - the column of ancestor `d` runs from that ancestor down to its LAST
 *   DIRECT child. On rows deeper than the last direct child the column is
 *   NOT drawn (the project column stops at the last sub-board, it does not
 *   continue inside that sub-board's own children).
 * - on this row's own parent (d === level-1): always draw a horizontal tick
 *   into the caret column. If the parent is a last child we draw an L
 *   (vertical top → middle, └); otherwise the line runs full height (├/┬).
 * - on higher ancestors: full-height vertical only when this row is NOT
 *   deeper than the ancestor's last direct child.
 */
export function guideLines(node: NodeApi<SidebarTreeNode>): GuideLine[] {
  const level = node.level;
  if (level <= 0) return [];
  const lines: GuideLine[] = [];
  for (let d = 0; d < level; d++) {
    const isParent = d === level - 1;
    // The ancestor at depth d, and its DIRECT child that contains this row
    // (depth d+1). Walk up from this row.
    let child: NodeApi<SidebarTreeNode> | null = node;
    for (let up = 0; up < level - d - 1; up++) {
      child = child?.parent ?? null;
    }
    const ancestorLastDirectChildIsThis =
      child !== null && child.nextSibling === null;
    // Column of ancestor d stops below its last direct child. On this row
    // we draw it only when we're not past that point. The parent column
    // (d === level-1) is always drawn on this row (child === node).
    const drawVertical = isParent || !ancestorLastDirectChildIsThis;
    lines.push({
      left: d * TREE_LAYOUT.indent + TREE_LAYOUT.caretHalf,
      drawVertical,
      isParent,
      isLastChild: isParent && ancestorLastDirectChildIsThis,
    });
  }
  return lines;
}

export interface ProjectTint {
  color: string;
  inActiveSubtree: boolean;
}

/**
 * ADR-016 usability: every project in the sidebar tree is color-coded —
 * each node paints with its nearest ancestor project's OWN color. When a
 * project is selected, everything inside its subtree keeps its color at
 * 0.8 intensity; every OTHER project's subtree is dimmed (colors retained,
 * opacity lowered) so the working scope stands out. Walk up from any node
 * to the nearest ancestor project; return that project's color plus whether
 * the node sits inside the active project's subtree.
 */
export function nearestProjectTint(
  node: NodeApi<SidebarTreeNode>,
  activeProjectId: string | null
): ProjectTint | null {
  let current: NodeApi<SidebarTreeNode> | null = node;
  let color: string | null = null;
  while (current) {
    if (current.data.type === 'project') {
      if (color === null) color = current.data.color;
      if (current.data.id === activeProjectId) {
        return { color, inActiveSubtree: true };
      }
    }
    current = current.parent;
  }
  if (color === null) return null;
  return { color, inActiveSubtree: false };
}
