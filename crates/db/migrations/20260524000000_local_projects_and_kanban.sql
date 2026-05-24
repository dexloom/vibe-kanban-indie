-- Local-only projects + kanban support.
--
-- The hosted product serves projects/issues from Postgres via ElectricSQL and
-- gates them behind organisation auth. This migration adds the schema needed to
-- run the same kanban UI fully locally against SQLite, fed through the
-- frontend's built-in HTTP fallback transport (/v1/fallback/* + /v1/* mutations).

-- 1. Presentation/config columns the frontend `Project` shape expects.
--    `key` is the per-project issue prefix (e.g. "ACME" -> "ACME-5").
ALTER TABLE projects ADD COLUMN key TEXT;
ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '#6366f1';
ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- 2. Predefined local user. Name is configurable via projects.toml and applied
--    by the startup reconciler. References to users (creator/assignee) point here.
CREATE TABLE local_users (
    id         BLOB PRIMARY KEY,
    email      TEXT NOT NULL DEFAULT '',
    first_name TEXT,
    last_name  TEXT,
    username   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- 3. Kanban columns.
CREATE TABLE project_statuses (
    id         BLOB PRIMARY KEY,
    project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX idx_project_statuses_project_id ON project_statuses(project_id);

-- 4. Issues (kanban cards).
CREATE TABLE issues (
    id                      BLOB PRIMARY KEY,
    project_id              BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_number            INTEGER NOT NULL,
    simple_id               TEXT NOT NULL,
    status_id               BLOB NOT NULL REFERENCES project_statuses(id),
    title                   TEXT NOT NULL,
    description             TEXT,
    priority                TEXT,
    start_date              TEXT,
    target_date             TEXT,
    completed_at            TEXT,
    sort_order              REAL NOT NULL DEFAULT 0,
    parent_issue_id         BLOB REFERENCES issues(id) ON DELETE SET NULL,
    parent_issue_sort_order REAL,
    extension_metadata      TEXT NOT NULL DEFAULT '{}',
    creator_user_id         BLOB,
    created_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX idx_issues_project_id ON issues(project_id);
CREATE INDEX idx_issues_status_id ON issues(status_id);
CREATE UNIQUE INDEX idx_issues_project_number ON issues(project_id, issue_number);

-- 5. Tags + issue/tag junction.
-- Named `kanban_tags` because a pre-existing `tags` table (content templates)
-- already occupies that name. Served to the frontend at /v1/fallback/tags.
CREATE TABLE kanban_tags (
    id         BLOB PRIMARY KEY,
    project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE issue_tags (
    id       BLOB PRIMARY KEY,
    issue_id BLOB NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    tag_id   BLOB NOT NULL REFERENCES kanban_tags(id) ON DELETE CASCADE,
    UNIQUE (issue_id, tag_id)
);
CREATE INDEX idx_issue_tags_issue_id ON issue_tags(issue_id);

-- 6. Assignees (user_id references the local user above).
CREATE TABLE issue_assignees (
    id          BLOB PRIMARY KEY,
    issue_id    BLOB NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id     BLOB NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (issue_id, user_id)
);
CREATE INDEX idx_issue_assignees_issue_id ON issue_assignees(issue_id);
