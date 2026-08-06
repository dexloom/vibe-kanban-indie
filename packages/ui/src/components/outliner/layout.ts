export const TREE_LAYOUT = {
  indent: 12,
  /** Phosphor `size-2.5` caret = 10px wide → half for caret-center geometry. */
  caretHalf: 5,
  rowHeight: { leaf: 40, project: 32, card: 28, default: 24 } as const,
  overscanCount: 5,
  padding: 2,
} as const;

/** Shared row class constants — every renderer must thread dim/hover/transition
 *  so a future renderer can't accidentally omit them. Import from here (not
 *  treeNodes.tsx) to avoid circular dependency with per-type renderers. */
export const DIM_ROW = 'opacity-60' as const;
export const HOVER_ROW = 'hover:bg-tertiary/60' as const;
export const TINT_ROW = 'transition-opacity' as const;

/** ADR-016: color-coded project tint — returns `{ color: 'hsl(H S% L% / 0.8)' }`
 *  when a tint color exists, otherwise `undefined`. All renderers use this so
 *  the 0.8 factor stays consistent across the tree. */
export function tintStyle(
  color: string | null | undefined,
  alpha = 0.8
): { color: string } | undefined {
  if (!color) return undefined;
  return { color: `hsl(${color} / ${alpha})` };
}
