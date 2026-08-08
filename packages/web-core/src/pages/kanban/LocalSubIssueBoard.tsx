import { ProjectKanban } from '@/pages/kanban/ProjectKanban';

/**
 * Route component for /projects/$projectId/issues/$issueId/sub-board.
 *
 * Sub-issue board (2026-08-07): rather than a bespoke board, this renders the
 * REGULAR project kanban (`ProjectKanban` → `KanbanContainer`); the board
 * narrows itself to the parent's children via `parentIssueId` in the kanban
 * route state (see `resolveKanbanRouteState`). All the usual board behaviour
 * — columns, the polished cross-surface drag-and-drop, filtering, the issue
 * panel — is reused unchanged. A breadcrumb header is rendered inside
 * `KanbanContainer` when `parentIssueId` is active.
 */
export function LocalSubIssueBoard() {
  return <ProjectKanban />;
}
