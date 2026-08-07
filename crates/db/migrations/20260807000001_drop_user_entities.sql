-- ADR-019: excise the User entity. Single-developer fork — the one
-- predefined local_user (LOCAL_USER_ID = 0xA002) carried no information;
-- every creator/author/assignee was always that id.
--
-- Safety rationale:
--   * `issue_assignees` is a leaf junction: `issue_id` is the only outbound FK
--     (CASCADE from issues), and nothing on the schema points at `user_id`
--     (it was an unconstrained BLOB, never a real FK). Drop is safe.
--   * `local_users` has no inbound FKs. `issues.creator_user_id` and
--     `issue_comments.author_id` are bare BLOB columns with no REFERENCES
--     clause (verified pre-merge). Drop is safe.
--   * `creator_user_id` / `author_id` columns are unconstrained BLOBs (no
--     REFERENCES, no CHECK, no trigger). DROP COLUMN is safe.
-- Requires SQLite ≥ 3.35 for DROP COLUMN. CI bundles ≥ 3.40 on all platforms.

DROP TABLE IF EXISTS issue_assignees;
DROP TABLE IF EXISTS local_users;
ALTER TABLE issues DROP COLUMN creator_user_id;
ALTER TABLE issue_comments DROP COLUMN author_id;
