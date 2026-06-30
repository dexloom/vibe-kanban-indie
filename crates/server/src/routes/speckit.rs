//! SpecKit (Spec-Driven Development) workbench endpoints.
//!
//! A SpecKit *feature* is a kanban issue plus a persistent workspace whose
//! branch is the feature slug (`NNN-feature-slug`). SpecKit artifacts live in
//! that workspace's repo worktree under `specs/NNN-feature-slug/`, committed
//! alongside the code. Stage runs reuse the same one-shot coding-agent machinery
//! as spec-intake (`start_oneshot_coding_agent`), but persist the workspace and
//! read the produced artifacts back off disk instead of parsing a message.

use std::path::{Path, PathBuf};

use api_types::speckit::{
    ConstitutionContent, RunStageRequest, RunStageResponse, SpecKitArtifact, SpecKitArtifacts,
    SpecKitFeatureStatus, SpecKitTasks, ToggleTaskRequest, UpdateArtifactRequest,
};
use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    response::Json as ResponseJson,
    routing::{get, post, put},
};
use db::models::{
    issue::{Issue, IssueUpdate},
    issue_workspace::IssueWorkspace,
    requests::{CreateSpecKitFeatureRequest, CreateSpecKitFeatureResponse, WorkspaceRepoInput},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::profile::ExecutorConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::{container::ContainerService, speckit};
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router(deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    let _ = deployment;
    Router::new()
        .route("/speckit/feature", post(create_feature))
        .route("/speckit/feature/{issue_id}", get(get_feature_status))
        .route("/speckit/feature/{issue_id}/stage", post(run_stage))
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

/// Per-issue SpecKit state, persisted under `extension_metadata.speckit`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpecKitMeta {
    enabled: bool,
    workspace_id: Uuid,
    /// `NNN-feature-slug` (also the workspace branch).
    feature_slug: String,
    /// `specs/NNN-feature-slug`, relative to the repo root.
    feature_dir: String,
    /// The primary repo's name (its worktree dir under the container).
    repo_name: String,
    /// Agent parameters used to run SpecKit stages for this feature.
    executor_config: ExecutorConfig,
}

// ---------------------------------------------------------------------------
// Create feature
// ---------------------------------------------------------------------------

async fn create_feature(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateSpecKitFeatureRequest>,
) -> Result<ResponseJson<ApiResponse<CreateSpecKitFeatureResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let CreateSpecKitFeatureRequest {
        issue_id,
        repos,
        executor_config,
    } = payload;

    if repos.is_empty() {
        return Err(ApiError::BadRequest(
            "At least one repository is required.".to_string(),
        ));
    }
    validate_repos(&repos)?;

    let issue = Issue::find_by_id(pool, issue_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Issue not found.".to_string()))?;

    let feature_slug = speckit::feature_slug(issue.issue_number, &issue.title);
    let feature_dir = speckit::feature_dir(&feature_slug);

    // Persistent (non-ephemeral) workspace on the feature branch.
    let workspace_id = Uuid::new_v4();
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: feature_slug.clone(),
            name: Some(format!("SpecKit: {}", issue.title)),
            kind: None,
        },
        workspace_id,
    )
    .await?;

    let mut managed = deployment
        .workspace_manager()
        .load_managed_workspace(workspace)
        .await?;
    for repo in &repos {
        managed
            .add_repository(repo, deployment.git())
            .await
            .map_err(ApiError::from)?;
    }
    let workspace = managed.workspace.clone();

    // Materialize the worktrees on disk so we can provision the scaffold.
    deployment.container().create(&workspace).await?;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Workspace disappeared after creation.".to_string()))?;

    let container_ref = workspace
        .container_ref
        .clone()
        .ok_or_else(|| ApiError::BadRequest("Workspace has no worktree.".to_string()))?;
    let repo_rows = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await?;
    let primary = repo_rows
        .first()
        .ok_or_else(|| ApiError::BadRequest("Workspace has no repositories.".to_string()))?;

    // Provision the .specify scaffold into every repo worktree (idempotent).
    for repo in &repo_rows {
        let repo_path = Path::new(&container_ref).join(&repo.name);
        speckit::ensure_scaffold(&repo_path)?;
    }

    IssueWorkspace::link(pool, issue_id, workspace_id).await?;

    let meta = SpecKitMeta {
        enabled: true,
        workspace_id,
        feature_slug: feature_slug.clone(),
        feature_dir: feature_dir.clone(),
        repo_name: primary.name.clone(),
        executor_config,
    };
    persist_meta(pool, &issue, &meta).await?;

    Ok(ResponseJson(ApiResponse::success(
        CreateSpecKitFeatureResponse {
            workspace,
            feature_slug,
            feature_dir,
        },
    )))
}

// ---------------------------------------------------------------------------
// Feature status
// ---------------------------------------------------------------------------

async fn get_feature_status(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<SpecKitFeatureStatus>>, ApiError> {
    let pool = &deployment.db().pool;
    let issue = Issue::find_by_id(pool, issue_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Issue not found.".to_string()))?;

    let status = match read_meta(&issue) {
        Some(meta) => SpecKitFeatureStatus {
            issue_id,
            enabled: true,
            workspace_id: Some(meta.workspace_id),
            feature_slug: Some(meta.feature_slug),
            feature_dir: Some(meta.feature_dir),
        },
        None => SpecKitFeatureStatus {
            issue_id,
            enabled: false,
            workspace_id: None,
            feature_slug: None,
            feature_dir: None,
        },
    };
    Ok(ResponseJson(ApiResponse::success(status)))
}

// ---------------------------------------------------------------------------
// Run a stage
// ---------------------------------------------------------------------------

async fn run_stage(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
    Json(payload): Json<RunStageRequest>,
) -> Result<ResponseJson<ApiResponse<RunStageResponse>>, ApiError> {
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;

    // Best-effort idempotent scaffold refresh (the worktree already exists).
    if let Some(container_ref) = &workspace.container_ref {
        let repo_path = Path::new(container_ref).join(&meta.repo_name);
        let _ = speckit::ensure_scaffold(&repo_path);
    }

    let prompt = speckit::stage_prompt(payload.stage, payload.input.as_deref());
    let ep = deployment
        .container()
        .start_oneshot_coding_agent(&workspace, meta.executor_config.clone(), prompt)
        .await?;

    Ok(ResponseJson(ApiResponse::success(RunStageResponse {
        stage: payload.stage,
        execution_process_id: ep.id,
        session_id: ep.session_id,
    })))
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

async fn get_artifacts(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<SpecKitArtifacts>>, ApiError> {
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;
    let (_, feature_abs) = resolve_paths(&workspace, &meta)?;

    let artifacts = SpecKitArtifacts {
        feature_dir: meta.feature_dir.clone(),
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
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;
    let (_, feature_abs) = resolve_paths(&workspace, &meta)?;
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
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;
    let (_, feature_abs) = resolve_paths(&workspace, &meta)?;
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
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;
    let (_, feature_abs) = resolve_paths(&workspace, &meta)?;
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
// Constitution (repo-level, scoped to the feature's primary repo worktree)
// ---------------------------------------------------------------------------

async fn get_constitution(
    State(deployment): State<DeploymentImpl>,
    AxumPath(issue_id): AxumPath<Uuid>,
) -> Result<ResponseJson<ApiResponse<ConstitutionContent>>, ApiError> {
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;
    let (repo_abs, _) = resolve_paths(&workspace, &meta)?;
    let path = repo_abs.join(speckit::CONSTITUTION_REL_PATH);
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
    let (_, meta, workspace) = load_feature(&deployment, issue_id).await?;
    let (repo_abs, _) = resolve_paths(&workspace, &meta)?;
    let path = repo_abs.join(speckit::CONSTITUTION_REL_PATH);
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

fn validate_repos(repos: &[WorkspaceRepoInput]) -> Result<(), ApiError> {
    if repos.iter().any(|r| r.target_branch.trim().is_empty()) {
        return Err(ApiError::BadRequest(
            "Each repository needs a target branch.".to_string(),
        ));
    }
    Ok(())
}

/// Load the issue, its SpecKit metadata, and the feature workspace.
async fn load_feature(
    deployment: &DeploymentImpl,
    issue_id: Uuid,
) -> Result<(Issue, SpecKitMeta, Workspace), ApiError> {
    let pool = &deployment.db().pool;
    let issue = Issue::find_by_id(pool, issue_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Issue not found.".to_string()))?;
    let meta = read_meta(&issue)
        .ok_or_else(|| ApiError::BadRequest("This issue is not a SpecKit feature.".to_string()))?;
    let workspace = Workspace::find_by_id(pool, meta.workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("SpecKit workspace not found.".to_string()))?;
    Ok((issue, meta, workspace))
}

fn read_meta(issue: &Issue) -> Option<SpecKitMeta> {
    let value = issue.extension_metadata.get("speckit")?.clone();
    serde_json::from_value(value).ok()
}

async fn persist_meta(
    pool: &sqlx::SqlitePool,
    issue: &Issue,
    meta: &SpecKitMeta,
) -> Result<(), ApiError> {
    let mut metadata = issue.extension_metadata.clone();
    if !metadata.is_object() {
        metadata = json!({});
    }
    metadata["speckit"] = serde_json::to_value(meta).unwrap_or(Value::Null);
    let extension_metadata = serde_json::to_string(&metadata)
        .map_err(|e| ApiError::BadRequest(format!("Failed to serialize SpecKit metadata: {e}")))?;

    let update = IssueUpdate {
        status_id: issue.status_id,
        title: &issue.title,
        description: issue.description.as_deref(),
        priority: issue.priority.as_deref(),
        start_date: issue.start_date,
        target_date: issue.target_date,
        completed_at: issue.completed_at,
        sort_order: issue.sort_order,
        parent_issue_id: issue.parent_issue_id,
        parent_issue_sort_order: issue.parent_issue_sort_order,
        extension_metadata: &extension_metadata,
    };
    Issue::update(pool, issue.id, update).await?;
    Ok(())
}

/// Resolve `(repo_root_abs, feature_dir_abs)` for a feature.
fn resolve_paths(
    workspace: &Workspace,
    meta: &SpecKitMeta,
) -> Result<(PathBuf, PathBuf), ApiError> {
    let container_ref = workspace.container_ref.as_ref().ok_or_else(|| {
        ApiError::BadRequest("Workspace worktree is not materialized yet.".to_string())
    })?;
    let repo_abs = Path::new(container_ref).join(&meta.repo_name);
    let feature_abs = repo_abs.join(&meta.feature_dir);
    Ok((repo_abs, feature_abs))
}

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
