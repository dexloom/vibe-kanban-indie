import { createFileRoute } from '@tanstack/react-router';
import { LocalSubIssueBoard } from '@/pages/kanban/LocalSubIssueBoard';
import { projectSearchValidator } from '@vibe/web-core/project-search';

// Sub-issue board (2026-08-07): a full-page kanban of one parent issue's
// children grouped by status. Opened from the parent card on the main board.
// The `_:sub-board` suffix keeps the bare `/projects/{id}` and
// `/projects/{id}/issues/{id}` routes matching (path-non-collision convention).
export const Route = createFileRoute(
  '/_app/projects/$projectId_/issues/$issueId_/sub-board'
)({
  validateSearch: projectSearchValidator,
  component: LocalSubIssueBoard,
});
