import { useCallback, useMemo } from 'react';
import { useActions } from '@/shared/hooks/useActions';
import { Actions } from '@/shared/actions';
import { BulkActionBar } from '@vibe/ui/components/BulkActionBar';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';

interface BulkActionBarContainerProps {
  projectId: string;
}

export function BulkActionBarContainer({
  projectId,
}: BulkActionBarContainerProps) {
  const selectedIssueIds = useIssueSelectionStore((s) => s.selectedIssueIds);
  const clearSelection = useIssueSelectionStore((s) => s.clearSelection);
  const { executeAction, openStatusSelection, openPrioritySelection } =
    useActions();

  const issueIds = useMemo(() => [...selectedIssueIds], [selectedIssueIds]);

  const handleChangeStatus = useCallback(async () => {
    await openStatusSelection(projectId, issueIds);
  }, [projectId, issueIds, openStatusSelection]);

  const handleChangePriority = useCallback(async () => {
    await openPrioritySelection(projectId, issueIds);
  }, [projectId, issueIds, openPrioritySelection]);

  const handleDelete = useCallback(async () => {
    await executeAction(Actions.DeleteIssue, undefined, projectId, issueIds);
    clearSelection();
  }, [executeAction, projectId, issueIds, clearSelection]);

  return (
    <BulkActionBar
      selectedCount={selectedIssueIds.size}
      onChangeStatus={handleChangeStatus}
      onChangePriority={handleChangePriority}
      onDelete={handleDelete}
      onClearSelection={clearSelection}
    />
  );
}
