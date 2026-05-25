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
    CreateAndStartRequest, CreateAndStartResponse, CreateIssueRequest, FollowUpRequest, Issue,
    Project, ProjectStatus, QueueRequest, RemoteWorkspace, Repo, Session, Workspace,
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
    /// `http://host:port` — the local kanban API is mounted at the server root
    /// (`/v1/*`), not under `/api`.
    root_base: String,
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
        let root_base = base.strip_suffix("/api").unwrap_or(&base).to_string();
        Ok(Self {
            http,
            base,
            ws_base,
            root_base,
        })
    }

    /// Construct a client with explicit base URLs, skipping discovery (tests).
    #[cfg(test)]
    pub fn with_base(http_base: impl Into<String>, ws_base: impl Into<String>) -> Self {
        let base: String = http_base.into();
        let root_base = base.strip_suffix("/api").unwrap_or(&base).to_string();
        Self {
            http: reqwest::Client::new(),
            base,
            ws_base: ws_base.into(),
            root_base,
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
        unwrap_api_ok(resp).await
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
        unwrap_api_ok(resp).await
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
        unwrap_api_ok(resp).await
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
        unwrap_api_ok(resp).await
    }

    // ---- local kanban (`/v1/*`, served at the server root) ----

    /// `GET /v1/fallback/projects`.
    pub async fn list_projects(&self) -> Result<Vec<Project>, ApiError> {
        self.fallback_list("/v1/fallback/projects", "projects", &[])
            .await
    }

    /// `GET /v1/fallback/project_statuses?project_id=` — kanban columns.
    pub async fn list_statuses(&self, project_id: Uuid) -> Result<Vec<ProjectStatus>, ApiError> {
        self.fallback_list(
            "/v1/fallback/project_statuses",
            "project_statuses",
            &[("project_id", project_id.to_string())],
        )
        .await
    }

    /// `GET /v1/fallback/issues?project_id=` — kanban cards.
    pub async fn list_issues(&self, project_id: Uuid) -> Result<Vec<Issue>, ApiError> {
        self.fallback_list(
            "/v1/fallback/issues",
            "issues",
            &[("project_id", project_id.to_string())],
        )
        .await
    }

    /// `GET /v1/fallback/project_workspaces?project_id=` — workspaces linked to
    /// any card in the project.
    pub async fn list_project_workspaces(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<RemoteWorkspace>, ApiError> {
        self.fallback_list(
            "/v1/fallback/project_workspaces",
            "workspaces",
            &[("project_id", project_id.to_string())],
        )
        .await
    }

    /// `POST /v1/issues` — create a card.
    pub async fn create_issue(&self, req: &CreateIssueRequest) -> Result<Issue, ApiError> {
        let resp = self
            .http
            .post(format!("{}/v1/issues", self.root_base))
            .json(req)
            .send()
            .await?;
        unwrap_mutation(resp).await
    }

    /// `PATCH /v1/issues/{id}` — partial update (move/edit). `body` is the raw
    /// JSON of the changed fields (matches the backend's present-key semantics).
    pub async fn update_issue(
        &self,
        id: Uuid,
        body: &serde_json::Value,
    ) -> Result<Issue, ApiError> {
        let resp = self
            .http
            .patch(format!("{}/v1/issues/{id}", self.root_base))
            .json(body)
            .send()
            .await?;
        unwrap_mutation(resp).await
    }

    /// `DELETE /v1/issues/{id}`.
    pub async fn delete_issue(&self, id: Uuid) -> Result<(), ApiError> {
        let resp = self
            .http
            .delete(format!("{}/v1/issues/{id}", self.root_base))
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(ApiError::Backend(format!(
                "delete status {}",
                resp.status()
            )))
        }
    }

    /// `POST /api/workspaces/{id}/links` — link a workspace to a kanban issue.
    pub async fn link_workspace_to_issue(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
        issue_id: Uuid,
    ) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}/workspaces/{workspace_id}/links", self.base))
            .json(&serde_json::json!({ "project_id": project_id, "issue_id": issue_id }))
            .send()
            .await?;
        unwrap_api_ok(resp).await
    }

    /// GET a `/v1/fallback/<table>` endpoint and pull the keyed array. These
    /// return a bare `{ "<key>": [...] }` object (not the `ApiResponse` envelope).
    async fn fallback_list<T: DeserializeOwned>(
        &self,
        path: &str,
        key: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<T>, ApiError> {
        let resp = self
            .http
            .get(format!("{}{path}", self.root_base))
            .query(query)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(ApiError::Backend(format!("status {}", resp.status())));
        }
        let mut body: serde_json::Value = resp.json().await?;
        let arr = body
            .get_mut(key)
            .map(serde_json::Value::take)
            .unwrap_or(serde_json::Value::Null);
        serde_json::from_value(arr).map_err(|e| ApiError::Backend(e.to_string()))
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

/// Unwrap an `ApiResponse` for endpoints whose data payload is absent or
/// ignored (e.g. `ApiResponse<()>` serializes `data: null`). Only the success
/// flag matters; a null payload is not an error.
async fn unwrap_api_ok(resp: reqwest::Response) -> Result<(), ApiError> {
    let body: ApiResponse<serde_json::Value, serde_json::Value> = resp.json().await?;
    if body.is_success() {
        Ok(())
    } else {
        Err(ApiError::Backend(
            body.message().unwrap_or("unknown error").to_string(),
        ))
    }
}

/// Unwrap the local kanban `MutationResponse { data, txid }` envelope, returning
/// the `data` payload. (Distinct from the `/api/*` `ApiResponse` envelope.)
async fn unwrap_mutation<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, ApiError> {
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(ApiError::Backend(format!("{status}: {body}")));
    }
    #[derive(serde::Deserialize)]
    struct Mutation<T> {
        data: T,
    }
    let body: Mutation<T> = resp.json().await?;
    Ok(body.data)
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
