import { ArrowSquareOutIcon, SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { DIM_ROW, HOVER_ROW, TINT_ROW, tintStyle } from './layout';
import { TreeRow } from './TreeRow';
import type {
  TasksSectionNode as TasksSectionNodeData,
  TreeNodeRenderProps,
} from './types';

/** Tasks section header with the open-task count (cards under non-done
 * statuses) and first-load feedback. Row click toggles expand/collapse;
 * the open-page icon navigates to the project's kanban board. */
export function TasksSectionNode({
  node,
  style,
  dragHandle,
  onOpenProjectPage,
  tintColor,
  dimmed,
}: TreeNodeRenderProps<TasksSectionNodeData> & {
  onOpenProjectPage?: (projectId: string) => void;
  tintColor?: string | null;
  dimmed?: boolean;
}) {
  const { t } = useTranslation('common');
  const section = node.data;

  return (
    <TreeRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      showCaret={section.children.length > 0 || section.isLoading}
      rowClassName={cn(
        `text-sm font-medium text-low ${TINT_ROW} ${HOVER_ROW}`,
        dimmed && DIM_ROW
      )}
    >
      <div className="flex items-center gap-1">
        <span className="flex-1 min-w-0 truncate" style={tintStyle(tintColor)}>
          {section.label}
        </span>
        {section.isLoading ? (
          <SpinnerIcon
            aria-label={t('sidebar.tasksLoading')}
            className="shrink-0 size-3 animate-spin text-low"
          />
        ) : (
          <span className="shrink-0 text-2xs font-normal text-low opacity-70">
            {section.openTaskCount}
          </span>
        )}
        {onOpenProjectPage && (
          <button
            aria-label={t('sidebar.openProjectPage', 'Open project board')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenProjectPage(section.projectId);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            className={cn(
              'shrink-0 rounded-sm p-0.5',
              'text-low hover:text-high hover:bg-tertiary',
              'transition-opacity focus:outline-none'
            )}
          >
            <ArrowSquareOutIcon className="size-4" weight="bold" />
          </button>
        )}
      </div>
    </TreeRow>
  );
}
