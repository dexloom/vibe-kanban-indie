-- Add ephemeral flag for throwaway workspaces (e.g. spec-intake generation).
-- Ephemeral workspaces are excluded from list/kanban queries and event streams,
-- skip normal finalize side effects (commit/notify/analytics/remote sync), and
-- are reaped on startup.
ALTER TABLE workspaces ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT FALSE;
