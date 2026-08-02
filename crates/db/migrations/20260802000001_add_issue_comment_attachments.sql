CREATE TABLE issue_attachments (
    id             BLOB PRIMARY KEY,
    issue_id       BLOB NOT NULL,
    attachment_id  BLOB NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','subsec')),
    FOREIGN KEY (issue_id)      REFERENCES issues(id)          ON DELETE CASCADE,
    FOREIGN KEY (attachment_id) REFERENCES attachments(id)     ON DELETE CASCADE,
    UNIQUE(issue_id, attachment_id)
);
CREATE INDEX idx_issue_attachments_issue_id      ON issue_attachments(issue_id);
CREATE INDEX idx_issue_attachments_attachment_id ON issue_attachments(attachment_id);

CREATE TABLE comment_attachments (
    id             BLOB PRIMARY KEY,
    comment_id     BLOB NOT NULL,
    attachment_id  BLOB NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','subsec')),
    FOREIGN KEY (attachment_id) REFERENCES attachments(id)     ON DELETE CASCADE,
    UNIQUE(comment_id, attachment_id)
);
CREATE INDEX idx_comment_attachments_comment_id    ON comment_attachments(comment_id);
CREATE INDEX idx_comment_attachments_attachment_id ON comment_attachments(attachment_id);

DROP TABLE task_attachments;
