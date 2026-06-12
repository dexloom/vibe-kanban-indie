-- Discriminator for special-purpose workspaces. NULL = normal workspace.
-- 'orchestrator' = headed Claude Code session driving the board via /loop.
ALTER TABLE workspaces ADD COLUMN kind TEXT;
