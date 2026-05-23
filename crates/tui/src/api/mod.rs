//! Thin reqwest-based client for the vibe-kanban backend `/api`.
//!
//! Backend discovery mirrors `crates/mcp/src/bin/vibe_kanban_mcp.rs`: honor
//! `VIBE_BACKEND_URL`, then `HOST`/`BACKEND_PORT`/`PORT`, then fall back to the
//! port file written by the server (`utils::port_file::read_port_file`).

pub mod types;

use std::time::Duration;

use serde::de::DeserializeOwned;
use thiserror::Error;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::api::types::{
    CreateAndStartRequest, CreateAndStartResponse, FollowUpRequest, QueueRequest, Repo, Session,
    Workspace,
};

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("could not locate the backend ({0})")]
    Discovery(String),
    #[error("transport error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("backend returned an error: {0}")]
    Backend(String),
    #[error("backend response contained no data")]
    EmptyData,
}

/// HTTP client + resolved base URLs for the running backend.
#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    /// `http://host:port/api`
    base: String,
    /// `ws://host:port/api`
    ws_base: String,
}

impl ApiClient {
    /// Resolve the backend address and build a client. Errors if the backend
    /// cannot be located (e.g. the server is not running and no env override is
    /// set).
    pub async fn connect() -> Result<Self, ApiError> {
        let (base, ws_base) = resolve_base().await?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            http,
            base,
            ws_base,
        })
    }

    /// Construct a client with explicit base URLs, skipping discovery (tests).
    #[cfg(test)]
    pub fn with_base(http_base: impl Into<String>, ws_base: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: http_base.into(),
            ws_base: ws_base.into(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// `GET /api/health` — succeeds on any 2xx.
    pub async fn health(&self) -> Result<(), ApiError> {
        let resp = self
            .http
            .get(format!("{}/health", self.base))
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(ApiError::Backend(format!(
                "health status {}",
                resp.status()
            )))
        }
    }

    /// `GET /api/workspaces` — all workspaces, newest first.
    pub async fn list_workspaces(&self) -> Result<Vec<Workspace>, ApiError> {
        let resp = self
            .http
            .get(format!("{}/workspaces", self.base))
            .send()
            .await?;
        unwrap_api(resp).await
    }

    /// `GET /api/sessions?workspace_id=` — sessions for a workspace, most
    /// recently used first.
    pub async fn list_sessions(&self, workspace_id: Uuid) -> Result<Vec<Session>, ApiError> {
        let resp = self
            .http
            .get(format!("{}/sessions", self.base))
            .query(&[("workspace_id", workspace_id.to_string())])
            .send()
            .await?;
        unwrap_api(resp).await
    }

    /// `POST /api/execution-processes/{id}/stop` — kill a running process.
    pub async fn stop_process(&self, exec_id: Uuid) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}/execution-processes/{exec_id}/stop", self.base))
            .send()
            .await?;
        let _: () = unwrap_api(resp).await?;
        Ok(())
    }

    /// WS URL for the per-session execution-process stream.
    pub fn session_processes_ws(&self, session_id: Uuid) -> String {
        format!(
            "{}/execution-processes/stream/session/ws?session_id={session_id}",
            self.ws_base
        )
    }

    /// WS URL for a process's normalized-log stream.
    pub fn normalized_logs_ws(&self, exec_id: Uuid) -> String {
        format!(
            "{}/execution-processes/{exec_id}/normalized-logs/ws",
            self.ws_base
        )
    }

    /// `GET /api/repos` — registered repositories (for the create form).
    pub async fn list_repos(&self) -> Result<Vec<Repo>, ApiError> {
        let resp = self.http.get(format!("{}/repos", self.base)).send().await?;
        unwrap_api(resp).await
    }

    /// `POST /api/workspaces/start` — create a workspace and start the agent.
    pub async fn create_and_start(
        &self,
        req: &CreateAndStartRequest,
    ) -> Result<CreateAndStartResponse, ApiError> {
        let resp = self
            .http
            .post(format!("{}/workspaces/start", self.base))
            .json(req)
            .send()
            .await?;
        unwrap_api(resp).await
    }

    /// `POST /api/sessions/{id}/follow-up` — send a follow-up turn to a session.
    pub async fn follow_up(&self, session_id: Uuid, req: &FollowUpRequest) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}/sessions/{session_id}/follow-up", self.base))
            .json(req)
            .send()
            .await?;
        let _: serde_json::Value = unwrap_api(resp).await?;
        Ok(())
    }

    /// `POST /api/sessions/{id}/queue` — queue a message for after the current turn.
    pub async fn queue_message(
        &self,
        session_id: Uuid,
        req: &QueueRequest,
    ) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}/sessions/{session_id}/queue", self.base))
            .json(req)
            .send()
            .await?;
        let _: serde_json::Value = unwrap_api(resp).await?;
        Ok(())
    }

    /// WS URL for the global pending-approvals stream.
    pub fn approvals_ws(&self) -> String {
        format!("{}/approvals/stream/ws", self.ws_base)
    }

    /// `POST /api/approvals/{id}/respond` — unblock a waiting agent. The body is
    /// the real `utils::approvals::ApprovalResponse` to guarantee wire fidelity.
    pub async fn respond_approval(
        &self,
        approval_id: &str,
        body: &utils::approvals::ApprovalResponse,
    ) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}/approvals/{approval_id}/respond", self.base))
            .json(body)
            .send()
            .await?;
        // Response payload is the resolved ApprovalOutcome; we only need success.
        let _: serde_json::Value = unwrap_api(resp).await?;
        Ok(())
    }
}

/// Deserialize the standard `ApiResponse<T>` envelope and unwrap it into either
/// the data payload or a backend error message.
async fn unwrap_api<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, ApiError> {
    // Use `serde_json::Value` for the error channel so an error payload never
    // fails to deserialize as `T`.
    let body: ApiResponse<T, serde_json::Value> = resp.json().await?;
    if body.is_success() {
        body.into_data().ok_or(ApiError::EmptyData)
    } else {
        let msg = body.message().unwrap_or("unknown error").to_string();
        Err(ApiError::Backend(msg))
    }
}

async fn resolve_base() -> Result<(String, String), ApiError> {
    if let Ok(url) = std::env::var("VIBE_BACKEND_URL") {
        let url = url.trim_end_matches('/').to_string();
        let ws = http_to_ws(&url);
        return Ok((format!("{url}/api"), format!("{ws}/api")));
    }

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = match std::env::var("BACKEND_PORT").or_else(|_| std::env::var("PORT")) {
        Ok(p) => p
            .parse::<u16>()
            .map_err(|e| ApiError::Discovery(format!("invalid port '{p}': {e}")))?,
        Err(_) => utils::port_file::read_port_file("vibe-kanban")
            .await
            .map_err(|e| {
                ApiError::Discovery(format!("no port file — is the backend running? ({e})"))
            })?,
    };

    let http = format!("http://{host}:{port}");
    let ws = format!("ws://{host}:{port}");
    Ok((format!("{http}/api"), format!("{ws}/api")))
}

fn http_to_ws(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        url.to_string()
    }
}
