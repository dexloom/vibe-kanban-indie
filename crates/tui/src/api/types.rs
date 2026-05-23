//! Client-side mirror structs for backend display payloads.
//!
//! These are deserialize-only mirrors of types that live in `db`/`executors`/
//! `services`, kept here so the TUI does not depend on those heavy crates. The
//! safety-critical *write-path* types (`ApprovalResponse`, `ApprovalOutcome`,
//! `QuestionAnswer`) are reused directly from `utils::approvals` rather than
//! mirrored. A drift contract test (see tests) guards these shapes against
//! backend changes.
//!
//! Field names mirror the backend structs exactly; unknown fields are ignored
//! by serde, so backend-side additions are non-breaking.
//!
//! Some fields are deserialized for fidelity (and to make the drift contract
//! test meaningful) but not yet rendered, hence the module-level allow.
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Mirror of `db::models::workspace::Workspace`.
#[derive(Debug, Clone, Deserialize)]
pub struct Workspace {
    pub id: Uuid,
    pub task_id: Option<Uuid>,
    pub container_ref: Option<String>,
    pub branch: String,
    pub setup_completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived: bool,
    pub pinned: bool,
    pub name: Option<String>,
    pub worktree_deleted: bool,
}

impl Workspace {
    /// Human-friendly label: the name if set, else the branch.
    pub fn label(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.branch)
    }
}

/// Mirror of `db::models::session::Session`.
#[derive(Debug, Clone, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: Option<String>,
    pub executor: Option<String>,
    pub agent_working_dir: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Session {
    pub fn label(&self) -> String {
        match (&self.name, &self.executor) {
            (Some(n), Some(e)) => format!("{n} · {e}"),
            (Some(n), None) => n.clone(),
            (None, Some(e)) => e.clone(),
            (None, None) => self.id.to_string(),
        }
    }
}

/// Mirror of `db::models::execution_process::ExecutionProcessRunReason`
/// (serde `rename_all = "lowercase"`, so variants concatenate, e.g.
/// `CodingAgent` → `"codingagent"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunReason {
    SetupScript,
    CleanupScript,
    ArchiveScript,
    CodingAgent,
    DevServer,
}

/// Mirror of `db::models::execution_process::ExecutionProcessStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcStatus {
    Running,
    Completed,
    Failed,
    Killed,
}

impl ProcStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, ProcStatus::Running)
    }
}

/// Mirror of `db::models::repo::Repo` (subset needed for the create form).
#[derive(Debug, Clone, Deserialize)]
pub struct Repo {
    pub id: Uuid,
    pub name: String,
    pub display_name: String,
    pub default_target_branch: Option<String>,
}

impl Repo {
    pub fn label(&self) -> &str {
        if self.display_name.is_empty() {
            &self.name
        } else {
            &self.display_name
        }
    }
}

/// Outbound `ExecutorConfig` — the `executor` field accepts the SCREAMING_SNAKE
/// agent name (e.g. `CLAUDE_CODE`); variant/model are left to backend defaults.
#[derive(Debug, Clone, Serialize)]
pub struct ExecutorConfigInput {
    pub executor: String,
}

impl ExecutorConfigInput {
    pub fn new(executor: impl Into<String>) -> Self {
        Self {
            executor: executor.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct WorkspaceRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

/// Body for `POST /api/workspaces/start`.
#[derive(Debug, Serialize)]
pub struct CreateAndStartRequest {
    pub name: Option<String>,
    pub repos: Vec<WorkspaceRepoInput>,
    pub linked_issue: Option<serde_json::Value>,
    pub executor_config: ExecutorConfigInput,
    pub prompt: String,
    pub attachment_ids: Option<Vec<Uuid>>,
}

/// Response from `POST /api/workspaces/start`.
#[derive(Debug, Deserialize)]
pub struct CreateAndStartResponse {
    pub workspace: Workspace,
    pub execution_process: ExecutionProcess,
}

/// Body for `POST /api/sessions/{id}/follow-up`.
#[derive(Debug, Serialize)]
pub struct FollowUpRequest {
    pub prompt: String,
    pub executor_config: ExecutorConfigInput,
}

/// Body for `POST /api/sessions/{id}/queue`.
#[derive(Debug, Serialize)]
pub struct QueueRequest {
    pub message: String,
    pub executor_config: ExecutorConfigInput,
}

/// The coding agents the create form offers (mirrors `BaseCodingAgent`).
pub const EXECUTORS: &[&str] = &[
    "CLAUDE_CODE",
    "CODEX",
    "GEMINI",
    "AMP",
    "OPENCODE",
    "CURSOR_AGENT",
    "QWEN_CODE",
    "COPILOT",
    "DROID",
];

/// Mirror of `services::services::approvals::ApprovalInfo` — one pending
/// approval as broadcast on `/api/approvals/stream/ws`.
#[derive(Debug, Clone, Deserialize)]
pub struct ApprovalInfo {
    pub approval_id: String,
    pub tool_name: String,
    pub execution_process_id: Uuid,
    pub is_question: bool,
    pub created_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
}

/// Mirror of `db::models::execution_process::ExecutionProcess`. `executor_action`
/// is intentionally omitted (not needed for display; serde ignores it).
#[derive(Debug, Clone, Deserialize)]
pub struct ExecutionProcess {
    pub id: Uuid,
    pub session_id: Uuid,
    pub run_reason: RunReason,
    pub status: ProcStatus,
    pub exit_code: Option<i64>,
    pub dropped: bool,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
