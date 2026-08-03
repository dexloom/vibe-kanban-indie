import { cn } from '../../lib/cn';
import { TREE_LAYOUT } from './layout';
import {
  formatRelativeElapsed,
  type LeafNode,
  type TreeNodeRenderProps,
} from './types';

/**
 * Gmail-style workspace leaf: name + relative-elapsed on the first line,
 * file/diff stats on a second small line so long names don't crowd the
 * right edge of a narrow sidebar. Framed by dotted guide lines so the
 * bucket outline is legible. Visuals (bold active, dotted guides, color
 * tokens) are intentionally identical to the ADR-006 WorkspaceOutliner leaf.
 */
export function OutlinerLeafNode({
  node,
  style,
  dragHandle,
  activeWorkspaceId,
}: TreeNodeRenderProps<LeafNode> & { activeWorkspaceId?: string | null }) {
  const ws = node.data.workspace;
  const isActive = ws.id === activeWorkspaceId;
  const elapsed = formatRelativeElapsed(ws.latestProcessCompletedAt);
  const hasStats =
    ws.filesChanged != null ||
    (ws.linesAdded != null && ws.linesAdded > 0) ||
    (ws.linesRemoved != null && ws.linesRemoved > 0);

  // Geometry for the dotted guide: it must grow from the parent bucket's
  // caret, not the leaf's own left edge. arborist gives every node
  // `style.paddingLeft = indent * level`, and the parent caret sits at
  // `(level-1)*indent + caretW/2` from the row left. Since the leaf div's
  // left edge IS row x=0, the guide x equals that caret center.
  const indent = node.tree.indent;
  const caretHalf = TREE_LAYOUT.caretHalf; // Phosphor `size-2.5` caret = 10px wide
  const paddingLeft = (style.paddingLeft as number | undefined) ?? 0;
  const guideX = paddingLeft - indent + caretHalf;
  const tickWidth = Math.max(0, indent - caretHalf);

  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-selected={isActive}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => node.activate()}
      className={cn(
        'relative flex w-full cursor-pointer flex-col justify-center gap-0 overflow-hidden pr-1.5 text-left',
        'text-sm leading-tight focus:outline-none',
        isActive
          ? 'text-high font-semibold'
          : 'text-normal font-light hover:text-high',
      )}
    >
      {/* Tree guide: vertical dotted line down the bucket + horizontal dotted
          tick connecting the guide to this leaf. Pure visual orientation. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0 h-full w-px border-l-2 border-dotted border-border-strong/80"
        style={{ left: guideX }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-px border-t-2 border-dotted border-border-strong/80"
        style={{ left: guideX, width: tickWidth }}
      />
      {/* Inner wrapper owns the +10px content offset (owner request). arborist's
          style is passed through untouched on the outer div; the offset lives
          here as Tailwind pl so it composes cleanly with the dotted guides. */}
      <div
        className="flex min-w-0 flex-col justify-center gap-0"
        style={{ paddingLeft: TREE_LAYOUT.leafContentOffset }}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{ws.name}</span>
          {elapsed && (
            <span className="shrink-0 text-xs text-low">{elapsed}</span>
          )}
        </span>
        {hasStats && (
          <span className="flex items-center gap-1.5 text-2xs text-muted">
            {ws.filesChanged != null && <span>{ws.filesChanged}</span>}
            {ws.linesAdded != null && ws.linesAdded > 0 && (
              <span className="text-success">+{ws.linesAdded}</span>
            )}
            {ws.linesRemoved != null && ws.linesRemoved > 0 && (
              <span className="text-error">−{ws.linesRemoved}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
