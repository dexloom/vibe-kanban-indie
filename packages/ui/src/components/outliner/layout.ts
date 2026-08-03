export const TREE_LAYOUT = {
  indent: 12,
  /** Phosphor `size-2.5` caret = 10px wide → half for caret-center geometry. */
  caretHalf: 5,
  rowHeight: { leaf: 40, project: 32, card: 28, default: 24 } as const,
  overscanCount: 5,
  padding: 2,
} as const;
