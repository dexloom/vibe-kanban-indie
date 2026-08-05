-- Add parent_id (self-FK, ON DELETE RESTRICT) to projects for subprojects
-- (ADR-013).
--
-- SAFETY NOTE: this deliberately uses `ALTER TABLE ADD COLUMN`, NOT the
-- SQLite "table recreation" pattern. sqlx runs each migration inside a
-- transaction, and `PRAGMA foreign_keys = OFF` is a no-op inside a
-- transaction. A `DROP TABLE projects` under an ACTIVE foreign-key
-- pragma executes an implicit `DELETE FROM projects`, which cascades
-- (`ON DELETE CASCADE`) into every child table (issues, project_statuses,
-- project_repos, kanban_tags, tasks) — silently destroying all kanban
-- data. ALTER TABLE ADD COLUMN touches no existing rows and is
-- idempotent-safe for existing installs.
--
-- SQLite supports a REFERENCES clause on ADD COLUMN when the column has
-- a NULL default (it does here — subprojects are optional), and foreign
-- key enforcement applies normally.
ALTER TABLE projects ADD COLUMN parent_id BLOB REFERENCES projects(id) ON DELETE RESTRICT;

-- Existing projects are all roots; a NULL parent_id is the root marker.
CREATE INDEX idx_projects_parent ON projects(parent_id);
CREATE INDEX idx_projects_sort_order ON projects(sort_order);
