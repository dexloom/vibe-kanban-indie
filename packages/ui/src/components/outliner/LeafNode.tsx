import { cn } from '../../lib/cn';
import { WorkspaceActivityText } from '../WorkspaceActivityText';
import { TreeRow } from './TreeRow';
import { formatRelativeElapsed } from './format';
import type { LeafNode, TreeNodeRenderProps } from './types';

/**
 * Gmail-style workspace leaf: name + relative-elapsed on the first line,
 * file/diff stats on a second small line so long names don't crowd the
 * right edge of a narrow sidebar. Visuals (bold active, muted secondary
 * line, color tokens) are intentionally identical to the ADR-006
 * WorkspaceOutliner leaf.
 *
 * TreeRow owns geometry; we only supply the 2-line content. The taller
 * rowHeight (40px) lets TreeRow's items-center vertically center the
 * column.
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

  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      isActive={isActive}
      rowClassName={cn(
        'text-sm leading-tight',
        isActive
          ? 'text-high font-semibold'
          : 'text-normal font-light hover:text-high'
      )}
    >
      <div className="flex min-w-0 flex-col justify-center gap-0">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{ws.name}</span>
          {elapsed && (
            <span className="shrink-0 text-xs text-low">{elapsed}</span>
          )}
        </span>
        <WorkspaceActivityText
          filesChanged={ws.filesChanged}
          linesAdded={ws.linesAdded}
          linesRemoved={ws.linesRemoved}
        />
      </div>
    </TreeRow>
  );
}
