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
 * - if this row is NOT the ancestor's last descendant: line runs the full
 *   row height (the ancestor has more descendants below).
 * - if this row IS the ancestor's last descendant:
 *   - the DIRECT parent (d === level-1) gets an "L": a half-height vertical
 *     (top → middle) plus the horizontal tick into the row's caret column.
 *   - higher ancestors get nothing here (their line already ended above).
 */
type GuideLine = { left: number; isLast: boolean; isParent: boolean };

function guideLines(node: NodeApi<any>): GuideLine[] {
  const level = node.level;
  if (level <= 0) return [];
  const lines: GuideLine[] = [];
  for (let d = 0; d < level; d++) {
    const isParent = d === level - 1;
    // Is this row the ancestor's last descendant? Every node on the path
    // from this row up to (but excluding) the ancestor must be a last
    // sibling (nextSibling === null).
    let isLast = true;
    let cursor: NodeApi<any> | null = node;
    for (let up = 0; up < level - d; up++) {
      if (cursor && cursor.nextSibling !== null) {
        isLast = false;
        break;
      }
      cursor = cursor?.parent ?? null;
    }
    lines.push({
      left: d * TREE_LAYOUT.indent + TREE_LAYOUT.caretHalf - 0.5,
      isLast,
      isParent,
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
  const lines = guideLines(node);

  return (
    <div
      style={outerStyle ? { ...style, ...outerStyle } : style}
      ref={ref}
      aria-current={isActive ? 'page' : undefined}
      onClick={onRowClick}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-1 overflow-hidden pr-1.5 text-left',
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
      {/* VSCode-style hierarchy guides. Vertical lines sit at each ancestor
          caret-column center; rows are flush (no gaps) so consecutive rows
          form continuous lines. Drawn inside the row's padding-left area. */}
      {lines.map((line) => {
        if (line.isParent) {
          // Closest ancestor: always draw the horizontal tick into this
          // row's caret column (└ for a last child, ├/┬ otherwise).
          const verticalClass =
            line.isLast
              ? 'pointer-events-none absolute bottom-1/2 top-0 w-px bg-current opacity-25'
              : 'pointer-events-none absolute inset-y-0 w-px bg-current opacity-25';
          return (
            <span key={line.left}>
              <span
                aria-hidden="true"
                className={verticalClass}
                style={{ left: line.left }}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bg-current opacity-25"
                style={{
                  left: line.left,
                  top: '50%',
                  height: 1,
                  width: TREE_LAYOUT.indent - TREE_LAYOUT.caretHalf + 0.5,
                }}
              />
            </span>
          );
        }
        if (line.isLast) return null; // ancestor's line ended above this row
        return (
          <span
            key={line.left}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-current opacity-25"
            style={{ left: line.left }}
          />
        );
      })}
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
