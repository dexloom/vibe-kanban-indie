import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { DIM_ROW, HOVER_ROW, TINT_ROW, tintStyle } from './layout';
import { TreeRow } from './TreeRow';
import type {
  TasksSectionNode as TasksSectionNodeData,
  TreeNodeRenderProps,
} from './types';

/** Tasks section header with visible-status count and first-load feedback. */
export function TasksSectionNode({
  node,
  style,
  dragHandle,
  tintColor,
  dimmed,
}: TreeNodeRenderProps<TasksSectionNodeData> & {
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
        <span
          className="truncate"
          style={tintStyle(tintColor)}
        >
          {section.label}
        </span>
        {section.isLoading ? (
          <SpinnerIcon
            aria-label={t('sidebar.tasksLoading')}
            className="ml-auto size-3 shrink-0 animate-spin text-low"
          />
        ) : section.children.length === 0 ? (
          <span className="ml-auto text-2xs font-normal text-low opacity-70">
            {t('sidebar.tasksEmpty')}
          </span>
        ) : (
          <span className="ml-auto text-2xs font-normal text-low opacity-70">
            {section.children.length}
          </span>
        )}
      </div>
    </TreeRow>
  );
}
