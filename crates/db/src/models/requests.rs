use executors::profile::ExecutorConfig;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use super::{
    execution_process::ExecutionProcess,
    workspace::{Workspace, WorkspaceKind},
};

#[derive(Debug, Deserialize, Serialize)]
pub struct ContainerQuery {
    #[serde(rename = "ref")]
    pub container_ref: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct WorkspaceRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateWorkspaceApiRequest {
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct LinkedIssueInfo {
    pub remote_project_id: Uuid,
    pub issue_id: Uuid,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateAndStartWorkspaceRequest {
    pub name: Option<String>,
    pub repos: Vec<WorkspaceRepoInput>,
    pub linked_issue: Option<LinkedIssueInfo>,
    pub executor_config: ExecutorConfig,
    pub prompt: String,
    pub attachment_ids: Option<Vec<Uuid>>,
    /// Discriminator for special-purpose workspaces (e.g. `orchestrator`).
    /// Omitted by older clients and the MCP crate; defaults to a normal
    /// workspace.
    #[serde(default)]
    #[ts(optional)]
    pub kind: Option<WorkspaceKind>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateAndStartWorkspaceResponse {
    pub workspace: Workspace,
    pub execution_process: ExecutionProcess,
}

/// Spawn (or reuse) the singleton orchestrator: a repo-independent, headed
/// Claude Code session that drives the board on a loop from a fixed folder.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct SpawnOrchestratorRequest {
    /// The `/loop`-wrapped orchestration brief composed from the enabled
    /// directives.
    pub prompt: String,
    /// Display name for the orchestrator workspace; defaults to "Orchestrator".
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct SpawnOrchestratorResponse {
    pub workspace: Workspace,
    /// True when an already-running orchestrator was returned instead of
    /// starting a new session (its live tmux session is reused).
    pub reused: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CloseOrchestratorResponse {
    /// True when a running orchestrator session was stopped; false when there
    /// was no orchestrator (or no live session) to close.
    pub closed: bool,
}

/// Request to expand a rough brief into a development-ready technical task by
/// running a coding agent in a throwaway (ephemeral) multi-repo workspace.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GenerateSpecRequest {
    /// Project the card will belong to. Provenance/context only — the local
    /// backend does not validate remote repo membership against it.
    pub project_id: Uuid,
    /// The rough, minimal task brief from the user.
    pub brief: String,
    /// Selected agent parameters (executor/variant/model), same shape as
    /// the create-workspace flow.
    pub executor_config: ExecutorConfig,
    /// Repos (with target branch) to mount in the ephemeral workspace so the
    /// agent can explore the codebase.
    pub repos: Vec<WorkspaceRepoInput>,
}

/// Result of a spec-intake generation: a title + full markdown spec to pre-fill
/// the New Issue dialog, plus the provenance object to store in the issue's
/// `extension_metadata` on create.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct GenerateSpecResponse {
    pub title: String,
    pub description: String,
    /// `{ "intake": { brief, executor_config, repos } }` — drop verbatim into
    /// `CreateIssueRequest.extension_metadata`.
    pub intake_metadata: serde_json::Value,
}

/// Create a SpecKit feature: a persistent workspace whose branch is the feature
/// slug (`NNN-feature-slug`) for an existing kanban issue, with the `.specify/`
/// scaffold provisioned into each repo worktree.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateSpecKitFeatureRequest {
    /// The kanban issue this feature belongs to. Its number + title derive the
    /// feature slug and branch.
    pub issue_id: Uuid,
    /// Repos (with target branch) to mount in the feature workspace.
    pub repos: Vec<WorkspaceRepoInput>,
    /// Agent parameters used when running SpecKit stages for this feature.
    pub executor_config: ExecutorConfig,
}

/// Result of creating a SpecKit feature.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct CreateSpecKitFeatureResponse {
    pub workspace: Workspace,
    /// `NNN-feature-slug` (also the workspace branch).
    pub feature_slug: String,
    /// `specs/NNN-feature-slug`, relative to the repo root.
    pub feature_dir: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct UpdateWorkspace {
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
pub struct UpdateSession {
    pub name: Option<String>,
}
