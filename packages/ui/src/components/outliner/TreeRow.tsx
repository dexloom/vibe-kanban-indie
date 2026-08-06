import { CaretRightIcon } from '@phosphor-icons/react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeApi } from 'react-arborist';
import { cn } from '../../lib/cn';
import { TREE_LAYOUT } from './layout';

interface TreeRowProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: NodeApi<any>;
  style: CSSProperties;
  dragHandle?: Ref<HTMLDivElement>;
  isActive?: boolean;
  /** Row click handler. Navigation/activation is handled by react-arborist's
   *  outer row (DefaultRow → node.handleClick → onActivate); this prop is for
   *  expand/collapse only. Omit for rows that navigate (cards, leaves). */
  onRowClick?: () => void;
  /** Override caret visibility. Default: shown when !node.isLeaf. Cards pass children>0. */
  showCaret?: boolean;
  rowClassName?: string;
  /** Extra attributes spread onto the outer row div. Used by CardNodeRow
   * to inject the custom drag-system `onPointerDown`, and by StatusNodeRow
   * to inject the drop-target data attributes. We type as
   * `Record<string, unknown>` so callers can pass `data-*` attributes
   * (which `HTMLAttributes` doesn\'t enumerate).
   */
  outerProps?: Record<string, unknown>;
  /** When set, takes precedence over `dragHandle` and is set as the outer
   * div's `ref`. Lets CardNodeRow merge react-arborist's `dragHandle` with
   * the controller's captured element into a single callback ref. */
  outerRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

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
type GuideLine = {
  left: number;
  drawVertical: boolean;
  isParent: boolean;
  /** True when the parent is this row's parent AND this row is its last
   *  child — renders the L (└, vertical top→middle) instead of ├/┬. */
  isLastChild?: boolean;
};

function guideLines(node: NodeApi<any>): GuideLine[] {
  const level = node.level;
  if (level <= 0) return [];
  const lines: GuideLine[] = [];
  for (let d = 0; d < level; d++) {
    const isParent = d === level - 1;
    // The ancestor at depth d, and its DIRECT child that contains this row
    // (depth d+1). Walk up from this row.
    let child: NodeApi<any> | null = node;
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

/**
 * Universal tree row shell. Owns ALL geometry (tree indent, caret/spacer,
 * content slot) so per-type renderers only supply label content. TreeRow is
 * blind to node type. Childless rows get a bullet in the caret column;
 * expandable rows get a caret button.
 *
 * The cross-surface DnD feature reuses this shell by passing `outerProps`
 * (the unified drag system's `onPointerDown` and drop-target attrs) and
 * `outerRef` (merged with `dragHandle`) — see CardNodeRow / StatusNodeRow.
 */
export function TreeRow({
  node,
  style,
  dragHandle,
  isActive = false,
  onRowClick,
  showCaret,
  rowClassName,
  outerProps,
  outerRef,
  children,
}: TreeRowProps) {
  const { t } = useTranslation('common');
  const hasCaret = showCaret ?? !node.isLeaf;
  // Merge any `outerProps.style` (e.g. a future drag-system transform that
  // moves the row under the cursor while dragging) over react-arborist's
  // positional style. `style` on the outer div is arborist's;
  // outerProps.style is the override. Both are required.
  const outerStyle = outerProps?.style as CSSProperties | undefined;
  const passthroughProps = { ...(outerProps ?? {}) } as Record<string, unknown>;
  delete passthroughProps.style;
  const ref = outerRef ?? dragHandle;
  const level = node.level;
  const lines = guideLines(node);

  return (
    <div
      style={outerStyle ? { ...style, ...outerStyle } : style}
      ref={ref}
      aria-current={isActive ? 'page' : undefined}
      onClick={onRowClick}
      className={cn(
        'relative flex h-full w-full cursor-pointer items-center gap-1 overflow-hidden pr-1.5 text-left',
        // The global `*:focus { ring-inset }` fires on react-arborist's
        // focused row (DefaultRow gets focus on click via tabIndex=-1).
        // Kill the ring on the row shell — the active project already has
        // a background fill, and an outline on an expandable row looks
        // broken against the tree's rounded rows.
        'focus:outline-none focus:ring-0',
        rowClassName
      )}
      {...passthroughProps}
    >
      {/* VSCode-style hierarchy guides as an SVG layer. SVG + non-scaling
          stroke render crisp 1px lines regardless of fractional x (the old
          `w-px` divs blurred into 2 device pixels on the 2nd level, looking
          lighter). The svg is positioned inside the row's padding-left area
          (react-arborist indents via padding), so x=0 is the caret column
          of the leftmost ancestor. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0"
        width={level * TREE_LAYOUT.indent + TREE_LAYOUT.caretHalf + 1}
        height="100%"
        viewBox={`0 0 ${
          level * TREE_LAYOUT.indent + TREE_LAYOUT.caretHalf + 1
        } 100`}
        preserveAspectRatio="none"
        style={{ color: 'currentColor' }}
      >
        {lines.map((line) => {
          if (line.isParent) {
            // Closest ancestor: vertical + horizontal tick into this row's
            // caret column. Last child gets an L (half-height vertical,
            // └); otherwise the line runs the full height (├/┬).
            const vY2 = line.isLastChild ? 50 : 100;
            return (
              <g key={line.left} opacity={0.35}>
                <line
                  x1={line.left}
                  y1={0}
                  x2={line.left}
                  y2={vY2}
                  stroke="currentColor"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={line.left}
                  y1={50}
                  x2={line.left + TREE_LAYOUT.indent - TREE_LAYOUT.caretHalf}
                  y2={50}
                  stroke="currentColor"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          }
          if (!line.drawVertical) return null; // column stopped at last direct child
          return (
            <line
              key={line.left}
              x1={line.left}
              y1={0}
              x2={line.left}
              y2={100}
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.35}
            />
          );
        })}
      </svg>
      {hasCaret ? (
        <button
          type="button"
          aria-label={node.isOpen ? t('sidebar.collapse') : t('sidebar.expand')}
          aria-expanded={node.isOpen}
          onClick={(event) => {
            event.stopPropagation();
            node.toggle();
          }}
          className="relative flex size-2.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-low after:absolute after:-inset-1.5 after:content-[''] hover:bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <CaretRightIcon
            className={cn(
              'size-2.5 transition-transform duration-150',
              node.isOpen && 'rotate-90'
            )}
            weight="bold"
          />
        </button>
      ) : (
        <span
          aria-hidden="true"
          className="flex size-2.5 shrink-0 items-center justify-center text-low"
        >
          <span className="size-1 rounded-full bg-current opacity-60" />
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
