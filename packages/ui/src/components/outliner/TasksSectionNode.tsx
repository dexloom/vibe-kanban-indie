import { SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { TreeCaretRow } from './TreeCaretRow';
import type {
  TasksSectionNode as TasksSectionNodeData,
  TreeNodeRenderProps,
} from './types';

/** Tasks section header with visible-status count and first-load feedback. */
export function TasksSectionNode({
  node,
  style,
  dragHandle,
}: TreeNodeRenderProps<TasksSectionNodeData>) {
  const { t } = useTranslation('common');
  const section = node.data;

  return (
    <TreeCaretRow
      node={node}
      style={style}
      dragHandle={dragHandle}
      className="text-sm font-medium text-low"
    >
      <span className="truncate">{section.label}</span>
      {section.isLoading ? (
        <SpinnerIcon
          aria-label={t('sidebar.tasksLoading')}
          className="ml-auto size-3 shrink-0 animate-spin text-low"
        />
      ) : (
        <span className="ml-auto text-2xs font-normal text-low opacity-70">
          {section.children.length}
        </span>
      )}
    </TreeCaretRow>
  );
}
