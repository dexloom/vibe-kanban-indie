import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';
import { LocalSubIssueBoard } from '@/pages/kanban/LocalSubIssueBoard';

// Sub-issue board (2026-08-07): a full-page kanban of one parent issue's
// children grouped by status. Opened from the parent card on the main board.
// The `_:sub-board` suffix keeps the bare `/projects/{id}` and
// `/projects/{id}/issues/{id}` routes matching (path-non-collision convention).
// The optional `issue` search param selects a child so its panel opens
// directly (used when the sub-issue is clicked in the sidebar).
export const Route = createFileRoute(
  '/_app/projects/$projectId_/issues/$issueId_/sub-board'
)({
  validateSearch: zodValidator(z.object({ issue: z.string().optional() })),
  component: LocalSubIssueBoard,
});
