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
    /// When true, run the agent in an interactive terminal (detached tmux).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
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

// ---------------------------------------------------------------------------
// Kanban (local projects) — mirrors of the `/v1/*` wire shapes.
// ---------------------------------------------------------------------------

/// Mirror of the wire `Project` (served at `/v1/fallback/projects`). The
/// per-project issue `key` is not exposed by that endpoint, so it is omitted.
#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub sort_order: i64,
}

/// Mirror of `db::models::project_status::ProjectStatus` (a kanban column).
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectStatus {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub hidden: bool,
}

/// Mirror of the wire `Issue` (a kanban card). Subset used for display.
/// `priority` arrives as a lowercase string (`urgent`/`high`/`medium`/`low`).
#[derive(Debug, Clone, Deserialize)]
pub struct Issue {
    pub id: Uuid,
    pub project_id: Uuid,
    pub status_id: Uuid,
    pub simple_id: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<String>,
    #[serde(default)]
    pub sort_order: f64,
    pub parent_issue_id: Option<Uuid>,
}

/// Mirror of the remote `Workspace` rows returned by
/// `/v1/fallback/project_workspaces` — i.e. workspaces linked to an issue.
#[derive(Debug, Clone, Deserialize)]
pub struct RemoteWorkspace {
    pub id: Uuid,
    pub issue_id: Option<Uuid>,
    pub local_workspace_id: Option<Uuid>,
    pub name: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

/// Body for `POST /v1/issues`. Carries all fields the backend requires
/// (`project_id`, `status_id`, `title`, `sort_order`, `extension_metadata`).
#[derive(Debug, Serialize)]
pub struct CreateIssueRequest {
    pub project_id: Uuid,
    pub status_id: Uuid,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    pub sort_order: f64,
    pub extension_metadata: serde_json::Value,
}

/// Priorities offered by the card form; index 0 means "none" (field omitted).
pub const PRIORITIES: &[&str] = &["none", "urgent", "high", "medium", "low"];

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

// ---------------------------------------------------------------------------
// Git operations (workspace detail view) — mirrors of `/api/.../git/*` and the
// workspace-summary wire shapes.
// ---------------------------------------------------------------------------

/// Mirror of `RepoBranchStatus` (with the flattened `BranchStatus`) from
/// `GET /api/workspaces/{id}/git/status` — one entry per repo in the workspace.
#[derive(Debug, Clone, Deserialize)]
pub struct GitRepoStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    pub commits_ahead: Option<usize>,
    pub commits_behind: Option<usize>,
    pub remote_commits_ahead: Option<usize>,
    pub remote_commits_behind: Option<usize>,
    pub has_uncommitted_changes: Option<bool>,
    pub uncommitted_count: Option<usize>,
    pub target_branch_name: String,
    #[serde(default)]
    pub is_rebase_in_progress: bool,
    /// `"rebase"` or `"merge"` while a conflict is being resolved.
    pub conflict_op: Option<String>,
    #[serde(default)]
    pub conflicted_files: Vec<String>,
    #[serde(default)]
    pub is_target_remote: bool,
}

/// Subset of `WorkspaceSummary` (`POST /api/workspaces/summaries`) used to show
/// per-workspace diff stats and PR state in the detail view.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceSummary {
    pub workspace_id: Uuid,
    pub files_changed: Option<usize>,
    pub lines_added: Option<usize>,
    pub lines_removed: Option<usize>,
    /// `open` / `merged` / `closed` / `none`.
    pub pr_status: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
}

/// Body for the repo-only git endpoints (`/git/merge`, `/git/push`,
/// `/git/push/force`).
#[derive(Debug, Serialize)]
pub struct RepoIdRequest {
    pub repo_id: Uuid,
}

/// Body for `POST /api/workspaces/{id}/git/rebase`. `None` bases default to the
/// workspace's current target branch on the backend.
#[derive(Debug, Serialize)]
pub struct RebaseRequest {
    pub repo_id: Uuid,
    pub old_base_branch: Option<String>,
    pub new_base_branch: Option<String>,
}

/// Body for `POST /api/workspaces/{id}/pull-requests`.
#[derive(Debug, Serialize)]
pub struct CreatePrRequest {
    pub title: String,
    pub body: Option<String>,
    pub target_branch: Option<String>,
    pub draft: Option<bool>,
    pub repo_id: Uuid,
    pub auto_generate_description: bool,
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
