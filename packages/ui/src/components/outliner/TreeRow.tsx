import { CaretRightIcon } from '@phosphor-icons/react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeApi } from 'react-arborist';
import { cn } from '../../lib/cn';

interface TreeRowProps {
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
   * to inject the custom drag-system `onMouseDown`, and by StatusNodeRow
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
 * Universal tree row shell. Owns ALL geometry (tree indent, caret/spacer,
 * content slot) so per-type renderers only supply label content. TreeRow is
 * blind to node type. Childless rows get a bullet in the caret column;
 * expandable rows get a caret button.
 *
 * The cross-surface DnD feature reuses this shell by passing `outerProps`
 * (the unified drag system's `onMouseDown` and drop-target attrs) and
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

  return (
    <div
      style={outerStyle ? { ...style, ...outerStyle } : style}
      ref={ref}
      aria-current={isActive ? 'page' : undefined}
      onClick={onRowClick}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-1 overflow-hidden pr-1.5 text-left',
        'focus:outline-none',
        rowClassName
      )}
      {...passthroughProps}
    >
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
