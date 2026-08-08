-- Mark which kanban column(s) mean "finished" explicitly, replacing the
-- positional heuristic (hidden columns ∪ last visible column by sort_order)
-- that both the board UI and external orchestrators previously had to infer.
--
-- ADR-013: ALTER TABLE ADD COLUMN only — never recreate this table.
--
-- The backfill below reproduces the old heuristic exactly so no board
-- changes behavior on upgrade:
--   1. every hidden column is terminal;
--   2. per project, the visible column with the highest sort_order is
--      terminal (a project whose columns are ALL hidden has no "last
--      visible" column, so its terminal set is just the hidden ones).

ALTER TABLE project_statuses ADD COLUMN is_terminal BOOLEAN NOT NULL DEFAULT 0;

UPDATE project_statuses SET is_terminal = 1 WHERE hidden != 0;

UPDATE project_statuses
SET is_terminal = 1
WHERE hidden = 0
  AND sort_order = (
      SELECT MAX(sort_order)
      FROM project_statuses AS visible
      WHERE visible.project_id = project_statuses.project_id
        AND visible.hidden = 0
  );
