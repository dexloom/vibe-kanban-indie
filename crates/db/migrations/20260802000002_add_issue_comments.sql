CREATE TABLE issue_comments (
    id         BLOB PRIMARY KEY,
    issue_id   BLOB NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    parent_id  BLOB,
    author_id  BLOB NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','subsec'))
);
CREATE INDEX idx_issue_comments_issue_id ON issue_comments(issue_id);
