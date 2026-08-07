import { useMemo } from 'react';
import type { KanbanFilterState } from '@/shared/stores/useUiPreferencesStore';
import type {
  Issue,
  IssueRelationship,
  IssueTag,
  IssuePriority,
} from 'shared/remote-types';

type UseKanbanFiltersParams = {
  issues: Issue[];
  issueTags: IssueTag[];
  issueRelationships: IssueRelationship[];
  issuesById: Map<string, Issue>;
  doneStatusIds: Set<string>;
  filters: KanbanFilterState;
  showSubIssues: boolean;
  hideBlocked: boolean;
};

type UseKanbanFiltersResult = {
  filteredIssues: Issue[];
};

export const PRIORITY_ORDER: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function useKanbanFilters({
  issues,
  issueTags,
  issueRelationships,
  issuesById,
  doneStatusIds,
  filters,
  showSubIssues,
  hideBlocked,
}: UseKanbanFiltersParams): UseKanbanFiltersResult {
  const tagsByIssue = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const it of issueTags) {
      if (!map[it.issue_id]) {
        map[it.issue_id] = [];
      }
      map[it.issue_id].push(it.tag_id);
    }
    return map;
  }, [issueTags]);

  // Filter issues
  const filteredIssues = useMemo(() => {
    let result = issues;

    // Filter sub-issues based on per-project preference
    if (!showSubIssues) {
      result = result.filter((issue) => issue.parent_issue_id === null);
    }

    // Text search (title + short ID)
    const query = filters.searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter((issue) => {
        if (issue.title.toLowerCase().includes(query)) {
          return true;
        }

        const simpleId = issue.simple_id.toLowerCase();
        if (simpleId.includes(query)) {
          return true;
        }

        const issueNumber = String(issue.issue_number);
        return issueNumber.includes(query);
      });
    }

    // Priority filter (OR within)
    if (filters.priorities.length > 0) {
      result = result.filter(
        (issue) =>
          issue.priority !== null && filters.priorities.includes(issue.priority)
      );
    }

    // Tags filter (OR within)
    if (filters.tagIds.length > 0) {
      result = result.filter((issue) => {
        const issueTagIds = tagsByIssue[issue.id] ?? [];
        return issueTagIds.some((tagId) => filters.tagIds.includes(tagId));
      });
    }

    // Hide blocked: filter out issues that are blocked by an unresolved issue
    if (hideBlocked) {
      result = result.filter((issue) => {
        return !issueRelationships.some((r) => {
          if (r.relationship_type !== 'blocking') return false;
          if (r.related_issue_id !== issue.id) return false;
          const blockingIssue = issuesById.get(r.issue_id);
          if (blockingIssue == null) return false;
          // Blocker is resolved if it's in a done status
          return !doneStatusIds.has(blockingIssue.status_id);
        });
      });
    }

    // Note: Sorting is handled in KanbanContainer after grouping by status
    // so that sort order is applied within each column

    return result;
  }, [
    issues,
    filters,
    tagsByIssue,
    showSubIssues,
    hideBlocked,
    issueRelationships,
    issuesById,
    doneStatusIds,
  ]);

  return {
    filteredIssues,
  };
}
