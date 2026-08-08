import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { DIM_ROW, HOVER_ROW, TINT_ROW, tintStyle } from './layout';
import { TreeRow } from './TreeRow';
import { useDraggable } from '../dnd';
import type { CardNode, TreeNodeRenderProps } from './types';

interface CardNodeRowProps extends TreeNodeRenderProps<CardNode> {
  activeIssueId?: string | null;
  /** Disables drag while the kanban's bulk-select mode is on.
   * Defaults to `false` so the prop is optional in tests / non-DnD contexts. */
  isMultiSelectActive?: boolean;
  /** Opens the task page when the ↗ icon on a parent card is clicked. */
  onSelectIssue?: (projectId: string, issueId: string) => void;
  tintColor?: string | null;
  dimmed?: boolean;
}

/**
 * Compact issue title row. Parent cards (with sub-issues) expose an isolated
 * caret AND a ↗ icon: row activation toggles the sub-issues (see
 * SidebarProjectTree.handleActivate), the ↗ icon opens the task page. Leaf
 * cards open the task page on row activation.
 *
 * Drag is handled by the unified custom drag system (see
 * `components/dnd/DragController`). The controller owns the window-level
 * pointer sensor and ghost; this hook only binds `onPointerDown` to the row's
 * current element so the controller can clone the actual DOM node for the
 * ghost.
 *
 * The row's click-to-navigate still flows through react-arborist's outer
 * DefaultRow → `node.handleClick` → `onActivate`; the controller installs a
 * one-shot capture-phase click swallower on promote so the synthetic click
 * fired after a real drag doesn't navigate.
 */
export function CardNodeRow({
  node,
  style,
  activeIssueId,
  isMultiSelectActive = false,
  onSelectIssue,
  tintColor,
  dimmed,
}: CardNodeRowProps) {
  const { t } = useTranslation('common');
  const issue = node.data.issue;
  const isActive = issue.id === activeIssueId;
  const hasChildren = node.data.children.length > 0;

  const { onPointerDown } = useDraggable(
    {
      kind: 'issue-move',
      issueId: issue.id,
      projectId: issue.projectId,
      statusId: issue.statusId,
    },
    { disabled: isMultiSelectActive }
  );

  return (
    <TreeRow
      node={node}
      style={style}
      isActive={isActive}
      showCaret={hasChildren}
      rowClassName={cn(
        `text-sm leading-tight ${TINT_ROW}`,
        isActive
          ? `text-high font-semibold ${HOVER_ROW}`
          : `text-normal font-light ${HOVER_ROW} hover:text-high`,
        dimmed && DIM_ROW
      )}
      outerProps={{
        style: { touchAction: 'none' },
        ...(onPointerDown ? { onPointerDown } : {}),
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="flex-1 min-w-0 truncate" style={tintStyle(tintColor)}>
          {issue.title}
        </span>
        {hasChildren && onSelectIssue && (
          <button
            aria-label={t('sidebar.openIssuePage', 'Open task')}
            onClick={(e) => {
              e.stopPropagation();
              onSelectIssue(issue.projectId, issue.id);
            }}
            onPointerDown={(e) => {
              // Keep the icon's pointer-down independent of the row's
              // issue-move drag binding so the click navigates instead of
              // starting a drag.
              e.stopPropagation();
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5',
              'text-low hover:text-high hover:bg-tertiary',
              'transition-opacity focus:outline-none'
            )}
          >
            <ArrowSquareOutIcon className="size-3.5" weight="bold" />
          </button>
        )}
      </div>
    </TreeRow>
  );
}
