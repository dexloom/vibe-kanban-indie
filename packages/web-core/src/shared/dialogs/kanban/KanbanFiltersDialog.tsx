import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SortAscendingIcon,
  SortDescendingIcon,
  TagIcon,
} from '@phosphor-icons/react';
import type { IssuePriority, Tag } from 'shared/remote-types';
import { cn } from '@/shared/lib/utils';
import type {
  KanbanFilterState,
  KanbanSortField,
} from '@/shared/stores/useUiPreferencesStore';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { Switch } from '@vibe/ui/components/Switch';
import { PriorityFilterDropdown } from '@vibe/ui/components/PriorityFilterDropdown';
import {
  MultiSelectDropdown,
  type MultiSelectDropdownOption,
} from '@vibe/ui/components/MultiSelectDropdown';
import {
  PropertyDropdown,
  type PropertyDropdownOption,
} from '@vibe/ui/components/PropertyDropdown';

const SORT_OPTIONS: PropertyDropdownOption<KanbanSortField>[] = [
  { value: 'sort_order', label: 'Manual' },
  { value: 'priority', label: 'Priority' },
  { value: 'created_at', label: 'Created' },
  { value: 'updated_at', label: 'Updated' },
  { value: 'title', label: 'Title' },
];

interface KanbanFiltersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  tags: Tag[];
  filters: KanbanFilterState;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  onPrioritiesChange: (priorities: IssuePriority[]) => void;
  onTagsChange: (tagIds: string[]) => void;
  onSortChange: (
    sortField: KanbanSortField,
    sortDirection: 'asc' | 'desc'
  ) => void;
  onShowSubIssuesChange: (show: boolean) => void;
  onShowWorkspacesChange: (show: boolean) => void;
  hideBlocked: boolean;
  onHideBlockedChange: (hide: boolean) => void;
}

export function KanbanFiltersDialog({
  open,
  onOpenChange,
  tags,
  filters,
  showSubIssues,
  showWorkspaces,
  onPrioritiesChange,
  onTagsChange,
  onSortChange,
  onShowSubIssuesChange,
  onShowWorkspacesChange,
  hideBlocked,
  onHideBlockedChange,
}: KanbanFiltersDialogProps) {
  const { t } = useTranslation('common');

  const tagOptions: MultiSelectDropdownOption<string>[] = useCallback(
    () =>
      tags.map((tag) => ({
        value: tag.id,
        label: tag.name,
        renderOption: () => (
          <div className="flex items-center gap-base">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: tag.color }}
            />
            {tag.name}
          </div>
        ),
      })),
    [tags]
  )();

  const toggleSortDirection = useCallback(() => {
    onSortChange(
      filters.sortField,
      filters.sortDirection === 'asc' ? 'desc' : 'asc'
    );
  }, [filters.sortDirection, filters.sortField, onSortChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px] p-0">
        <div className="border-b border-border px-double pb-base pt-double">
          <DialogHeader className="space-y-half">
            <DialogTitle>{t('kanban.filters', 'Filters')}</DialogTitle>
            <DialogDescription>
              {t(
                'kanban.filtersDescription',
                'Adjust filters and sorting for this board view.'
              )}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[72vh] overflow-y-auto px-double py-double">
          <div className="flex flex-wrap items-center gap-base">
            <PriorityFilterDropdown
              values={filters.priorities}
              onChange={onPrioritiesChange}
            />

            {tags.length > 0 && (
              <MultiSelectDropdown
                values={filters.tagIds}
                options={tagOptions}
                onChange={onTagsChange}
                icon={TagIcon}
                label={t('kanban.tags', 'Tags')}
                menuLabel={t('kanban.filterByTag', 'Filter by tag')}
              />
            )}

            <PropertyDropdown
              value={filters.sortField}
              options={SORT_OPTIONS}
              onChange={(field) => onSortChange(field, filters.sortDirection)}
              icon={
                filters.sortDirection === 'asc'
                  ? SortAscendingIcon
                  : SortDescendingIcon
              }
              label={t('kanban.sortBy', 'Sort')}
            />

            <button
              type="button"
              onClick={toggleSortDirection}
              className={cn(
                'flex items-center justify-center rounded-sm p-half',
                'text-normal transition-colors hover:bg-secondary'
              )}
              title={
                filters.sortDirection === 'asc'
                  ? t('kanban.sortAscending', 'Ascending')
                  : t('kanban.sortDescending', 'Descending')
              }
            >
              {filters.sortDirection === 'asc' ? (
                <SortAscendingIcon className="size-icon-base" />
              ) : (
                <SortDescendingIcon className="size-icon-base" />
              )}
            </button>

            <div className="flex items-center gap-half rounded-sm bg-panel px-base py-half">
              <span className="whitespace-nowrap text-sm text-normal">
                {t('kanban.subIssuesFilterLabel', 'Sub-issues')}
              </span>
              <Switch
                checked={showSubIssues}
                onCheckedChange={onShowSubIssuesChange}
              />
            </div>

            <div className="flex items-center gap-half rounded-sm bg-panel px-base py-half">
              <span className="whitespace-nowrap text-sm text-normal">
                {t('kanban.workspacesFilterLabel', 'Workspaces')}
              </span>
              <Switch
                checked={showWorkspaces}
                onCheckedChange={onShowWorkspacesChange}
              />
            </div>

            <div className="flex items-center gap-half rounded-sm bg-panel px-base py-half">
              <span className="whitespace-nowrap text-sm text-normal">
                {t('kanban.hideBlockedFilterLabel', 'Hide blocked')}
              </span>
              <Switch
                checked={hideBlocked}
                onCheckedChange={onHideBlockedChange}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
