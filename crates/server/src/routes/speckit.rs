//! SpecKit (Spec-Driven Development) workbench endpoints.
//!
//! The workbench is a **viewer** over the artifacts the SpecKit pipeline's
//! `/speckit.*` slash commands write into the card's own issue-linked
//! workspace, under `specs/<workspace-branch>/`. It resolves that workspace
//! via the `issue_workspaces` link and anchors every path on the agent's
//! effective working dir (`Session::resolve_agent_working_dir`) so the
//! scaffold, the agent, and the viewer all agree on one base directory. See
//! `services::services::speckit::DESIGN.md` for the full decision record.
//!
//! SpecKit is scoped to single-repo workspaces: a linked workspace with more
//! than one repo has no well-defined "current git branch", so it is surfaced
//! as "not applicable" rather than rendering wrong data.

use std::path::{Path, PathBuf};

use api_types::speckit::{
    ConstitutionContent, SpecKitArtifact, SpecKitArtifacts, SpecKitFeatureStatus, SpecKitTasks,
    ToggleTaskRequest, UpdateArtifactRequest,
};
use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    response::Json as ResponseJson,
    routing::{get, put},
};
use db::models::{
    issue::Issue, issue_workspace::IssueWorkspace, session::Session, workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use services::services::speckit;
use sqlx::SqlitePool;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

const NO_WORKSPACE_NOTE: &str =
    "This card has no workspace yet — start it from the board (pick the SpecKit pipeline).";
const MULTI_REPO_NOTE: &str = "SpecKit supports single-repo workspaces only.";

pub fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let _ = deployment;
    Router::new()
        .route("/speckit/feature/{issue_id}", get(get_feature_status))
        .route("/speckit/feature/{issue_id}/artifacts", get(get_artifacts))
        .route("/speckit/feature/{issue_id}/artifact", put(put_artifact))
        .route(
            "/speckit/feature/{issue_id}/tasks",
            get(get_tasks).patch(patch_task),
        )
        .route(
            "/speckit/feature/{issue_id}/constitution",
            get(get_constitution).put(put_constitution),
        )
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/// The linked workspace for an issue, narrowed to SpecKit's supported shape
/// (single-repo). `NoWorkspace` and `MultiRepo` are both "not set up" from the
/// viewer's perspective, but kept distinct so the frontend copy can say why.
enum WorkspaceResolution {
    Ready(Workspace),
    NoWorkspace,
    MultiRepo,
}

async fn resolve_workspace_for_issue(
    pool: &SqlitePool,
    issue_id: Uuid,
) -> Result<WorkspaceResolution, ApiError> {
    let Some(workspace_id) = IssueWorkspace::find_latest_by_issue(pool, issue_id).await? else {
        return Ok(WorkspaceResolution::NoWorkspace);
    };
    let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await? else {
        return Ok(WorkspaceResolution::NoWorkspace);
    };
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    if repos.len() != 1 {
        return Ok(WorkspaceResolution::MultiRepo);
    }
    Ok(WorkspaceResolution::Ready(workspace))
}

/// Load the issue, its linked single-repo workspace, and the two anchors every
/// endpoint needs: `base_abs` (the agent's effective working dir) and
/// `feature_abs` (`base_abs/specs/<branch>`).
async fn load_feature(
    deployment: &DeploymentImpl,
    issue_id: Uuid,
) -> Result<(Issue, Workspace, PathBuf, PathBuf), ApiError> {
    let pool = &deployment.db().pool;
    let issue = Issue::find_by_id(pool, issue_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Issue not found.".to_string()))?;

    let workspace = match resolve_workspace_for_issue(pool, issue_id).await? {
        WorkspaceResolution::Ready(workspace) => workspace,
        WorkspaceResolution::NoWorkspace | WorkspaceResolution::MultiRepo => {
            return Err(ApiError::BadRequest(
                "No single-repo SpecKit workspace for this issue yet.".to_string(),
            ));
        }
    };

    let container_ref = workspace.container_ref.clone().ok_or_else(|| {
        ApiError::BadRequest("Workspace worktree is not materialized yet.".to_string())
    })?;
    let rel = Session::resolve_agent_working_dir(pool, workspace.id).await?;
    let base_abs = Path::new(&container_ref).join(rel.as_deref().unwrap_or(""));
    let feature_abs = base_abs.join("specs").join(&workspace.branch);

    Ok((issue, workspace, base_abs, feature_abs))
}

// ---------------------------------------------------------------------------
// Feature status
// ---------------------------------------------------------------------------

async fn get_feature_status(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<SpecKitFeatureStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    Issue::find_by_id(pool, issue_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Issue not found.".to_string()))?;

    let workspace = match resolve_workspace_for_issue(pool, issue_id).await? {
        WorkspaceResolution::Ready(workspace) => workspace,
        WorkspaceResolution::NoWorkspace => {
            return Ok(ResponseJson(ApiResponse::success(not_enabled_status(
                issue_id,
                NO_WORKSPACE_NOTE,
            ))));
        }
        WorkspaceResolution::MultiRepo => {
            return Ok(ResponseJson(ApiResponse::success(not_enabled_status(
                issue_id,
                MULTI_REPO_NOTE,
            ))));
        }
    };

    // Best-effort defensive repair: cards created before this change (or
    // whose scaffold write raced/failed) get the `.specify/` scaffold
    // idempotently reprovisioned once the worktree is materialized.
    if let Some(container_ref) = workspace.container_ref.clone() {
        let rel = Session::resolve_agent_working_dir(pool, workspace.id).await?;
        let base_abs = Path::new(&container_ref).join(rel.as_deref().unwrap_or(""));
        if let Err(e) = speckit::ensure_scaffold(&base_abs) {
            tracing::warn!(?e, %issue_id, "Failed to idempotently repair SpecKit scaffold");
        }
    }

    Ok(ResponseJson(ApiResponse::success(SpecKitFeatureStatus {
        issue_id,
        enabled: true,
        note: None,
        workspace_id: Some(workspace.id),
        feature_slug: Some(workspace.branch.clone()),
        feature_dir: Some(speckit::feature_dir(&workspace.branch)),
    })))
}

fn not_enabled_status(issue_id: Uuid, note: &str) -> SpecKitFeatureStatus {
    SpecKitFeatureStatus {
        issue_id,
        enabled: false,
        note: Some(note.to_string()),
        workspace_id: None,
        feature_slug: None,
        feature_dir: None,
    }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

async fn get_artifacts(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<SpecKitArtifacts>>, ApiError> {
    let (_, workspace, _, feature_abs) = load_feature(&deployment, issue_id).await?;

    let artifacts = SpecKitArtifacts {
        feature_dir: speckit::feature_dir(&workspace.branch),
        spec: read_artifact(&feature_abs, "spec.md"),
        plan: read_artifact(&feature_abs, "plan.md"),
        tasks: read_artifact(&feature_abs, "tasks.md"),
        research: read_artifact(&feature_abs, "research.md"),
        data_model: read_artifact(&feature_abs, "data-model.md"),
        quickstart: read_artifact(&feature_abs, "quickstart.md"),
        contracts: read_contracts(&feature_abs),
    };
    Ok(ResponseJson(ApiResponse::success(artifacts)))
}

async fn put_artifact(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
    Json(payload): Json<UpdateArtifactRequest>,
) -> Result<ResponseJson<ApiResponse<SpecKitArtifact>>, ApiError> {
    let (_, _, _, feature_abs) = load_feature(&deployment, issue_id).await?;
    let target = safe_join(&feature_abs, &payload.relative_path)?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, &payload.content)?;

    Ok(ResponseJson(ApiResponse::success(SpecKitArtifact {
        name: file_name_of(&payload.relative_path),
        relative_path: payload.relative_path,
        content: Some(payload.content),
        exists: true,
    })))
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async fn get_tasks(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<SpecKitTasks>>, ApiError> {
    let (_, _, _, feature_abs) = load_feature(&deployment, issue_id).await?;
    let text = std::fs::read_to_string(feature_abs.join("tasks.md")).unwrap_or_default();
    Ok(ResponseJson(ApiResponse::success(speckit::parse_tasks_md(
        &text,
    ))))
}

async fn patch_task(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
    Json(payload): Json<ToggleTaskRequest>,
) -> Result<ResponseJson<ApiResponse<SpecKitTasks>>, ApiError> {
    let (_, _, _, feature_abs) = load_feature(&deployment, issue_id).await?;
    let tasks_path = feature_abs.join("tasks.md");
    let text = std::fs::read_to_string(&tasks_path)
        .map_err(|_| ApiError::BadRequest("tasks.md does not exist yet.".to_string()))?;
    let updated = speckit::toggle_task(&text, &payload.task_id, payload.done);
    std::fs::write(&tasks_path, &updated)?;
    Ok(ResponseJson(ApiResponse::success(speckit::parse_tasks_md(
        &updated,
    ))))
}

// ---------------------------------------------------------------------------
// Constitution (repo-level, scoped to the workspace's agent-cwd base)
// ---------------------------------------------------------------------------

async fn get_constitution(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<ConstitutionContent>>, ApiError> {
    let (_, _, base_abs, _) = load_feature(&deployment, issue_id).await?;
    let path = base_abs.join(speckit::CONSTITUTION_REL_PATH);
    let content = std::fs::read_to_string(&path).ok();
    Ok(ResponseJson(ApiResponse::success(ConstitutionContent {
        exists: content.is_some(),
        content: content.unwrap_or_default(),
    })))
}

async fn put_constitution(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
    Json(payload): Json<ConstitutionContent>,
) -> Result<ResponseJson<ApiResponse<ConstitutionContent>>, ApiError> {
    let (_, _, base_abs, _) = load_feature(&deployment, issue_id).await?;
    let path = base_abs.join(speckit::CONSTITUTION_REL_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &payload.content)?;
    Ok(ResponseJson(ApiResponse::success(ConstitutionContent {
        content: payload.content,
        exists: true,
    })))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_artifact(feature_abs: &Path, name: &str) -> SpecKitArtifact {
    let path = feature_abs.join(name);
    let content = std::fs::read_to_string(&path).ok();
    SpecKitArtifact {
        name: name.to_string(),
        relative_path: name.to_string(),
        exists: content.is_some(),
        content,
    }
}

fn read_contracts(feature_abs: &Path) -> Vec<SpecKitArtifact> {
    let dir = feature_abs.join("contracts");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    let mut files: Vec<_> = entries.flatten().filter(|e| e.path().is_file()).collect();
    files.sort_by_key(|e| e.file_name());
    for entry in files {
        let name = entry.file_name().to_string_lossy().to_string();
        let content = std::fs::read_to_string(entry.path()).ok();
        out.push(SpecKitArtifact {
            relative_path: format!("contracts/{name}"),
            exists: content.is_some(),
            content,
            name,
        });
    }
    out
}

/// Join a caller-supplied relative path to a base dir, rejecting traversal.
#[allow(clippy::result_large_err)]
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, ApiError> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err(ApiError::BadRequest("Empty path.".to_string()));
    }
    let candidate = Path::new(rel);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(ApiError::BadRequest("Invalid artifact path.".to_string()));
    }
    Ok(base.join(candidate))
}

fn file_name_of(rel: &str) -> String {
    Path::new(rel)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| rel.to_string())
}
