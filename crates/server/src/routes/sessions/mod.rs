pub mod queue;
pub mod review;

use axum::{
    Extension, Json, Router,
    extract::{Query, State},
    middleware::from_fn_with_state,
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    requests::UpdateSession,
    scratch::{Scratch, ScratchType},
    session::{CreateSession, Session, SessionError},
    workspace::{Workspace, WorkspaceError},
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
    },
    interactive::InteractiveTmuxConfig,
    profile::ExecutorConfig,
};
use serde::{Deserialize, Serialize};
use services::services::container::{ContainerError, ContainerService};
use ts_rs::TS;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{
    DeploymentImpl, error::ApiError, middleware::load_session_middleware,
    routes::workspaces::execution::RunScriptError,
};

#[derive(Debug, Deserialize)]
pub struct SessionQuery {
    pub workspace_id: Uuid,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateSessionRequest {
    pub workspace_id: Uuid,
    pub executor: Option<String>,
    pub name: Option<String>,
}

pub async fn get_sessions(
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<SessionQuery>,
) -> Result<ResponseJson<ApiResponse<Vec<Session>>>, ApiError> {
    let pool = &deployment.db().pool;
    let sessions = Session::find_by_workspace_id(pool, query.workspace_id).await?;
    Ok(ResponseJson(ApiResponse::success(sessions)))
}

pub async fn get_session(
    Extension(session): Extension<Session>,
) -> Result<ResponseJson<ApiResponse<Session>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(session)))
}

/// List a session's execution processes (oldest first; the last is the most
/// recent). Lets a caller recover the current/kickoff `execution_id` from a
/// `session_id` alone — e.g. an orchestrator loop tick that holds only the session.
pub async fn get_session_executions(
    State(deployment): State<DeploymentImpl>,
    Extension(session): Extension<Session>,
) -> Result<ResponseJson<ApiResponse<Vec<ExecutionProcess>>>, ApiError> {
    let pool = &deployment.db().pool;
    let executions = ExecutionProcess::find_by_session_id(pool, session.id, false).await?;
    Ok(ResponseJson(ApiResponse::success(executions)))
}

pub async fn create_session(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<ResponseJson<ApiResponse<Session>>, ApiError> {
    let pool = &deployment.db().pool;

    // Verify workspace exists
    let _workspace = Workspace::find_by_id(pool, payload.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    let session = Session::create(
        pool,
        &CreateSession {
            executor: payload.executor,
            name: payload.name,
        },
        Uuid::new_v4(),
        payload.workspace_id,
    )
    .await?;

    Ok(ResponseJson(ApiResponse::success(session)))
}

pub async fn update_session(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(request): Json<UpdateSession>,
) -> Result<ResponseJson<ApiResponse<Session>>, ApiError> {
    let pool = &deployment.db().pool;

    Session::update(pool, session.id, request.name.as_deref()).await?;

    let updated = Session::find_by_id(pool, session.id)
        .await?
        .ok_or(ApiError::Session(SessionError::NotFound))?;

    Ok(ResponseJson(ApiResponse::success(updated)))
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateFollowUpAttempt {
    pub prompt: String,
    pub executor_config: ExecutorConfig,
    pub retry_process_id: Option<Uuid>,
    pub force_when_dirty: Option<bool>,
    pub perform_git_reset: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
pub struct ResetProcessRequest {
    pub process_id: Uuid,
    pub force_when_dirty: Option<bool>,
    pub perform_git_reset: Option<bool>,
}

/// Response for a session follow-up.
///
/// Flattens the [`ExecutionProcess`] so existing callers that parse the
/// execution process directly keep working, and adds `delivered_to_live_session`
/// so an orchestrator can tell whether the prompt was injected into an
/// already-live headed tmux session (the returned execution is the *existing*
/// one) versus a freshly spawned execution.
#[derive(Debug, Serialize)]
pub struct FollowUpResponse {
    #[serde(flatten)]
    pub execution_process: ExecutionProcess,
    pub delivered_to_live_session: bool,
}

/// Whether a headed follow-up should be delivered into an existing live tmux
/// session instead of spawning a new execution.
///
/// True only when (a) the incoming request is itself headed, (b) the session's
/// latest running coding-agent execution is an interactive (headed) execution
/// (`candidate_action` carries an `InteractiveTmuxConfig`), and (c) its tmux
/// session is currently alive. `tmux_alive` is supplied by the container's
/// liveness check (`tmux_has_session`).
fn should_deliver_to_live_session(
    want_interactive: bool,
    candidate_action: Option<&ExecutorAction>,
    tmux_alive: bool,
) -> bool {
    want_interactive
        && tmux_alive
        && candidate_action
            .map(|action| action.interactive_config().is_some())
            .unwrap_or(false)
}

pub async fn follow_up(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateFollowUpAttempt>,
) -> Result<ResponseJson<ApiResponse<FollowUpResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    // Load workspace from session
    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    tracing::info!("{:?}", workspace);

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let executor_profile_id = payload.executor_config.profile_id();

    // Validate executor matches session if session has prior executions
    let expected_executor: Option<String> =
        ExecutionProcess::latest_executor_profile_for_session(pool, session.id)
            .await?
            .map(|profile| profile.executor.to_string())
            .or_else(|| session.executor.clone());

    if let Some(expected) = expected_executor {
        let actual = executor_profile_id.executor.to_string();
        if expected != actual {
            return Err(ApiError::Session(SessionError::ExecutorMismatch {
                expected,
                actual,
            }));
        }
    }

    if session.executor.is_none() {
        Session::update_executor(pool, session.id, &executor_profile_id.executor.to_string())
            .await?;
    }

    if let Some(proc_id) = payload.retry_process_id {
        let force_when_dirty = payload.force_when_dirty.unwrap_or(false);
        let perform_git_reset = payload.perform_git_reset.unwrap_or(true);
        deployment
            .container()
            .reset_session_to_process(session.id, proc_id, perform_git_reset, force_when_dirty)
            .await?;
    }

    let latest_session_info = CodingAgentTurn::find_latest_session_info(pool, session.id).await?;

    let prompt = payload.prompt;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let cleanup_action = deployment.container().cleanup_actions_for_repos(&repos);

    let working_dir = session
        .agent_working_dir
        .as_ref()
        .filter(|dir| !dir.is_empty())
        .cloned();

    // The "Claude Code Headed" agent runs in a detached tmux terminal rather
    // than headless. When that executor is selected we attach an interactive
    // config: the forced Claude session id is the existing conversation's id for
    // a follow-up (so `--resume` reattaches it) or a fresh uuid for an initial
    // run. The terminal emulator comes from the user config.
    let want_interactive =
        executor_profile_id.executor == executors::executors::BaseCodingAgent::ClaudeCodeHeaded;
    let interactive = if want_interactive {
        let terminal = deployment.config().read().await.terminal;
        let session_uuid = latest_session_info
            .as_ref()
            .and_then(|info| Uuid::parse_str(&info.session_id).ok())
            .unwrap_or_else(Uuid::new_v4);
        Some(InteractiveTmuxConfig {
            session_uuid,
            terminal,
        })
    } else {
        None
    };

    // Headed live-delivery gate: when this is a headed follow-up (not a
    // retry/reset) and the session already has a *live* interactive execution,
    // inject the prompt into that running tmux/Claude TUI instead of spawning a
    // second `--resume` agent. Falls back to the normal spawn path when no live
    // session exists, or if the session dies between the liveness check and the
    // send (so the prompt is never silently dropped).
    if want_interactive
        && payload.retry_process_id.is_none()
        && let Some(candidate) =
            ExecutionProcess::find_latest_running_coding_agent_for_session(pool, session.id).await?
    {
        let tmux_alive = deployment
            .container()
            .is_interactive_session_live(&candidate)
            .await;
        let candidate_action = candidate.executor_action().ok();
        if should_deliver_to_live_session(want_interactive, candidate_action, tmux_alive) {
            match deployment
                .container()
                .send_interactive_message(&candidate, &prompt)
                .await
            {
                Ok(()) => {
                    // Best-effort: clear the draft follow-up scratch.
                    if let Err(e) =
                        Scratch::delete(pool, session.id, &ScratchType::DraftFollowUp).await
                    {
                        tracing::debug!(
                            "Failed to delete draft follow-up scratch for session {}: {}",
                            session.id,
                            e
                        );
                    }
                    return Ok(ResponseJson(ApiResponse::success(FollowUpResponse {
                        execution_process: candidate,
                        delivered_to_live_session: true,
                    })));
                }
                Err(ContainerError::InteractiveSessionGone) => {
                    tracing::info!(
                        "Live headed session for {} vanished before delivery; \
                         spawning a fresh execution",
                        session.id
                    );
                    // fall through to the normal spawn path
                }
                Err(e) => return Err(e.into()),
            }
        }
    }

    let action_type = if let Some(info) = latest_session_info {
        let is_reset = payload.retry_process_id.is_some();
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: prompt.clone(),
            session_id: info.session_id,
            reset_to_message_id: if is_reset { info.message_id } else { None },
            executor_config: payload.executor_config.clone(),
            working_dir: working_dir.clone(),
            interactive: interactive.clone(),
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(
            executors::actions::coding_agent_initial::CodingAgentInitialRequest {
                prompt,
                executor_config: payload.executor_config.clone(),
                working_dir,
                interactive,
            },
        )
    };

    let action = ExecutorAction::new(action_type, cleanup_action.map(Box::new));

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await?;

    // Clear the draft follow-up scratch on successful spawn
    // This ensures the scratch is wiped even if the user navigates away quickly
    if let Err(e) = Scratch::delete(pool, session.id, &ScratchType::DraftFollowUp).await {
        // Log but don't fail the request - scratch deletion is best-effort
        tracing::debug!(
            "Failed to delete draft follow-up scratch for session {}: {}",
            session.id,
            e
        );
    }

    Ok(ResponseJson(ApiResponse::success(FollowUpResponse {
        execution_process,
        delivered_to_live_session: false,
    })))
}

pub async fn reset_process(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<ResetProcessRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    let force_when_dirty = payload.force_when_dirty.unwrap_or(false);
    let perform_git_reset = payload.perform_git_reset.unwrap_or(true);

    deployment
        .container()
        .reset_session_to_process(
            session.id,
            payload.process_id,
            perform_git_reset,
            force_when_dirty,
        )
        .await?;

    Ok(ResponseJson(ApiResponse::success(())))
}

pub async fn run_setup_script(
    Extension(session): Extension<Session>,
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ExecutionProcess, RunScriptError>>, ApiError> {
    let pool = &deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, session.workspace_id)
        .await?
        .ok_or(ApiError::Workspace(WorkspaceError::ValidationError(
            "Workspace not found".to_string(),
        )))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(ResponseJson(ApiResponse::error_with_data(
            RunScriptError::ProcessAlreadyRunning,
        )));
    }

    deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match deployment.container().setup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(ResponseJson(ApiResponse::error_with_data(
                RunScriptError::NoScriptConfigured,
            )));
        }
    };

    let execution_process = deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    deployment
        .track_if_analytics_allowed(
            "setup_script_executed",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(execution_process)))
}

pub fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let session_id_router = Router::new()
        .route("/", get(get_session).put(update_session))
        .route("/executions", get(get_session_executions))
        .route("/follow-up", post(follow_up))
        .route("/reset", post(reset_process))
        .route("/setup", post(run_setup_script))
        .route("/review", post(review::start_review))
        .layer(from_fn_with_state(
            deployment.clone(),
            load_session_middleware,
        ));

    let sessions_router = Router::new()
        .route("/", get(get_sessions).post(create_session))
        .nest("/{session_id}", session_id_router)
        .nest("/{session_id}/queue", queue::router(deployment));

    Router::new().nest("/sessions", sessions_router)
}

#[cfg(test)]
mod tests {
    use executors::{executors::BaseCodingAgent, interactive::TerminalKind};
    use uuid::Uuid;

    use super::*;

    fn follow_up_action(interactive: bool) -> ExecutorAction {
        let interactive = interactive.then(|| InteractiveTmuxConfig {
            session_uuid: Uuid::new_v4(),
            terminal: TerminalKind::None,
        });
        ExecutorAction::new(
            ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
                prompt: "hi".to_string(),
                session_id: "claude-session".to_string(),
                reset_to_message_id: None,
                executor_config: ExecutorConfig::new(BaseCodingAgent::ClaudeCodeHeaded),
                working_dir: None,
                interactive,
            }),
            None,
        )
    }

    #[test]
    fn delivers_when_headed_and_tmux_alive_and_candidate_interactive() {
        let action = follow_up_action(true);
        assert!(should_deliver_to_live_session(true, Some(&action), true));
    }

    #[test]
    fn spawns_when_tmux_not_alive() {
        // The session died (tmux_has_session == false) → fall back to spawning,
        // never inject into a dead pane.
        let action = follow_up_action(true);
        assert!(!should_deliver_to_live_session(true, Some(&action), false));
    }

    #[test]
    fn spawns_when_request_not_headed() {
        let action = follow_up_action(true);
        assert!(!should_deliver_to_live_session(false, Some(&action), true));
    }

    #[test]
    fn spawns_when_candidate_not_interactive() {
        // Latest running execution exists but is a headless (non-interactive)
        // coding agent → there is no live tmux TUI to deliver into.
        let action = follow_up_action(false);
        assert!(!should_deliver_to_live_session(true, Some(&action), true));
    }

    #[test]
    fn spawns_when_no_candidate() {
        assert!(!should_deliver_to_live_session(true, None, true));
    }
}
