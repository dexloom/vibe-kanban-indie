//! Local kanban API.
//!
//! Re-homes the hosted kanban (projects, issues, statuses, tags, assignees)
//! onto local SQLite so the existing frontend works with no cloud account. The
//! frontend's built-in fallback transport reads from `/v1/fallback/<table>`
//! (returning `{ "<table>": [...] }`) and mutates via `/v1/<table>` (returning
//! `{ data, txid }`). ElectricSQL is not involved; a monotonic local `txid`
//! satisfies the optimistic-update handshake.

use std::sync::atomic::{AtomicI64, Ordering};

use api_types::{
    CreateIssueAssigneeRequest, CreateIssueRequest, CreateIssueTagRequest, CreateProjectRequest,
    CreateProjectStatusRequest, CreateTagRequest, DeleteResponse, IssuePriority,
    ListMembersResponse, ListOrganizationsResponse, MemberRole, MutationResponse,
    OrganizationMemberWithProfile, OrganizationWithRole, Project as ApiProject, UpdateIssueRequest,
    UpdateProjectRequest, UpdateProjectStatusRequest, UpdateTagRequest, Workspace as ApiWorkspace,
};
use axum::{
    Router,
    extract::{Path, Query, State},
    response::Json as ResponseJson,
    routing::{get, patch, post},
};
use chrono::Utc;
use db::models::{
    issue::{Issue as DbIssue, IssueUpdate, NewIssue},
    issue_workspace::{IssueWorkspace, LinkedWorkspaceRow},
    kanban_tag::{IssueAssignee as DbIssueAssignee, IssueTag as DbIssueTag, KanbanTag},
    local_user::{LOCAL_USER_ID, LocalUser},
    project::{LOCAL_ORGANIZATION_ID, Project as DbProject},
    project_repo::ProjectRepo,
    project_status::ProjectStatus as DbProjectStatus,
    repo::Repo as DbRepo,
};
use deployment::Deployment;
use serde::Deserialize;
use serde_json::{Value, json};
use services::services::project_config;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

/// Process-local monotonic transaction id. The frontend awaits an increasing
/// txid to drop optimistic state; in fallback mode it re-polls regardless.
static TXID: AtomicI64 = AtomicI64::new(1);
fn next_txid() -> i64 {
    TXID.fetch_add(1, Ordering::Relaxed)
}

fn mutation<T>(data: T) -> ResponseJson<MutationResponse<T>> {
    ResponseJson(MutationResponse {
        data,
        txid: next_txid(),
    })
}

fn deleted() -> ResponseJson<DeleteResponse> {
    ResponseJson(DeleteResponse { txid: next_txid() })
}

fn priority_str(p: &IssuePriority) -> &'static str {
    match p {
        IssuePriority::Urgent => "urgent",
        IssuePriority::High => "high",
        IssuePriority::Medium => "medium",
        IssuePriority::Low => "low",
    }
}

fn to_api_project(p: DbProject) -> ApiProject {
    ApiProject {
        id: p.id,
        organization_id: LOCAL_ORGANIZATION_ID,
        name: p.name,
        color: p.color,
        sort_order: p.sort_order as i32,
        created_at: p.created_at,
        updated_at: p.updated_at,
    }
}

#[derive(Debug, Deserialize)]
struct ProjectScope {
    project_id: Uuid,
}

// ---------------------------------------------------------------------------
// Fallback reads — return `{ "<table>": [rows] }`.
// ---------------------------------------------------------------------------

async fn fb_projects(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<Value>, ApiError> {
    let projects = DbProject::find_all(&deployment.db().pool).await?;
    let mapped: Vec<ApiProject> = projects.into_iter().map(to_api_project).collect();
    Ok(ResponseJson(json!({ "projects": mapped })))
}

async fn fb_users(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<Value>, ApiError> {
    let users = LocalUser::list_all(&deployment.db().pool).await?;
    Ok(ResponseJson(json!({ "users": users })))
}

/// `GET /v1/projects/{id}/repos` — the repos linked to a project (via the
/// `project_repos` table; managed by the link/unlink endpoints below). Used by
/// the TUI to default a card-launched workspace to the project's repo. Returns
/// the full repo rows under `{ "repos": [...] }`, in the project's link order.
async fn project_repos(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
) -> Result<ResponseJson<Value>, ApiError> {
    let pool = &deployment.db().pool;
    let repo_ids = ProjectRepo::list_repo_ids(pool, project_id).await?;
    let repos = DbRepo::find_by_ids(pool, &repo_ids).await?;
    Ok(ResponseJson(json!({ "repos": repos })))
}

#[derive(Debug, Deserialize)]
struct LinkRepoRequest {
    repo_id: Uuid,
}

/// `POST /v1/projects/{id}/repos` — link a repo to a project. Idempotent.
async fn link_project_repo(
    State(deployment): State<DeploymentImpl>,
    Path(project_id): Path<Uuid>,
    ResponseJson(req): ResponseJson<LinkRepoRequest>,
) -> Result<ResponseJson<MutationResponse<Value>>, ApiError> {
    ProjectRepo::link(&deployment.db().pool, project_id, req.repo_id).await?;
    Ok(mutation(
        json!({ "project_id": project_id, "repo_id": req.repo_id }),
    ))
}

/// `DELETE /v1/projects/{id}/repos/{repo_id}` — unlink a repo from a project.
/// Removes only the grouping; the repo, its worktrees, and workspaces are kept.
async fn unlink_project_repo(
    State(deployment): State<DeploymentImpl>,
    Path((project_id, repo_id)): Path<(Uuid, Uuid)>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    ProjectRepo::unlink(&deployment.db().pool, project_id, repo_id).await?;
    Ok(deleted())
}

async fn fb_statuses(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = DbProjectStatus::list_by_project(&deployment.db().pool, q.project_id).await?;
    Ok(ResponseJson(json!({ "project_statuses": rows })))
}

async fn fb_issues(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = DbIssue::list_by_project(&deployment.db().pool, q.project_id).await?;
    Ok(ResponseJson(json!({ "issues": rows })))
}

async fn fb_tags(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = KanbanTag::list_by_project(&deployment.db().pool, q.project_id).await?;
    Ok(ResponseJson(json!({ "tags": rows })))
}

async fn fb_issue_tags(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = DbIssueTag::list_by_project(&deployment.db().pool, q.project_id).await?;
    Ok(ResponseJson(json!({ "issue_tags": rows })))
}

async fn fb_issue_assignees(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = DbIssueAssignee::list_by_project(&deployment.db().pool, q.project_id).await?;
    Ok(ResponseJson(json!({ "issue_assignees": rows })))
}

/// Synthesize the wire `Workspace` shape from a local issue<->workspace link.
/// `id` and `local_workspace_id` are both the local workspace id so the frontend
/// can map the row back to its local workspace; stats are left empty.
fn to_api_workspace(row: LinkedWorkspaceRow) -> ApiWorkspace {
    ApiWorkspace {
        id: row.workspace_id,
        project_id: row.project_id,
        owner_user_id: LOCAL_USER_ID,
        issue_id: Some(row.issue_id),
        local_workspace_id: Some(row.workspace_id),
        name: row.name,
        archived: row.archived,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        created_at: row.created_at,
        updated_at: row.updated_at,
        current_pipeline_stage: row.current_pipeline_stage,
    }
}

/// Workspaces linked to any issue in a project. Drives the web Kanban's
/// per-card workspace section (`PROJECT_WORKSPACES_SHAPE`) and the TUI board.
async fn fb_project_workspaces(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = IssueWorkspace::list_linked_by_project(&deployment.db().pool, q.project_id).await?;
    let mapped: Vec<ApiWorkspace> = rows.into_iter().map(to_api_workspace).collect();
    Ok(ResponseJson(json!({ "workspaces": mapped })))
}

/// All linked workspaces (`USER_WORKSPACES_SHAPE`); local mode has one user.
async fn fb_user_workspaces(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<Value>, ApiError> {
    let rows = IssueWorkspace::list_linked_all(&deployment.db().pool).await?;
    let mapped: Vec<ApiWorkspace> = rows.into_iter().map(to_api_workspace).collect();
    Ok(ResponseJson(json!({ "workspaces": mapped })))
}

// ---------------------------------------------------------------------------
// Organizations — a single synthetic local org so the org-scoped frontend
// shell resolves without any cloud account.
// ---------------------------------------------------------------------------

async fn list_organizations() -> ResponseJson<ListOrganizationsResponse> {
    let now = Utc::now();
    ResponseJson(ListOrganizationsResponse {
        organizations: vec![OrganizationWithRole {
            id: LOCAL_ORGANIZATION_ID,
            name: "Local".to_string(),
            slug: "local".to_string(),
            is_personal: false,
            issue_prefix: "LOCAL".to_string(),
            created_at: now,
            updated_at: now,
            user_role: MemberRole::Admin,
        }],
    })
}

async fn list_org_members(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ListMembersResponse>, ApiError> {
    let users = LocalUser::list_all(&deployment.db().pool).await?;
    let members = users
        .into_iter()
        .map(|u| OrganizationMemberWithProfile {
            user_id: u.id,
            role: MemberRole::Admin,
            joined_at: u.created_at,
            first_name: u.first_name,
            last_name: u.last_name,
            username: u.username,
            email: Some(u.email),
            avatar_url: None,
        })
        .collect();
    Ok(ResponseJson(ListMembersResponse { members }))
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async fn create_project(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateProjectRequest>,
) -> Result<ResponseJson<MutationResponse<ApiProject>>, ApiError> {
    let pool = &deployment.db().pool;
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let key = derive_key(&req.name);
    let project = DbProject::create(pool, id, &req.name, Some(&key), &req.color, 0, None).await?;
    // Seed default kanban columns; previously done by the TOML reconcile.
    if let Err(e) = project_config::seed_default_statuses(pool, project.id).await {
        tracing::warn!("Failed to seed default statuses for {}: {e}", project.id);
    }
    Ok(mutation(to_api_project(project)))
}

async fn update_project(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    ResponseJson(req): ResponseJson<UpdateProjectRequest>,
) -> Result<ResponseJson<MutationResponse<ApiProject>>, ApiError> {
    let existing = DbProject::find_by_id(&deployment.db().pool, id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("project not found".into()))?;
    let name = req.name.unwrap_or(existing.name);
    let color = req.color.unwrap_or(existing.color);
    let sort_order = req
        .sort_order
        .map(|v| v as i64)
        .unwrap_or(existing.sort_order);
    let project = DbProject::update_fields(
        &deployment.db().pool,
        id,
        &name,
        existing.key.as_deref(),
        &color,
        sort_order,
        existing.default_agent_working_dir.as_deref(),
    )
    .await?;
    Ok(mutation(to_api_project(project)))
}

#[derive(Debug, Deserialize)]
struct BulkProjectItem {
    id: Uuid,
    #[serde(flatten)]
    changes: UpdateProjectRequest,
}
#[derive(Debug, Deserialize)]
struct BulkProjectsRequest {
    updates: Vec<BulkProjectItem>,
}

async fn bulk_projects(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<BulkProjectsRequest>,
) -> Result<ResponseJson<MutationResponse<Vec<ApiProject>>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut out = Vec::with_capacity(req.updates.len());
    for item in req.updates {
        if let Some(existing) = DbProject::find_by_id(pool, item.id).await? {
            let name = item.changes.name.unwrap_or(existing.name);
            let color = item.changes.color.unwrap_or(existing.color);
            let sort_order = item
                .changes
                .sort_order
                .map(|v| v as i64)
                .unwrap_or(existing.sort_order);
            let p = DbProject::update_fields(
                pool,
                item.id,
                &name,
                existing.key.as_deref(),
                &color,
                sort_order,
                existing.default_agent_working_dir.as_deref(),
            )
            .await?;
            out.push(to_api_project(p));
        }
    }
    Ok(mutation(out))
}

async fn delete_project(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    DbProject::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

pub(crate) fn derive_key(name: &str) -> String {
    let key: String = name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .take(4)
        .collect::<String>()
        .to_uppercase();
    if key.is_empty() {
        "PRJ".to_string()
    } else {
        key
    }
}

// ---------------------------------------------------------------------------
// Project statuses (kanban columns)
// ---------------------------------------------------------------------------

async fn create_status(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateProjectStatusRequest>,
) -> Result<ResponseJson<MutationResponse<DbProjectStatus>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = DbProjectStatus::create(
        &deployment.db().pool,
        id,
        req.project_id,
        &req.name,
        &req.color,
        req.sort_order as i64,
        req.hidden,
    )
    .await?;
    Ok(mutation(row))
}

async fn update_status(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    ResponseJson(req): ResponseJson<UpdateProjectStatusRequest>,
) -> Result<ResponseJson<MutationResponse<DbProjectStatus>>, ApiError> {
    let row = DbProjectStatus::update(
        &deployment.db().pool,
        id,
        req.name.as_deref(),
        req.color.as_deref(),
        req.sort_order.map(|v| v as i64),
        req.hidden,
    )
    .await?
    .ok_or_else(|| ApiError::BadRequest("status not found".into()))?;
    Ok(mutation(row))
}

#[derive(Debug, Deserialize)]
struct BulkStatusItem {
    id: Uuid,
    #[serde(flatten)]
    changes: UpdateProjectStatusRequest,
}
#[derive(Debug, Deserialize)]
struct BulkStatusesRequest {
    updates: Vec<BulkStatusItem>,
}

async fn bulk_statuses(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<BulkStatusesRequest>,
) -> Result<ResponseJson<MutationResponse<Vec<DbProjectStatus>>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut out = Vec::with_capacity(req.updates.len());
    for item in req.updates {
        if let Some(row) = DbProjectStatus::update(
            pool,
            item.id,
            item.changes.name.as_deref(),
            item.changes.color.as_deref(),
            item.changes.sort_order.map(|v| v as i64),
            item.changes.hidden,
        )
        .await?
        {
            out.push(row);
        }
    }
    Ok(mutation(out))
}

async fn delete_status(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    DbProjectStatus::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

async fn create_issue(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateIssueRequest>,
) -> Result<ResponseJson<MutationResponse<DbIssue>>, ApiError> {
    let pool = &deployment.db().pool;
    let project = DbProject::find_by_id(pool, req.project_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("project not found".into()))?;
    let key = project.key.unwrap_or_else(|| derive_key(&project.name));
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let priority = req.priority.as_ref().map(|p| priority_str(p).to_string());
    let ext = serde_json::to_string(&req.extension_metadata).unwrap_or_else(|_| "{}".to_string());

    let issue = DbIssue::create(
        pool,
        NewIssue {
            id,
            project_id: req.project_id,
            status_id: req.status_id,
            title: &req.title,
            description: req.description.as_deref(),
            priority: priority.as_deref(),
            start_date: req.start_date,
            target_date: req.target_date,
            completed_at: req.completed_at,
            sort_order: req.sort_order,
            parent_issue_id: req.parent_issue_id,
            parent_issue_sort_order: req.parent_issue_sort_order,
            extension_metadata: &ext,
            creator_user_id: Some(LOCAL_USER_ID),
            key: &key,
        },
    )
    .await?;
    Ok(mutation(issue))
}

pub(crate) async fn merge_and_update_issue(
    pool: &sqlx::SqlitePool,
    id: Uuid,
    req: UpdateIssueRequest,
) -> Result<Option<DbIssue>, ApiError> {
    let Some(existing) = DbIssue::find_by_id(pool, id).await? else {
        return Ok(None);
    };
    let status_id = req.status_id.unwrap_or(existing.status_id);
    let title = req.title.unwrap_or(existing.title);
    let description = match req.description {
        Some(v) => v,
        None => existing.description,
    };
    let priority = match req.priority {
        Some(v) => v.as_ref().map(|p| priority_str(p).to_string()),
        None => existing.priority,
    };
    let start_date = match req.start_date {
        Some(v) => v,
        None => existing.start_date,
    };
    let target_date = match req.target_date {
        Some(v) => v,
        None => existing.target_date,
    };
    let completed_at = match req.completed_at {
        Some(v) => v,
        None => existing.completed_at,
    };
    let sort_order = req.sort_order.unwrap_or(existing.sort_order);
    let parent_issue_id = match req.parent_issue_id {
        Some(v) => v,
        None => existing.parent_issue_id,
    };
    let parent_issue_sort_order = match req.parent_issue_sort_order {
        Some(v) => v,
        None => existing.parent_issue_sort_order,
    };
    let ext = match req.extension_metadata {
        Some(v) => serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string()),
        None => {
            serde_json::to_string(&existing.extension_metadata).unwrap_or_else(|_| "{}".to_string())
        }
    };

    let updated = DbIssue::update(
        pool,
        id,
        IssueUpdate {
            status_id,
            title: &title,
            description: description.as_deref(),
            priority: priority.as_deref(),
            start_date,
            target_date,
            completed_at,
            sort_order,
            parent_issue_id,
            parent_issue_sort_order,
            extension_metadata: &ext,
        },
    )
    .await?;
    Ok(updated)
}

async fn update_issue(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    ResponseJson(req): ResponseJson<UpdateIssueRequest>,
) -> Result<ResponseJson<MutationResponse<DbIssue>>, ApiError> {
    let issue = merge_and_update_issue(&deployment.db().pool, id, req)
        .await?
        .ok_or_else(|| ApiError::BadRequest("issue not found".into()))?;
    Ok(mutation(issue))
}

#[derive(Debug, Deserialize)]
struct BulkIssueItem {
    id: Uuid,
    #[serde(flatten)]
    changes: UpdateIssueRequest,
}
#[derive(Debug, Deserialize)]
struct BulkIssuesRequest {
    updates: Vec<BulkIssueItem>,
}

async fn bulk_issues(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<BulkIssuesRequest>,
) -> Result<ResponseJson<MutationResponse<Vec<DbIssue>>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut out = Vec::with_capacity(req.updates.len());
    for item in req.updates {
        if let Some(issue) = merge_and_update_issue(pool, item.id, item.changes).await? {
            out.push(issue);
        }
    }
    Ok(mutation(out))
}

async fn delete_issue(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    DbIssue::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

async fn create_tag(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateTagRequest>,
) -> Result<ResponseJson<MutationResponse<KanbanTag>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = KanbanTag::create(
        &deployment.db().pool,
        id,
        req.project_id,
        &req.name,
        &req.color,
    )
    .await?;
    Ok(mutation(row))
}

async fn update_tag(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    ResponseJson(req): ResponseJson<UpdateTagRequest>,
) -> Result<ResponseJson<MutationResponse<KanbanTag>>, ApiError> {
    let row = KanbanTag::update(
        &deployment.db().pool,
        id,
        req.name.as_deref(),
        req.color.as_deref(),
    )
    .await?
    .ok_or_else(|| ApiError::BadRequest("tag not found".into()))?;
    Ok(mutation(row))
}

async fn delete_tag(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    KanbanTag::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

async fn create_issue_tag(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateIssueTagRequest>,
) -> Result<ResponseJson<MutationResponse<DbIssueTag>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = DbIssueTag::create(&deployment.db().pool, id, req.issue_id, req.tag_id).await?;
    Ok(mutation(row))
}

async fn delete_issue_tag(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    DbIssueTag::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

async fn create_issue_assignee(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateIssueAssigneeRequest>,
) -> Result<ResponseJson<MutationResponse<DbIssueAssignee>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = DbIssueAssignee::create(&deployment.db().pool, id, req.issue_id, req.user_id).await?;
    Ok(mutation(row))
}

async fn delete_issue_assignee(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    DbIssueAssignee::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/v1/organizations", get(list_organizations))
        .route("/v1/organizations/{org_id}/members", get(list_org_members))
        .route("/v1/fallback/projects", get(fb_projects))
        .route(
            "/v1/projects/{id}/repos",
            get(project_repos).post(link_project_repo),
        )
        .route(
            "/v1/projects/{id}/repos/{repo_id}",
            axum::routing::delete(unlink_project_repo),
        )
        .route("/v1/fallback/users", get(fb_users))
        .route("/v1/fallback/project_statuses", get(fb_statuses))
        .route("/v1/fallback/issues", get(fb_issues))
        .route("/v1/fallback/tags", get(fb_tags))
        .route("/v1/fallback/issue_tags", get(fb_issue_tags))
        .route("/v1/fallback/issue_assignees", get(fb_issue_assignees))
        .route(
            "/v1/fallback/project_workspaces",
            get(fb_project_workspaces),
        )
        .route("/v1/fallback/user_workspaces", get(fb_user_workspaces))
        .route("/v1/projects", post(create_project))
        .route("/v1/projects/bulk", post(bulk_projects))
        .route(
            "/v1/projects/{id}",
            patch(update_project).delete(delete_project),
        )
        .route("/v1/project_statuses", post(create_status))
        .route("/v1/project_statuses/bulk", post(bulk_statuses))
        .route(
            "/v1/project_statuses/{id}",
            patch(update_status).delete(delete_status),
        )
        .route("/v1/issues", post(create_issue))
        .route("/v1/issues/bulk", post(bulk_issues))
        .route("/v1/issues/{id}", patch(update_issue).delete(delete_issue))
        .route("/v1/tags", post(create_tag))
        .route("/v1/tags/{id}", patch(update_tag).delete(delete_tag))
        .route("/v1/issue_tags", post(create_issue_tag))
        .route(
            "/v1/issue_tags/{id}",
            axum::routing::delete(delete_issue_tag),
        )
        .route("/v1/issue_assignees", post(create_issue_assignee))
        .route(
            "/v1/issue_assignees/{id}",
            axum::routing::delete(delete_issue_assignee),
        )
}

#[cfg(test)]
mod tests {
    /// The local-kanban router must build without a matchit path conflict.
    /// Routes that share a position but use different param names (e.g.
    /// `/v1/projects/{id}` vs `/v1/projects/{project_id}/repos`) panic at
    /// registration, which would crash the server on startup.
    #[test]
    fn router_builds_without_route_conflicts() {
        let _ = super::router();
    }
}
