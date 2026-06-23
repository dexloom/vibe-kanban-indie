use std::path::PathBuf;

use axum::{
    Router,
    extract::{
        Query, State,
        ws::{CloseFrame, Message, Utf8Bytes},
    },
    response::IntoResponse,
    routing::get,
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    session::Session,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::interactive::tmux_session_name;
use local_deployment::terminal::tmux_has_session;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    error::ApiError,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    pub workspace_id: Uuid,
    /// When present, attach the terminal to the running headed agent's tmux
    /// session (`vk-<execution_process_id>`) instead of spawning a plain shell.
    /// The tmux session name is always server-derived from this id; the client
    /// never supplies a shell command.
    #[serde(default)]
    pub execution_process_id: Option<Uuid>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalCommand {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalMessage {
    Output { data: String },
    Error { message: String },
}

/// Why an attach request was rejected. Each variant maps to a user-facing
/// message rendered into the attached terminal before a clean close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachError {
    NotFound,
    NotRunning,
    NotCodingAgent,
    NotInteractive,
    WorkspaceMismatch,
    SessionGone,
}

impl AttachError {
    fn message(self) -> &'static str {
        match self {
            AttachError::NotFound => "No such execution process",
            AttachError::NotRunning => "The agent session is not running",
            AttachError::NotCodingAgent => "That process is not a coding-agent session",
            AttachError::NotInteractive => "That session is not an interactive (tmux) session",
            AttachError::WorkspaceMismatch => "That session belongs to a different workspace",
            AttachError::SessionGone => "The tmux session is no longer running",
        }
    }
}

/// Pure validator for an attach request. Returns the deterministic tmux session
/// name (`vk-<proc_id>`) only when the process is a running, interactive coding
/// agent owned by the requesting workspace. Kept free of DB/socket/tmux IO so it
/// is unit-testable.
fn resolve_attach_target(
    status: &ExecutionProcessStatus,
    run_reason: &ExecutionProcessRunReason,
    has_interactive: bool,
    proc_workspace_id: Uuid,
    query_workspace_id: Uuid,
    proc_id: Uuid,
) -> Result<String, AttachError> {
    if !matches!(status, ExecutionProcessStatus::Running) {
        return Err(AttachError::NotRunning);
    }
    if !matches!(run_reason, ExecutionProcessRunReason::CodingAgent) {
        return Err(AttachError::NotCodingAgent);
    }
    if !has_interactive {
        return Err(AttachError::NotInteractive);
    }
    if proc_workspace_id != query_workspace_id {
        return Err(AttachError::WorkspaceMismatch);
    }
    Ok(tmux_session_name(proc_id))
}

/// Resolve + validate the attach target against the DB (process → session →
/// workspace), then confirm the tmux session is actually alive.
async fn resolve_attach_session(
    deployment: &DeploymentImpl,
    proc_id: Uuid,
    query_workspace_id: Uuid,
) -> Result<String, AttachError> {
    let pool = &deployment.db().pool;

    let process = ExecutionProcess::find_by_id(pool, proc_id)
        .await
        .ok()
        .flatten()
        .ok_or(AttachError::NotFound)?;

    let has_interactive = process
        .executor_action()
        .ok()
        .and_then(|action| action.interactive_config())
        .is_some();

    let session = Session::find_by_id(pool, process.session_id)
        .await
        .ok()
        .flatten()
        .ok_or(AttachError::NotFound)?;

    let session_name = resolve_attach_target(
        &process.status,
        &process.run_reason,
        has_interactive,
        session.workspace_id,
        query_workspace_id,
        process.id,
    )?;

    if !tmux_has_session(&session_name).await {
        return Err(AttachError::SessionGone);
    }

    Ok(session_name)
}

async fn terminal_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
    Query(query): Query<TerminalQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let attempt = Workspace::find_by_id(&deployment.db().pool, query.workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Attempt not found".to_string()))?;

    let container_ref = attempt
        .container_ref
        .ok_or_else(|| ApiError::BadRequest("Attempt has no workspace directory".to_string()))?;

    let base_dir = PathBuf::from(&container_ref);
    if !base_dir.exists() {
        return Err(ApiError::BadRequest(
            "Workspace directory does not exist".to_string(),
        ));
    }

    let mut working_dir = base_dir.clone();
    match WorkspaceRepo::find_repos_for_workspace(&deployment.db().pool, query.workspace_id).await {
        Ok(repos) if repos.len() == 1 => {
            let repo_dir = base_dir.join(&repos[0].name);
            if repo_dir.exists() {
                working_dir = repo_dir;
            }
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(
                "Failed to resolve repos for workspace {}: {}",
                attempt.id,
                e
            );
        }
    }

    // NOTE: attach-target validation is intentionally deferred to AFTER the WS
    // upgrade. Failing pre-upgrade would surface to the browser as a failed
    // connection, which the frontend `TerminalProvider` treats as a transient
    // drop and reconnect-loops. Inside the upgraded socket we instead send a
    // `TerminalMessage::Error` and close cleanly (code 1000), which the client
    // treats as terminal.
    let attach_process_id = query.execution_process_id;
    let workspace_id = query.workspace_id;
    Ok(ws.on_upgrade(move |socket| {
        handle_terminal_ws(
            socket,
            deployment,
            working_dir,
            query.cols,
            query.rows,
            attach_process_id,
            workspace_id,
        )
    }))
}

async fn handle_terminal_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
    working_dir: PathBuf,
    cols: u16,
    rows: u16,
    attach_process_id: Option<Uuid>,
    workspace_id: Uuid,
) {
    let is_attach = attach_process_id.is_some();

    // Resolve the attach target (if any) post-upgrade. Any failure is reported
    // in-band and the socket is closed cleanly so the client does not reconnect.
    let session_result = match attach_process_id {
        Some(proc_id) => {
            match resolve_attach_session(&deployment, proc_id, workspace_id).await {
                Ok(session_name) => {
                    // `-f ignore-size` makes this (web) client ignored when tmux
                    // computes the shared window size, so the web xterm's
                    // transient 80x24 (it opens before xterm's FitAddon settles)
                    // never shrinks an already-attached external `tmux attach`.
                    // Requires tmux >= 3.0. Exact-match target (`=`) mirrors
                    // `tmux_has_session`.
                    let args = vec![
                        "attach-session".to_string(),
                        "-f".to_string(),
                        "ignore-size".to_string(),
                        "-t".to_string(),
                        format!("={session_name}"),
                    ];
                    deployment
                        .pty()
                        .create_session_with_command(
                            "tmux".to_string(),
                            args,
                            working_dir,
                            cols,
                            rows,
                        )
                        .await
                        .map_err(|e| e.to_string())
                }
                Err(attach_err) => Err(attach_err.message().to_string()),
            }
        }
        None => deployment
            .pty()
            .create_session(working_dir, cols, rows)
            .await
            .map_err(|e| e.to_string()),
    };

    let (session_id, mut output_rx) = match session_result {
        Ok(result) => result,
        Err(message) => {
            tracing::error!("Failed to create terminal session: {}", message);
            if is_attach {
                // Clean (code 1000) close so the client treats this as terminal
                // and does not reconnect to a dead/absent session.
                close_with_error(&mut socket, &message).await;
            } else {
                let _ = send_error(&mut socket, &message).await;
            }
            return;
        }
    };

    let pty_service = deployment.pty().clone();
    let session_id_for_input = session_id;

    loop {
        tokio::select! {
            maybe_output = output_rx.recv() => {
                let Some(data) = maybe_output else {
                    break;
                };

                let msg = TerminalMessage::Output {
                    data: BASE64.encode(&data),
                };
                let json = match serde_json::to_string(&msg) {
                    Ok(j) => j,
                    Err(_) => continue,
                };

                if socket.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Text(text))) => {
                        if let Ok(cmd) = serde_json::from_str::<TerminalCommand>(text.as_str()) {
                            match cmd {
                                TerminalCommand::Input { data } => {
                                    if let Ok(bytes) = BASE64.decode(&data) {
                                        let _ = pty_service.write(session_id_for_input, &bytes).await;
                                    }
                                }
                                TerminalCommand::Resize { cols, rows } => {
                                    let _ = pty_service.resize(session_id_for_input, cols, rows).await;
                                }
                            }
                        }
                    }
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!("terminal WS receive error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    let _ = deployment.pty().close_session(session_id).await;

    // For an attach session, the PTY ending means the tmux session died / the
    // agent finished. Tell the client explicitly and close cleanly so it shows
    // the end instead of reconnect-looping against a gone `vk-<id>`.
    if is_attach {
        close_with_error(&mut socket, "tmux session ended").await;
    }
}

async fn send_error(socket: &mut MaybeSignedWebSocket, message: &str) -> anyhow::Result<()> {
    let msg = TerminalMessage::Error {
        message: message.to_string(),
    };
    let json = serde_json::to_string(&msg).unwrap_or_default();
    socket.send(Message::Text(json.into())).await?;
    socket.close().await?;
    Ok(())
}

/// Send an error message then close with code 1000 (`wasClean`). The frontend
/// only suppresses reconnection on a clean 1000 close, so attach failures and
/// attach session-end MUST use this rather than a bare `close()`.
async fn close_with_error(socket: &mut MaybeSignedWebSocket, message: &str) {
    let msg = TerminalMessage::Error {
        message: message.to_string(),
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = socket.send(Message::Text(json.into())).await;
    }
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 1000,
            reason: Utf8Bytes::from_static("session ended"),
        })))
        .await;
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new().route("/terminal/ws", get(terminal_ws))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> Uuid {
        Uuid::nil()
    }

    #[test]
    fn resolves_running_interactive_coding_agent_to_tmux_name() {
        let proc_id = Uuid::from_u128(42);
        let ws = workspace();
        let got = resolve_attach_target(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::CodingAgent,
            true,
            ws,
            ws,
            proc_id,
        );
        assert_eq!(got, Ok(tmux_session_name(proc_id)));
        assert_eq!(got.unwrap(), format!("vk-{proc_id}"));
    }

    #[test]
    fn rejects_non_running() {
        let ws = workspace();
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Completed,
                &ExecutionProcessRunReason::CodingAgent,
                true,
                ws,
                ws,
                Uuid::from_u128(1),
            ),
            Err(AttachError::NotRunning)
        );
    }

    #[test]
    fn rejects_non_coding_agent() {
        let ws = workspace();
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Running,
                &ExecutionProcessRunReason::DevServer,
                true,
                ws,
                ws,
                Uuid::from_u128(1),
            ),
            Err(AttachError::NotCodingAgent)
        );
    }

    #[test]
    fn rejects_non_interactive() {
        let ws = workspace();
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Running,
                &ExecutionProcessRunReason::CodingAgent,
                false,
                ws,
                ws,
                Uuid::from_u128(1),
            ),
            Err(AttachError::NotInteractive)
        );
    }

    #[test]
    fn rejects_workspace_mismatch() {
        assert_eq!(
            resolve_attach_target(
                &ExecutionProcessStatus::Running,
                &ExecutionProcessRunReason::CodingAgent,
                true,
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                Uuid::from_u128(3),
            ),
            Err(AttachError::WorkspaceMismatch)
        );
    }
}
