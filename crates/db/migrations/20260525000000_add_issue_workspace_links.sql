-- Local workspace <-> kanban-issue links.
--
-- The hosted product records which workspaces belong to an issue via the remote
-- Postgres `workspaces.issue_id` column. Locally there was no equivalent, so
-- launching a workspace from a kanban card left no trace tying it to the card.
-- This join table provides that link in local SQLite. `workspace_id` is UNIQUE
-- so a workspace belongs to at most one issue (mirrors the remote model), and
-- both sides cascade on delete.
CREATE TABLE issue_workspaces (
    id           BLOB PRIMARY KEY,
    issue_id     BLOB NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    workspace_id BLOB NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX idx_issue_workspaces_issue_id ON issue_workspaces(issue_id);
