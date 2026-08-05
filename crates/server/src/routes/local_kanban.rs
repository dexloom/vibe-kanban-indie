//! Local kanban API.
//!
//! Re-homes the hosted kanban (projects, issues, statuses, tags, assignees)
//! onto local SQLite so the existing frontend works with no cloud account. The
//! frontend's built-in fallback transport reads from `/v1/fallback/<table>`
//! (returning `{ "<table>": [...] }`) and mutates via `/v1/<table>` (returning
//! `{ data, txid }`). ElectricSQL is not involved; a monotonic local `txid`
//! satisfies the optimistic-update handshake.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};

use api_types::{
    CreateIssueAssigneeRequest, CreateIssueCommentRequest, CreateIssueRequest,
    CreateIssueTagRequest, CreateProjectRequest, CreateProjectStatusRequest, CreateTagRequest,
    DeleteResponse, IssueComment, IssuePriority, ListIssueCommentsQuery, ListIssueCommentsResponse,
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
    issue_comment::{IssueComment as DbIssueComment, NewIssueComment},
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
use sqlx::SqlitePool;
use std::time::SystemTime;
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
        parent_id: p.parent_id,
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
    let project = create_project_record(
        &deployment.db().pool,
        req.id.unwrap_or_else(Uuid::new_v4),
        &req.name,
        &req.color,
        req.parent_id,
    )
    .await?;
    if let Err(e) = project_config::seed_default_statuses(&deployment.db().pool, project.id).await {
        tracing::warn!("Failed to seed default statuses for {}: {e}", project.id);
    }
    Ok(mutation(to_api_project(project)))
}

pub(crate) async fn create_project_record(
    pool: &SqlitePool,
    id: Uuid,
    name: &str,
    color: &str,
    parent_id: Option<Uuid>,
) -> Result<DbProject, ApiError> {
    let key = derive_key(name);
    if sibling_key_exists(pool, parent_id, &key).await? {
        return Err(ApiError::BadRequest("project key already exists".into()));
    }
    let project = DbProject::create(pool, id, name, Some(&key), color, 0, None, parent_id).await?;
    Ok(project)
}

async fn sibling_key_exists(
    pool: &SqlitePool,
    parent_id: Option<Uuid>,
    key: &str,
) -> Result<bool, ApiError> {
    let row: Option<(i64,)> = match parent_id {
        Some(parent) => sqlx::query_as("SELECT 1 FROM projects WHERE parent_id = ? AND key = ?")
            .bind(parent)
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::from)?,
        None => sqlx::query_as("SELECT 1 FROM projects WHERE parent_id IS NULL AND key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::from)?,
    };
    Ok(row.is_some())
}

pub(crate) async fn derive_key_chain(
    pool: &SqlitePool,
    project_id: Uuid,
) -> Result<String, sqlx::Error> {
    const MAX_CHAIN: usize = 16;
    // F-10: a tiny TTL'd cache for the parent-chain walk. `create_issue`
    // calls this per issue; for depth-D projects that's D+1 queries each
    // time. The cache returns the cached `keys` Vec (already in root→leaf
    // order from `find_parent_chain_keys`) on hit. NOT invalidated on
    // reparent yet — reparent is intentionally rejected at the API
    // layer (F-4). When reparent lands, this cache MUST be cleared at
    // the reparent write path. Cache size capped; overflow clears all.
    if let Some(keys) = KEY_CHAIN_CACHE
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .ok()
        .and_then(|guard| guard.get(&project_id).map(|entry| entry.1.clone()))
    {
        if keys.len() > MAX_CHAIN {
            return Err(sqlx::Error::Protocol(format!(
                "project parent chain exceeds {MAX_CHAIN} levels"
            )));
        }
        return Ok(keys.join("-"));
    }
    let keys = DbProject::find_parent_chain_keys(pool, project_id).await?;
    if keys.len() > MAX_CHAIN {
        return Err(sqlx::Error::Protocol(format!(
            "project parent chain exceeds {MAX_CHAIN} levels"
        )));
    }
    if let Ok(mut guard) = KEY_CHAIN_CACHE
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
    {
        if guard.len() >= KEY_CHAIN_CACHE_MAX {
            // Simple overflow policy: clear all. Repo's max depth is
            // 16 (MAX_CHAIN), so 128 entries comfortably outgrows any
            // realistic project tree; clearing on overflow keeps the
            // data structure tiny without an LRU list.
            guard.clear();
        }
        guard.insert(project_id, (SystemTime::now(), keys.clone()));
    }
    Ok(keys.join("-"))
}

/// F-10: project_id → (cached_at, root→leaf key chain). TTL is a safety
/// valve (currently unbounded — reparent is API-rejected per F-4); the
/// size cap is the real eviction policy. When reparent lands this MUST
/// be cleared at the write site.
#[allow(clippy::type_complexity)]
static KEY_CHAIN_CACHE: OnceLock<
    Mutex<std::collections::HashMap<Uuid, (SystemTime, Vec<String>)>>,
> = OnceLock::new();
const KEY_CHAIN_CACHE_MAX: usize = 128;

async fn update_project(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    ResponseJson(req): ResponseJson<UpdateProjectRequest>,
) -> Result<ResponseJson<MutationResponse<ApiProject>>, ApiError> {
    reject_parent_id_change(req.parent_id)?;
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
        existing.parent_id,
    )
    .await?;
    Ok(mutation(to_api_project(project)))
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BulkProjectItem {
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
    // ADR-013: same reparent guard as `update_project` — applied to the
    // whole bulk (no partial commit) so a single bad item fails the request
    // loudly rather than silently skipping.
    reject_any_parent_id_change(&req.updates)?;
    let pool = &deployment.db().pool;
    let mut out = Vec::with_capacity(req.updates.len());
    let mut skipped: Vec<Uuid> = Vec::new();
    for item in req.updates {
        match DbProject::find_by_id(pool, item.id).await? {
            Some(existing) => {
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
                    existing.parent_id,
                )
                .await?;
                out.push(to_api_project(p));
            }
            None => {
                // F-13 / glm B-5: silent skip was hiding deleted/already-
                // gone rows from the client. The wire response shape
                // (`MutationResponse<Vec<ApiProject>>`) is rigid so we
                // can't surface skipped ids in-band without breaking
                // optimistic-update clients; log a `tracing::warn!`
                // instead so the disappearance is visible in server
                // logs and the client can self-heal on the next shape
                // sync.
                tracing::warn!(
                    bulk_projects_unknown_id = %item.id,
                    "bulk_projects skipped an id that did not resolve to a row"
                );
                skipped.push(item.id);
            }
        }
    }
    if !skipped.is_empty() {
        tracing::warn!(
            skipped_count = skipped.len(),
            "bulk_projects skipped {} unknown id(s) (see prior warns for each)",
            skipped.len()
        );
    }
    Ok(mutation(out))
}

/// ADR-013 / F-4: reparent is intentionally NOT supported yet. A silent
/// `parent_id` write would change the project's breadcrumb / key chain
/// without re-deriving the `simple_id` prefixes on existing issues, so we
/// surface it as a 400 to make the footgun loud at call sites. Deferred
/// to a follow-up ADR (reparent + chain re-derivation per subtree).
/// Extracted as a free function so unit tests can hit it without standing
/// up an axum `State<DeploymentImpl>`.
pub(crate) fn reject_parent_id_change(parent_id: Option<Uuid>) -> Result<(), ApiError> {
    if parent_id.is_some() {
        Err(ApiError::BadRequest(
            "parent_id changes not supported yet (reparent coming soon)".into(),
        ))
    } else {
        Ok(())
    }
}

/// F-4 bulk variant: ANY item with a `parent_id` change aborts the whole
/// bulk (no partial commit).
pub(crate) fn reject_any_parent_id_change(items: &[BulkProjectItem]) -> Result<(), ApiError> {
    if items.iter().any(|item| item.changes.parent_id.is_some()) {
        Err(ApiError::BadRequest(
            "parent_id changes not supported yet (reparent coming soon)".into(),
        ))
    } else {
        Ok(())
    }
}

async fn delete_project(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    delete_project_record(&deployment.db().pool, id).await?;
    Ok(deleted())
}

pub(crate) async fn delete_project_record(pool: &SqlitePool, id: Uuid) -> Result<(), ApiError> {
    // Wrap the children-check + delete in a single transaction so a
    // concurrent INSERT into `projects` (reparent or seed) between the
    // count and the delete can't slip past us. The `ON DELETE RESTRICT`
    // FK on `parent_id` is the second line of defence — if the FK fires
    // (race won by an inserter), we map the SQLite constraint error to
    // the same `ConflictPayload` instead of leaking a 500 to the client.
    // All queries MUST run on the transaction (`&mut *tx`), not the
    // pool — with `max_connections = 1` (test pools, low-mem prod), a
    // second pool acquire would `PoolTimedOut` while the tx holds the
    // only connection.
    let mut tx = pool.begin().await?;
    let children_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE parent_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if children_count > 0 {
        let child_rows = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT id, name FROM projects WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        let children_payload: Vec<serde_json::Value> = child_rows
            .into_iter()
            .map(|(child_id, name)| json!({ "id": child_id, "name": name }))
            .collect();
        // Roll back implicitly by dropping `tx` (no commit). Return the
        // structured conflict payload — NOT a 500.
        return Err(ApiError::ConflictPayload(json!({
            "error": "project_has_children",
            "children": children_payload,
        })));
    }
    let delete_result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await;
    match delete_result {
        Ok(_) => {
            tx.commit().await?;
            Ok(())
        }
        Err(sqlx::Error::Database(db_err))
            if db_err.code().as_deref() == Some("787")
                || db_err.message().contains("FOREIGN KEY") =>
        {
            // SQLITE_CONSTRAINT_FOREIGNKEY (787) — a child landed between
            // our count and our delete. Re-read the children for the
            // payload, then return ConflictPayload instead of Database.
            tracing::warn!(
                "FK race on delete_project {id}: child inserted between count and delete"
            );
            let child_rows = sqlx::query_as::<_, (Uuid, String)>(
                "SELECT id, name FROM projects WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC",
            )
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
            let children_payload: Vec<serde_json::Value> = child_rows
                .into_iter()
                .map(|(child_id, name)| json!({ "id": child_id, "name": name }))
                .collect();
            Err(ApiError::ConflictPayload(json!({
                "error": "project_has_children",
                "children": children_payload,
            })))
        }
        Err(err) => Err(err.into()),
    }
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
    if DbProject::find_by_id(pool, req.project_id).await?.is_none() {
        return Err(ApiError::BadRequest("project not found".into()));
    }
    let key = derive_key_chain(pool, req.project_id).await?;
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
// Issue comments
// ---------------------------------------------------------------------------

async fn fb_issue_comments(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ListIssueCommentsQuery>,
) -> Result<ResponseJson<ListIssueCommentsResponse>, ApiError> {
    let rows = DbIssueComment::list_by_issue(&deployment.db().pool, q.issue_id).await?;
    let issue_comments = rows
        .into_iter()
        .map(|row| IssueComment {
            id: row.id,
            issue_id: row.issue_id,
            author_id: Some(row.author_id),
            parent_id: row.parent_id,
            message: row.message,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect();
    Ok(ResponseJson(ListIssueCommentsResponse { issue_comments }))
}

async fn create_issue_comment(
    State(deployment): State<DeploymentImpl>,
    ResponseJson(req): ResponseJson<CreateIssueCommentRequest>,
) -> Result<ResponseJson<MutationResponse<IssueComment>>, ApiError> {
    let row = DbIssueComment::create(
        &deployment.db().pool,
        NewIssueComment {
            id: req.id.unwrap_or_else(Uuid::new_v4),
            issue_id: req.issue_id,
            author_id: LOCAL_USER_ID,
            parent_id: req.parent_id,
            message: &req.message,
        },
    )
    .await?;
    Ok(mutation(IssueComment {
        id: row.id,
        issue_id: row.issue_id,
        author_id: Some(row.author_id),
        parent_id: row.parent_id,
        message: row.message,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}

async fn update_issue_comment(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    ResponseJson(req): ResponseJson<api_types::UpdateIssueCommentRequest>,
) -> Result<ResponseJson<MutationResponse<IssueComment>>, ApiError> {
    let row = DbIssueComment::update(
        &deployment.db().pool,
        id,
        req.message.as_deref(),
        req.parent_id,
    )
    .await?
    .ok_or_else(|| ApiError::BadRequest("comment not found".into()))?;
    Ok(mutation(IssueComment {
        id: row.id,
        issue_id: row.issue_id,
        author_id: Some(row.author_id),
        parent_id: row.parent_id,
        message: row.message,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}

async fn delete_issue_comment(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<DeleteResponse>, ApiError> {
    DbIssueComment::delete(&deployment.db().pool, id).await?;
    Ok(deleted())
}

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
        .route("/v1/fallback/issue_comments", get(fb_issue_comments))
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
        .route("/v1/issue_comments", post(create_issue_comment))
        .route(
            "/v1/issue_comments/{id}",
            patch(update_issue_comment).delete(delete_issue_comment),
        )
}

#[cfg(test)]
mod tests {
    use api_types::UpdateProjectRequest;
    use db::models::issue::{Issue as DbIssue, NewIssue};
    use db::models::project::Project as DbProject;
    use db::models::project_status::ProjectStatus as DbProjectStatus;
    use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
    use uuid::Uuid;

    use super::{create_project_record, delete_project_record, derive_key_chain};
    use crate::error::ApiError;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn derives_nested_key_chain_and_rejects_duplicate_sibling_key() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let grandchild_id = Uuid::new_v4();

        DbProject::create(
            &pool,
            root_id,
            "Acme",
            Some("ACME"),
            "#6366f1",
            0,
            None,
            None,
        )
        .await
        .unwrap();
        DbProject::create(
            &pool,
            child_id,
            "Sub",
            Some("SUB"),
            "#6366f1",
            0,
            None,
            Some(root_id),
        )
        .await
        .unwrap();
        DbProject::create(
            &pool,
            grandchild_id,
            "X",
            Some("X"),
            "#6366f1",
            0,
            None,
            Some(child_id),
        )
        .await
        .unwrap();

        assert_eq!(derive_key_chain(&pool, child_id).await.unwrap(), "ACME-SUB");
        assert_eq!(
            derive_key_chain(&pool, grandchild_id).await.unwrap(),
            "ACME-SUB-X"
        );

        let error = create_project_record(&pool, Uuid::new_v4(), "Sub", "#6366f1", Some(root_id))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ApiError::BadRequest(message) if message == "project key already exists"
        ));
    }

    #[tokio::test]
    async fn create_issue_uses_chain_key_for_nested_projects() {
        let pool = pool().await;
        let root = create_project_record(&pool, Uuid::new_v4(), "Acme", "#6366f1", None)
            .await
            .unwrap();
        let sub = create_project_record(&pool, Uuid::new_v4(), "Sub", "#6366f1", Some(root.id))
            .await
            .unwrap();
        let grandchild = create_project_record(&pool, Uuid::new_v4(), "X", "#6366f1", Some(sub.id))
            .await
            .unwrap();

        let status = DbProjectStatus::create(
            &pool,
            Uuid::new_v4(),
            grandchild.id,
            "Todo",
            "#fff",
            0,
            false,
        )
        .await
        .unwrap();

        let first_grandchild = create_issue_for(&pool, &grandchild, &status, "First grandchild")
            .await
            .unwrap();
        let second_grandchild = create_issue_for(&pool, &grandchild, &status, "Second grandchild")
            .await
            .unwrap();
        let root_issue = create_issue_for(&pool, &root, &status, "Root issue")
            .await
            .unwrap();
        let sub_issue = create_issue_for(&pool, &sub, &status, "Sub issue")
            .await
            .unwrap();

        assert_eq!(first_grandchild.simple_id, "ACME-SUB-X-1");
        assert_eq!(second_grandchild.simple_id, "ACME-SUB-X-2");
        assert_eq!(root_issue.simple_id, "ACME-1");
        assert_eq!(sub_issue.simple_id, "ACME-SUB-1");
    }

    #[tokio::test]
    async fn delete_project_rejects_when_children_exist() {
        let pool = pool().await;
        let parent = create_project_record(&pool, Uuid::new_v4(), "Parent", "#6366f1", None)
            .await
            .unwrap();
        let child =
            create_project_record(&pool, Uuid::new_v4(), "Child", "#6366f1", Some(parent.id))
                .await
                .unwrap();

        let error = delete_project_record(&pool, parent.id).await.unwrap_err();
        match error {
            ApiError::ConflictPayload(payload) => {
                assert_eq!(payload["error"], "project_has_children");
                let children = payload["children"].as_array().expect("children array");
                let ids: Vec<Uuid> = children
                    .iter()
                    .map(|entry| Uuid::parse_str(entry["id"].as_str().expect("child id")).unwrap())
                    .collect();
                assert_eq!(ids, vec![child.id]);
            }
            other => panic!("expected ConflictPayload, got {other:?}"),
        }

        delete_project_record(&pool, child.id).await.unwrap();
        delete_project_record(&pool, parent.id).await.unwrap();
    }

    /// F-4: `reject_parent_id_change` MUST reject `parent_id = Some(...)`
    /// as a 400. Reparent is deferred per ADR-013 — silent reparent
    /// would change the breadcrumb / key chain without re-deriving the
    /// `simple_id` prefixes on existing issues (footgun the API must
    /// make loud). The validation lives in a free function so it can be
    /// unit-tested without standing up a `DeploymentImpl` (which needs
    /// the full WorkspaceManager).
    #[test]
    fn reject_parent_id_change_returns_bad_request_on_some() {
        let err = super::reject_parent_id_change(Some(Uuid::new_v4())).unwrap_err();
        match err {
            ApiError::BadRequest(msg) => assert!(msg.contains("parent_id"), "{msg}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
        // `None` is the no-op case — must not error.
        super::reject_parent_id_change(None).expect("None must pass");
        // Same parent_id is still a reparent attempt — must error too.
        let err = super::reject_parent_id_change(Some(Uuid::nil())).unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)));
    }

    /// F-4: `reject_any_parent_id_change` MUST abort the whole bulk if
    /// ANY item carries a `parent_id` change. Partial-commit would leave
    /// the bulk in a half-applied state (some items mutated, others
    /// silently skipped).
    #[test]
    fn reject_any_parent_id_change_rejects_whole_bulk_on_one_offending_item() {
        let good_item = super::BulkProjectItem {
            id: Uuid::new_v4(),
            changes: UpdateProjectRequest {
                name: Some("Renamed".into()),
                color: None,
                sort_order: Some(50),
                parent_id: None,
            },
        };
        let mut bad_item = good_item.clone();
        bad_item.changes.parent_id = Some(Uuid::new_v4());

        // All-clean bulk → Ok.
        super::reject_any_parent_id_change(&[good_item.clone(), good_item.clone()])
            .expect("clean bulk must pass");

        // Any bad item → BadRequest, even if surrounded by good ones.
        let err = super::reject_any_parent_id_change(&[good_item.clone(), bad_item, good_item])
            .unwrap_err();
        match err {
            ApiError::BadRequest(msg) => assert!(msg.contains("parent_id"), "{msg}"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    async fn create_issue_for(
        pool: &SqlitePool,
        project: &DbProject,
        status: &DbProjectStatus,
        title: &str,
    ) -> Result<DbIssue, sqlx::Error> {
        let key = derive_key_chain(pool, project.id).await?;
        DbIssue::create(
            pool,
            NewIssue {
                id: Uuid::new_v4(),
                project_id: project.id,
                status_id: status.id,
                title,
                description: None,
                priority: None,
                start_date: None,
                target_date: None,
                completed_at: None,
                sort_order: 0.0,
                parent_issue_id: None,
                parent_issue_sort_order: None,
                extension_metadata: "{}",
                creator_user_id: None,
                key: &key,
            },
        )
        .await
    }

    /// The local-kanban router must build without a matchit path conflict.
    /// Routes that share a position but use different param names (e.g.
    /// `/v1/projects/{id}` vs `/v1/projects/{project_id}/repos`) panic at
    /// registration, which would crash the server on startup.
    #[test]
    fn router_builds_without_route_conflicts() {
        let _ = super::router();
    }
}
