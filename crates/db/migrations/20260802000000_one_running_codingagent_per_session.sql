-- Enforce at most one LIVE (non-dropped) running coding-agent execution per
-- session. The application does a preflight check before spawning, but that
-- check-then-act is racy: two concurrent dispatches for the same session can
-- both observe "not running" and each launch an agent, corrupting the
-- conversation. This unique partial index makes the INSERT itself the atomic
-- gate; the second insert raises a UNIQUE constraint violation that the
-- server maps to a 409 Conflict.
--
-- Scope: only codingagent processes that are still running AND not dropped.
-- Setup/cleanup/dev-server/archive runs (different run_reason), and any
-- finished or dropped process, are excluded — retry/reset kills the prior
-- running process before starting a new one, so legit flows never hold two.
CREATE UNIQUE INDEX IF NOT EXISTS execution_processes_one_running_codingagent_per_session
    ON execution_processes (session_id)
    WHERE status = 'running'
      AND run_reason = 'codingagent'
      AND dropped = FALSE;
