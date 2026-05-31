-- Local issue relationships (blocking / related / has_duplicate).
-- The hosted product persists these in Postgres; locally they live in SQLite
-- so the MCP server's relationship tools work with no cloud account.
CREATE TABLE IF NOT EXISTS issue_relationships (
    id                BLOB PRIMARY KEY,
    issue_id          BLOB NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    related_issue_id  BLOB NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- A given directed relationship of a given type is unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_relationships_unique
    ON issue_relationships (issue_id, related_issue_id, relationship_type);

CREATE INDEX IF NOT EXISTS idx_issue_relationships_issue
    ON issue_relationships (issue_id);
