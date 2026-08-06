import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import type { PriorityLevel } from './PriorityIcon';
import { InputField } from './InputField';
import { PrimaryButton } from './PrimaryButton';
import { ButtonGroup, ButtonGroupItem } from './IconButtonGroup';

export interface KanbanFilterTag {
  id: string;
  name: string;
  color: string;
}

export interface KanbanFilterState<TSortField extends string = string> {
  searchQuery: string;
  priorities: PriorityLevel[];
  tagIds: string[];
  sortField: TSortField;
  sortDirection: 'asc' | 'desc';
}

export interface KanbanProjectViewIds {
  TEAM: string;
  PERSONAL: string;
}

const DEFAULT_KANBAN_PROJECT_VIEW_IDS: KanbanProjectViewIds = {
  TEAM: 'team',
  PERSONAL: 'personal',
};

export interface RenderKanbanFiltersDialogProps<
  TTag extends KanbanFilterTag = KanbanFilterTag,
  TSortField extends string = string,
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: TTag[];
  projectId: string;
  filters: KanbanFilterState<TSortField>;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  onPrioritiesChange: (priorities: PriorityLevel[]) => void;
  onTagsChange: (tagIds: string[]) => void;
  onSortChange: (sortField: TSortField, sortDirection: 'asc' | 'desc') => void;
  onShowSubIssuesChange: (show: boolean) => void;
  onShowWorkspacesChange: (show: boolean) => void;
  hideBlocked: boolean;
  onHideBlockedChange: (hide: boolean) => void;
}

interface KanbanFilterBarProps<
  TTag extends KanbanFilterTag = KanbanFilterTag,
  TSortField extends string = string,
> {
  isFiltersDialogOpen: boolean;
  onFiltersDialogOpenChange: (open: boolean) => void;
  tags: TTag[];
  activeViewId: string;
  onViewChange: (viewId: string) => void;
  viewIds?: KanbanProjectViewIds;
  projectId: string;
  filters: KanbanFilterState<TSortField>;
  showSubIssues: boolean;
  showWorkspaces: boolean;
  hasActiveFilters: boolean;
  onSearchQueryChange: (searchQuery: string) => void;
  onPrioritiesChange: (priorities: PriorityLevel[]) => void;
  onTagsChange: (tagIds: string[]) => void;
  onSortChange: (sortField: TSortField, sortDirection: 'asc' | 'desc') => void;
  onShowSubIssuesChange: (show: boolean) => void;
  onShowWorkspacesChange: (show: boolean) => void;
  hideBlocked: boolean;
  onHideBlockedChange: (hide: boolean) => void;
  onClearFilters: () => void;
  onCreateIssue: () => void;
  shouldAnimateCreateButton: boolean;
  isMobile?: boolean;
  renderFiltersDialog?: (
    props: RenderKanbanFiltersDialogProps<TTag, TSortField>
  ) => ReactNode;
}

export function KanbanFilterBar<
  TTag extends KanbanFilterTag = KanbanFilterTag,
  TSortField extends string = string,
>({
  isFiltersDialogOpen,
  onFiltersDialogOpenChange,
  tags,
  activeViewId,
  onViewChange,
  viewIds = DEFAULT_KANBAN_PROJECT_VIEW_IDS,
  projectId,
  filters,
  showSubIssues,
  showWorkspaces,
  hasActiveFilters,
  onSearchQueryChange,
  onPrioritiesChange,
  onTagsChange,
  onSortChange,
  onShowSubIssuesChange,
  onShowWorkspacesChange,
  hideBlocked,
  onHideBlockedChange,
  onClearFilters,
  onCreateIssue,
  shouldAnimateCreateButton,
  isMobile,
  renderFiltersDialog,
}: KanbanFilterBarProps<TTag, TSortField>) {
  const { t } = useTranslation('common');
  const [mobileSearchExpanded, setMobileSearchExpanded] = useState(false);

  const handleClearSearch = () => {
    onSearchQueryChange('');
  };

  return (
    <>
      {isMobile && mobileSearchExpanded ? (
        <div className="flex items-center gap-half">
          <button
            type="button"
            onClick={() => {
              onSearchQueryChange('');
              setMobileSearchExpanded(false);
            }}
            className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors shrink-0"
            aria-label={t('kanban.closeSearch', 'Close search')}
          >
            <ArrowLeftIcon className="size-icon-sm" weight="bold" />
          </button>
          <InputField
            value={filters.searchQuery}
            onChange={onSearchQueryChange}
            placeholder={t('kanban.searchPlaceholder', 'Search issues...')}
            variant="search"
            className="min-w-0 flex-1"
          />
        </div>
      ) : (
        <div
          className={cn(
            'flex min-w-0 flex-wrap items-center',
            isMobile ? 'gap-half' : 'gap-base'
          )}
        >
          <ButtonGroup className="flex-wrap">
            <ButtonGroupItem
              active={activeViewId === viewIds.TEAM}
              onClick={() => onViewChange(viewIds.TEAM)}
            >
              {t('kanban.team', 'Team')}
            </ButtonGroupItem>
            <ButtonGroupItem
              active={activeViewId === viewIds.PERSONAL}
              onClick={() => onViewChange(viewIds.PERSONAL)}
            >
              {t('kanban.personal', 'Personal')}
            </ButtonGroupItem>
          </ButtonGroup>

          {isMobile ? (
            <button
              type="button"
              onClick={() => setMobileSearchExpanded(true)}
              className={cn(
                'p-half transition-colors rounded-sm',
                filters.searchQuery
                  ? 'text-brand hover:text-brand'
                  : 'text-low hover:text-normal hover:bg-secondary'
              )}
              aria-label={t('kanban.searchPlaceholder', 'Search issues...')}
            >
              <MagnifyingGlassIcon className="size-icon-sm" weight="bold" />
            </button>
          ) : (
            <InputField
              value={filters.searchQuery}
              onChange={onSearchQueryChange}
              placeholder={t('kanban.searchPlaceholder', 'Search issues...')}
              variant="search"
              actionIcon={filters.searchQuery ? XIcon : undefined}
              onAction={handleClearSearch}
              className="min-w-[160px] w-[220px] max-w-full"
            />
          )}

          <button
            type="button"
            onClick={() => onFiltersDialogOpenChange(true)}
            className={cn(
              'flex items-center justify-center p-half rounded-sm transition-colors',
              hasActiveFilters
                ? 'text-brand hover:text-brand'
                : 'text-low hover:text-normal hover:bg-secondary'
            )}
            aria-label={t('kanban.filters', 'Open filters')}
            title={t('kanban.filters', 'Open filters')}
          >
            <FunnelIcon className="size-icon-sm" weight="bold" />
          </button>

          {hasActiveFilters && (
            <PrimaryButton
              variant="tertiary"
              value={t('kanban.clearFilters', 'Clear filters')}
              actionIcon={XIcon}
              onClick={onClearFilters}
            />
          )}

          {isMobile ? (
            <button
              type="button"
              onClick={() => onCreateIssue()}
              className={cn(
                'rounded-sm p-half bg-brand hover:bg-brand-hover text-on-brand transition-colors',
                shouldAnimateCreateButton && 'create-issue-attention'
              )}
              aria-label={t('kanban.newIssue', 'New issue')}
            >
              <PlusIcon className="size-icon-sm" weight="bold" />
            </button>
          ) : (
            <PrimaryButton
              variant="secondary"
              value={t('kanban.newIssue', 'New issue')}
              actionIcon={PlusIcon}
              onClick={() => onCreateIssue()}
              className={cn(
                shouldAnimateCreateButton && 'create-issue-attention'
              )}
            />
          )}
        </div>
      )}

      {renderFiltersDialog?.({
        open: isFiltersDialogOpen,
        onOpenChange: onFiltersDialogOpenChange,
        projectId,
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
      })}
    </>
  );
}
