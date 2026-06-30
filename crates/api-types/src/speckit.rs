//! Shared types for the SpecKit (Spec-Driven Development) workbench.
//!
//! These are the pure domain types exchanged between the local backend and the
//! web frontend. Request types that additionally reference an `ExecutorConfig`
//! or `WorkspaceRepoInput` (e.g. creating a feature workspace) live in
//! `db::models::requests` instead, mirroring `GenerateSpecRequest`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// The ordered stages of the SpecKit workflow, in the order they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpecKitStage {
    Constitution,
    Specify,
    Clarify,
    Plan,
    Tasks,
    Analyze,
    Implement,
}

impl SpecKitStage {
    /// All stages in workflow order.
    pub const ALL: [SpecKitStage; 7] = [
        SpecKitStage::Constitution,
        SpecKitStage::Specify,
        SpecKitStage::Clarify,
        SpecKitStage::Plan,
        SpecKitStage::Tasks,
        SpecKitStage::Analyze,
        SpecKitStage::Implement,
    ];
}

/// Status of a single SpecKit stage for a feature, surfaced as a badge in the
/// stage rail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SpecKitStageState {
    /// Not started yet.
    Idle,
    /// An agent run for this stage is currently executing.
    Running,
    /// The stage's artifact exists and the stage is considered complete.
    Done,
    /// The stage ran but flagged something the operator should look at
    /// (e.g. clarify raised open questions, analyze found inconsistencies).
    NeedsAttention,
}

/// A single task parsed out of `tasks.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SpecKitTask {
    /// Task identifier as written in tasks.md (e.g. "T001"). Falls back to the
    /// 1-based ordinal when the source line has no explicit id.
    pub id: String,
    /// Human-readable task description (the text after the id/marker).
    pub description: String,
    /// File paths referenced in the task line, when present.
    pub file_paths: Vec<String>,
    /// True when the task is marked `[P]` (safe to run in parallel).
    pub parallelizable: bool,
    /// Phase / user-story heading the task is grouped under, if any.
    #[ts(optional)]
    pub phase: Option<String>,
    /// Whether the task's checkbox is ticked (`[x]`).
    pub done: bool,
}

/// A group of tasks that can run concurrently — one "column" in the dependency
/// graph. Layers are ordered; every task in layer N conceptually depends on
/// layer N-1 having completed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SpecKitTaskLayer {
    /// Task ids that make up this layer.
    pub task_ids: Vec<String>,
    /// True when the layer holds more than one task (i.e. real parallelism).
    pub parallel: bool,
}

/// Parsed `tasks.md` plus the derived parallel-execution layering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SpecKitTasks {
    pub tasks: Vec<SpecKitTask>,
    /// Ordered parallel layers derived from `[P]` markers + task order.
    pub layers: Vec<SpecKitTaskLayer>,
    pub total: u32,
    pub completed: u32,
}

/// One SpecKit artifact file. `content` is `None` when the file does not exist
/// yet on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SpecKitArtifact {
    /// Display name / filename (e.g. "spec.md").
    pub name: String,
    /// Path relative to the feature dir (e.g. "contracts/api-spec.json").
    pub relative_path: String,
    #[ts(optional)]
    pub content: Option<String>,
    pub exists: bool,
}

/// The full set of SpecKit artifacts for one feature, read off the worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SpecKitArtifacts {
    /// Feature dir relative to the repo root, e.g. "specs/001-webhook-retries".
    pub feature_dir: String,
    pub spec: SpecKitArtifact,
    pub plan: SpecKitArtifact,
    pub tasks: SpecKitArtifact,
    pub research: SpecKitArtifact,
    pub data_model: SpecKitArtifact,
    pub quickstart: SpecKitArtifact,
    /// Contract files under `contracts/` (json / markdown), if any.
    pub contracts: Vec<SpecKitArtifact>,
}

/// Request body to (re)run a SpecKit stage as a one-shot agent in the feature's
/// workspace.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RunStageRequest {
    pub stage: SpecKitStage,
    /// Free-form input for the stage: the feature description for `specify`,
    /// the clarification answers for `clarify`, etc.
    #[serde(default)]
    #[ts(optional)]
    pub input: Option<String>,
}

/// Identifiers for the agent run a stage kicked off, so the frontend can stream
/// its transcript/diffs over the existing WebSocket channels.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RunStageResponse {
    pub stage: SpecKitStage,
    pub execution_process_id: Uuid,
    pub session_id: Uuid,
}

/// Write an edited artifact back to disk.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpdateArtifactRequest {
    /// Path relative to the feature dir (e.g. "spec.md", "contracts/api.json").
    pub relative_path: String,
    pub content: String,
}

/// Toggle a single task's checkbox in `tasks.md`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ToggleTaskRequest {
    pub task_id: String,
    pub done: bool,
}

/// The project-wide constitution (`.specify/memory/constitution.md`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ConstitutionContent {
    pub content: String,
    pub exists: bool,
}

/// Whether an issue is a SpecKit feature, and (if so) its workspace + slug.
/// Returned even for non-feature issues (`enabled: false`) so the workbench can
/// render its "set up SpecKit" form.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SpecKitFeatureStatus {
    pub issue_id: Uuid,
    pub enabled: bool,
    #[ts(optional)]
    pub workspace_id: Option<Uuid>,
    #[ts(optional)]
    pub feature_slug: Option<String>,
    #[ts(optional)]
    pub feature_dir: Option<String>,
}

/// A single finding from the `analyze` stage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AnalyzeFinding {
    /// "error" | "warning" | "info".
    pub severity: String,
    pub message: String,
    /// The artifact the finding points at, when known (e.g. "spec.md").
    #[ts(optional)]
    pub artifact: Option<String>,
}
