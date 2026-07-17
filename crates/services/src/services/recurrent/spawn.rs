//! Spawn logic for recurrent routines, shared by the scheduler (due ticks)
//! and the run-now API route. Mirrors `spawn_orchestrator`
//! (`crates/server/src/routes/workspaces/create.rs`): one persistent
//! singleton workspace per routine, a fresh session started on it each run.

use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Arc, OnceLock},
};

use chrono::Utc;
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    workspace::{CreateWorkspace, Workspace, WorkspaceKind},
};
use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{RecurrentError, Routine};
use crate::services::container::ContainerService;

/// Outcome of a single spawn attempt (scheduler tick or run-now).
#[derive(Debug)]
pub enum SpawnOutcome {
    Spawned(Box<Workspace>, Box<ExecutionProcess>),
    /// A previous run is still active (confirmed live for headed sessions;
    /// authoritative from the DB `running` row alone for headless sessions).
    SkippedActive,
}

/// Per-routine async locks, keyed by routine id. Serializes the whole
/// find-or-create-then-`start_workspace` critical section so a scheduler tick
/// and a run-now (or two overlapping ticks) can never both observe "no
/// workspace" and each create one. This deployment is a single-process SQLite
/// server, so a process-wide lock fully serializes it.
static ROUTINE_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

async fn routine_lock(routine_id: &str) -> Arc<Mutex<()>> {
    let locks = ROUTINE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = locks.lock().await;
    guard
        .entry(routine_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Build the executor config for a routine run. Mirrors
/// `orchestrator_executor_config`, but resolved from the routine's TOML
/// rather than hardcoded.
pub fn build_executor_config(routine: &Routine) -> ExecutorConfig {
    let executor =
        BaseCodingAgent::from_str(&routine.executor_profile).unwrap_or(BaseCodingAgent::ClaudeCode);
    ExecutorConfig {
        executor,
        variant: None,
        model_id: None,
        agent_id: routine.agent.clone(),
        reasoning_id: None,
        permission_policy: None,
    }
}

/// Best-effort, non-blocking Telegram escalation for a routine that failed to
/// start (never reached `finalize_task`, so the steady-state failure hook in
/// `ContainerService::finalize_task` would otherwise miss it). Fired via
/// `tokio::spawn` with an internal timeout so a Telegram outage can never
/// slow down (or fail) the spawn path itself.
fn escalate_startup_failure(routine: &Routine, error: &str) {
    let text = format!(
        "⚠️ Recurrent routine '{}' ({}) failed to start: {}",
        routine.name, routine.id, error
    );
    tokio::spawn(async move {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            utils::telegram::Telegram::send_escalation_best_effort(&text),
        )
        .await;
    });
}

#[derive(Debug, PartialEq, Eq)]
enum ActiveDecision {
    /// A previous run is confirmed active (headed: live tmux session;
    /// headless: the DB `running` row is authoritative by itself) — skip
    /// spawning a new one.
    Active,
    /// Headed only: the DB says `running` but the tmux session is gone —
    /// finalize the stale process, then proceed to start a fresh session.
    StaleFinalizeAndRestart,
}

/// Pure decision for what to do about an existing `running` coding-agent row,
/// given whether the configured executor is headed and (for headed only)
/// whether its tmux session was confirmed live. Extracted from
/// `spawn_routine_run` so the headed-vs-headless branching is unit-testable
/// without a `ContainerService` mock (see `tests` below).
fn decide_active(is_headed: bool, live_if_headed: bool) -> ActiveDecision {
    if is_headed && !live_if_headed {
        ActiveDecision::StaleFinalizeAndRestart
    } else {
        ActiveDecision::Active
    }
}

/// Find-or-create the routine's singleton workspace and start a fresh session
/// on it, unless a previous run is still active (in which case
/// `SkippedActive` is returned and nothing new is spawned).
pub async fn spawn_routine_run<C: ContainerService + Send + Sync>(
    container: &C,
    routine: &Routine,
) -> Result<SpawnOutcome, RecurrentError> {
    let lock = routine_lock(&routine.id).await;
    let _guard = lock.lock().await;

    let pool = &container.db().pool;
    let cfg = build_executor_config(routine);

    let workspace = match Workspace::find_recurrent_by_name(pool, &routine.id).await? {
        Some(existing) => {
            let running =
                ExecutionProcess::find_latest_running_coding_agent_for_workspace(pool, existing.id)
                    .await?;

            if let Some(proc) = running {
                let is_headed = cfg.executor.is_headed();
                // Headed: the DB `running` status can lag behind a tmux
                // session that ended out-of-band, so confirm liveness before
                // treating it as active. Headless: `is_interactive_session_live`
                // always returns false for non-headed executions, so it can't
                // be used to confirm liveness — the `running` DB row is
                // itself authoritative (`live_if_headed` is simply unused in
                // that branch).
                let live_if_headed =
                    is_headed && container.is_interactive_session_live(&proc).await;

                match decide_active(is_headed, live_if_headed) {
                    ActiveDecision::Active => return Ok(SpawnOutcome::SkippedActive),
                    ActiveDecision::StaleFinalizeAndRestart => {
                        // tmux session gone but DB still says running.
                        // Finalize it so the restart below starts from a
                        // clean slate (and the liveness poller doesn't later
                        // double-finalize it).
                        if let Err(e) = container
                            .stop_execution(&proc, ExecutionProcessStatus::Completed)
                            .await
                        {
                            tracing::warn!(
                                "Failed to finalize stale recurrent process {} for routine {}: {}",
                                proc.id,
                                routine.id,
                                e
                            );
                        }
                    }
                }
            }

            existing
        }
        None => {
            // Structural trust boundary: no repositories are ever added to a
            // recurrent workspace, so the agent's CWD is only its scratch dir.
            match Workspace::create(
                pool,
                &CreateWorkspace {
                    branch: routine.id.clone(),
                    name: Some(routine.id.clone()),
                    kind: Some(WorkspaceKind::Recurrent),
                },
                Uuid::new_v4(),
            )
            .await
            {
                Ok(ws) => ws,
                Err(e) => {
                    escalate_startup_failure(routine, &e.to_string());
                    return Err(e.into());
                }
            }
        }
    };

    match container
        .start_workspace(&workspace, cfg, routine.prompt.clone())
        .await
    {
        Ok(process) => Ok(SpawnOutcome::Spawned(
            Box::new(workspace),
            Box::new(process),
        )),
        Err(e) => {
            escalate_startup_failure(routine, &e.to_string());
            Err(e.into())
        }
    }
}

/// Stop a routine's currently running session if it has exceeded
/// `max_runtime`. Stateless: re-derives the running process (if any) from the
/// DB each call, so it's safe to call on every scheduler tick regardless of
/// whether this tick is "due" for the routine.
pub async fn stop_overrunning<C: ContainerService + Send + Sync>(
    container: &C,
    routine: &Routine,
) -> Result<(), RecurrentError> {
    let pool = &container.db().pool;
    let Some(existing) = Workspace::find_recurrent_by_name(pool, &routine.id).await? else {
        return Ok(());
    };
    let Some(proc) =
        ExecutionProcess::find_latest_running_coding_agent_for_workspace(pool, existing.id).await?
    else {
        return Ok(());
    };

    let age = Utc::now().signed_duration_since(proc.started_at);
    let max_runtime = chrono::Duration::seconds(routine.max_runtime_secs as i64);
    if age > max_runtime {
        tracing::info!(
            "Recurrent routine '{}' exceeded max_runtime ({}s, running {}s); stopping process {}",
            routine.id,
            routine.max_runtime_secs,
            age.num_seconds(),
            proc.id
        );
        container
            .stop_execution(&proc, ExecutionProcessStatus::Killed)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_running_row_is_authoritative_regardless_of_live_flag() {
        // Headless: a `running` DB row alone means "skip" — the
        // `is_interactive_session_live` result never even factors in (it's
        // always false for headless executions in the real implementation,
        // but the decision must be `Active` even if it somehow were true).
        assert_eq!(decide_active(false, false), ActiveDecision::Active);
        assert_eq!(decide_active(false, true), ActiveDecision::Active);
    }

    #[test]
    fn headed_live_session_is_active() {
        assert_eq!(decide_active(true, true), ActiveDecision::Active);
    }

    #[test]
    fn headed_dead_session_is_stale_and_restarts() {
        assert_eq!(
            decide_active(true, false),
            ActiveDecision::StaleFinalizeAndRestart
        );
    }

    #[test]
    fn build_executor_config_resolves_agent_and_executor() {
        let routine = Routine {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            enabled: true,
            prompt: "do the thing".to_string(),
            agent: Some("vibe-kanban-indie:orchestrator".to_string()),
            executor_profile: "CLAUDE_CODE_HEADED".to_string(),
            max_runtime_secs: 1800,
            schedule: crate::services::recurrent::schedule::RoutineScheduleView {
                kind: "interval".to_string(),
                expr: "30m".to_string(),
            },
            last_run: None,
        };
        let cfg = build_executor_config(&routine);
        assert_eq!(cfg.executor, BaseCodingAgent::ClaudeCodeHeaded);
        assert_eq!(
            cfg.agent_id.as_deref(),
            Some("vibe-kanban-indie:orchestrator")
        );
        assert!(cfg.variant.is_none());
    }

    #[test]
    fn build_executor_config_defaults_to_claude_code() {
        let routine = Routine {
            id: "demo2".to_string(),
            name: "Demo 2".to_string(),
            enabled: true,
            prompt: "do the thing".to_string(),
            agent: None,
            executor_profile: "CLAUDE_CODE".to_string(),
            max_runtime_secs: 1800,
            schedule: crate::services::recurrent::schedule::RoutineScheduleView {
                kind: "cron".to_string(),
                expr: "0 9 * * *".to_string(),
            },
            last_run: None,
        };
        let cfg = build_executor_config(&routine);
        assert_eq!(cfg.executor, BaseCodingAgent::ClaudeCode);
        assert!(cfg.agent_id.is_none());
    }
}
