//! Local kanban API for the MCP server (envelope-wrapped).
//!
//! Re-homes the project/issue/tag/relationship endpoints `vibe-kanban-mcp`
//! calls onto the local SQLite database. Unlike the frontend's `/v1/*` fallback
//! transport (which returns bare `{ "<table>": [...] }` / `{ data, txid }` shapes),
//! these handlers return the standard `ApiResponse` envelope the MCP client
//! expects, so the MCP tools only need their URLs repointed.
//!
//! Mutation endpoints wrap their payload in `ApiResponse<MutationResponse<T>>`
//! (the double-wrap the MCP client deserializes); reads return
//! `ApiResponse<List…Response>`; deletes return `ApiResponse<()>`.

use std::{
    collections::HashSet,
    sync::atomic::{AtomicI64, Ordering},
};

use api_types::{
    CreateIssueRelationshipRequest, CreateIssueRequest, CreateIssueTagRequest, Issue as ApiIssue,
    IssuePriority, IssueRelationship as ApiIssueRelationship, IssueRelationshipType,
    IssueSortField, IssueTag as ApiIssueTag, ListIssueRelationshipsQuery,
    ListIssueRelationshipsResponse, ListIssueTagsResponse, ListIssuesResponse,
    ListProjectStatusesResponse, ListProjectsResponse, ListPullRequestsResponse, ListTagsResponse,
    MutationResponse, OrchestratorPromptResponse, OrchestratorPromptSource, Project as ApiProject,
    ProjectStatus as ApiProjectStatus, PullRequest as ApiPullRequest, PullRequestStatus,
    ResolvedOrchestratorPromptResponse, SearchIssuesRequest, SortDirection, Tag as ApiTag,
    UpdateIssueRequest, UpdateOrchestratorPromptRequest,
};
use axum::{
    Router,
    extract::{Json, Path, Query, State},
    response::Json as ResponseJson,
    routing::{delete, get, post},
};
use db::models::{
    execution_process::ExecutionProcess,
    file::{CommentAttachment, IssueAttachment},
    issue::Issue as DbIssue,
    issue_relationship::IssueRelationship as DbIssueRelationship,
    issue_workspace::IssueWorkspace,
    kanban_tag::{IssueTag as DbIssueTag, KanbanTag},
    merge::MergeStatus,
    project::Project as DbProject,
    project_status::ProjectStatus as DbProjectStatus,
    pull_request::PullRequest as DbPullRequest,
    session::Session,
    workspace::{Workspace, WorkspaceKind},
};
use deployment::Deployment;
use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use utils::response::ApiResponse;
use uuid::Uuid;

use super::local_kanban::{create_issue_record, merge_and_update_issue};
use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::sessions::{FollowUpResponse, run_follow_up},
};

/// Process-local monotonic txid for the `MutationResponse` envelope. The MCP
/// client ignores the value but the field must be present to deserialize.
static TXID: AtomicI64 = AtomicI64::new(1);
fn next_txid() -> i64 {
    TXID.fetch_add(1, Ordering::Relaxed)
}

fn ok<T: Serialize>(data: T) -> ResponseJson<ApiResponse<T>> {
    ResponseJson(ApiResponse::success(data))
}

fn mutated<T: Serialize>(data: T) -> ResponseJson<ApiResponse<MutationResponse<T>>> {
    ResponseJson(ApiResponse::success(MutationResponse {
        data,
        txid: next_txid(),
    }))
}

// --- query extractors -------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ProjectScope {
    project_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct IssueScope {
    issue_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct WorkspaceScope {
    workspace_id: Uuid,
}

#[derive(Debug, Serialize)]
struct WorkspaceIssueLink {
    project_id: Option<Uuid>,
    issue_id: Option<Uuid>,
}

/// One row of the bulk `GET /api/workspace-issue-links` response: a workspace and
/// the issue (card) it is linked to. List-shaped consumers (the MCP's
/// `list_workspaces`, VIBE-23) join these onto workspace rows in one call instead
/// of one `GET /api/workspace-issue-link` round-trip per workspace.
#[derive(Debug, Serialize)]
struct WorkspaceIssueLinkRow {
    workspace_id: Uuid,
    issue_id: Uuid,
}

// --- conversions: DB row types -> api_types wire types ----------------------

fn priority_str(p: &IssuePriority) -> &'static str {
    match p {
        IssuePriority::Urgent => "urgent",
        IssuePriority::High => "high",
        IssuePriority::Medium => "medium",
        IssuePriority::Low => "low",
    }
}

fn priority_from_str(p: Option<&str>) -> Option<IssuePriority> {
    match p {
        Some("urgent") => Some(IssuePriority::Urgent),
        Some("high") => Some(IssuePriority::High),
        Some("medium") => Some(IssuePriority::Medium),
        Some("low") => Some(IssuePriority::Low),
        _ => None,
    }
}

/// Sort rank for priorities (urgent first); `None` sorts last.
fn priority_rank(p: Option<&str>) -> u8 {
    match p {
        Some("urgent") => 0,
        Some("high") => 1,
        Some("medium") => 2,
        Some("low") => 3,
        _ => 4,
    }
}

fn to_api_project(p: DbProject) -> ApiProject {
    ApiProject {
        id: p.id,
        name: p.name,
        color: p.color,
        sort_order: p.sort_order as i32,
        parent_id: p.parent_id,
        // ADR-016: mirror local_kanban::to_api_project — the prompt body
        // never ships on the list shape; the dedicated endpoints return
        // the raw and resolved values.
        has_orchestrator_prompt: !p.orchestrator_prompt.trim().is_empty(),
        created_at: p.created_at,
        updated_at: p.updated_at,
    }
}

fn to_api_status(s: DbProjectStatus) -> ApiProjectStatus {
    ApiProjectStatus {
        id: s.id,
        project_id: s.project_id,
        name: s.name,
        color: s.color,
        sort_order: s.sort_order as i32,
        hidden: s.hidden,
        is_terminal: s.is_terminal,
        created_at: s.created_at,
    }
}

fn to_api_issue(i: DbIssue) -> ApiIssue {
    ApiIssue {
        id: i.id,
        project_id: i.project_id,
        issue_number: i.issue_number as i32,
        simple_id: i.simple_id,
        status_id: i.status_id,
        title: i.title,
        description: i.description,
        priority: priority_from_str(i.priority.as_deref()),
        start_date: i.start_date,
        target_date: i.target_date,
        completed_at: i.completed_at,
        sort_order: i.sort_order,
        parent_issue_id: i.parent_issue_id,
        parent_issue_sort_order: i.parent_issue_sort_order,
        extension_metadata: i.extension_metadata,
        created_at: i.created_at,
        updated_at: i.updated_at,
    }
}

fn to_api_tag(t: KanbanTag) -> ApiTag {
    ApiTag {
        id: t.id,
        project_id: t.project_id,
        name: t.name,
        color: t.color,
    }
}

fn to_api_issue_tag(t: DbIssueTag) -> ApiIssueTag {
    ApiIssueTag {
        id: t.id,
        issue_id: t.issue_id,
        tag_id: t.tag_id,
    }
}

fn rel_type_from_str(s: &str) -> IssueRelationshipType {
    match s {
        "blocking" => IssueRelationshipType::Blocking,
        "has_duplicate" => IssueRelationshipType::HasDuplicate,
        _ => IssueRelationshipType::Related,
    }
}

fn rel_type_to_str(t: IssueRelationshipType) -> &'static str {
    match t {
        IssueRelationshipType::Blocking => "blocking",
        IssueRelationshipType::Related => "related",
        IssueRelationshipType::HasDuplicate => "has_duplicate",
    }
}

fn to_api_relationship(r: DbIssueRelationship) -> ApiIssueRelationship {
    ApiIssueRelationship {
        id: r.id,
        issue_id: r.issue_id,
        related_issue_id: r.related_issue_id,
        relationship_type: rel_type_from_str(&r.relationship_type),
        created_at: r.created_at,
    }
}

fn pr_status_to_api(s: MergeStatus) -> PullRequestStatus {
    match s {
        MergeStatus::Merged => PullRequestStatus::Merged,
        MergeStatus::Closed => PullRequestStatus::Closed,
        // Open and Unknown both surface as "open" on the wire.
        MergeStatus::Open | MergeStatus::Unknown => PullRequestStatus::Open,
    }
}

#[allow(deprecated)] // `issue_id` is deprecated on the wire type but still required.
fn to_api_pr(pr: DbPullRequest, project_id: Uuid, issue_id: Uuid) -> ApiPullRequest {
    ApiPullRequest {
        id: Uuid::parse_str(&pr.id).unwrap_or_else(|_| Uuid::nil()),
        url: pr.pr_url,
        number: pr.pr_number as i32,
        status: pr_status_to_api(pr.pr_status),
        merged_at: pr.merged_at,
        merge_commit_sha: pr.merge_commit_sha,
        target_branch_name: pr.target_branch_name,
        project_id,
        issue_id,
        workspace_id: pr.workspace_id,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
    }
}

// --- projects / statuses ----------------------------------------------------

async fn list_projects(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ListProjectsResponse>>, ApiError> {
    let projects = DbProject::find_all(&deployment.db().pool)
        .await?
        .into_iter()
        .map(to_api_project)
        .collect();
    Ok(ok(ListProjectsResponse { projects }))
}

async fn list_project_statuses(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<ApiResponse<ListProjectStatusesResponse>>, ApiError> {
    let project_statuses = DbProjectStatus::list_by_project(&deployment.db().pool, q.project_id)
        .await?
        .into_iter()
        .map(to_api_status)
        .collect();
    Ok(ok(ListProjectStatusesResponse { project_statuses }))
}

async fn list_project_tags(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<ApiResponse<ListTagsResponse>>, ApiError> {
    let tags = KanbanTag::list_by_project(&deployment.db().pool, q.project_id)
        .await?
        .into_iter()
        .map(to_api_tag)
        .collect();
    Ok(ok(ListTagsResponse { tags }))
}

// --- issues -----------------------------------------------------------------

async fn list_issues(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ProjectScope>,
) -> Result<ResponseJson<ApiResponse<ListIssuesResponse>>, ApiError> {
    let issues: Vec<ApiIssue> = DbIssue::list_by_project(&deployment.db().pool, q.project_id)
        .await?
        .into_iter()
        .map(to_api_issue)
        .collect();
    let total_count = issues.len();
    Ok(ok(ListIssuesResponse {
        issues,
        total_count,
        limit: total_count,
        offset: 0,
    }))
}

async fn search_issues(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<SearchIssuesRequest>,
) -> Result<ResponseJson<ApiResponse<ListIssuesResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let mut issues = DbIssue::list_by_project(pool, req.project_id).await?;

    if let Some(status_id) = req.status_id {
        issues.retain(|i| i.status_id == status_id);
    }
    if let Some(ref status_ids) = req.status_ids {
        let set: HashSet<Uuid> = status_ids.iter().copied().collect();
        issues.retain(|i| set.contains(&i.status_id));
    }
    if let Some(priority) = req.priority {
        let p = priority_str(&priority);
        issues.retain(|i| i.priority.as_deref() == Some(p));
    }
    if let Some(parent_issue_id) = req.parent_issue_id {
        issues.retain(|i| i.parent_issue_id == Some(parent_issue_id));
    }
    if let Some(ref search) = req.search {
        let needle = search.to_lowercase();
        issues.retain(|i| {
            i.title.to_lowercase().contains(&needle)
                || i.description
                    .as_deref()
                    .map(|d| d.to_lowercase().contains(&needle))
                    .unwrap_or(false)
        });
    }
    if let Some(ref simple_id) = req.simple_id {
        issues.retain(|i| i.simple_id.eq_ignore_ascii_case(simple_id));
    }
    let tag_filter: Option<HashSet<Uuid>> = match (req.tag_id, &req.tag_ids) {
        (Some(t), _) => Some(std::iter::once(t).collect()),
        (None, Some(ts)) => Some(ts.iter().copied().collect()),
        _ => None,
    };
    if let Some(tagset) = tag_filter {
        let tagged: HashSet<Uuid> = DbIssueTag::list_by_project(pool, req.project_id)
            .await?
            .into_iter()
            .filter(|it| tagset.contains(&it.tag_id))
            .map(|it| it.issue_id)
            .collect();
        issues.retain(|i| tagged.contains(&i.id));
    }

    let sort_field = req.sort_field.unwrap_or(IssueSortField::SortOrder);
    let descending = matches!(req.sort_direction, Some(SortDirection::Desc));
    issues.sort_by(|a, b| {
        let ord = match sort_field {
            IssueSortField::SortOrder => a
                .sort_order
                .partial_cmp(&b.sort_order)
                .unwrap_or(std::cmp::Ordering::Equal),
            IssueSortField::Priority => {
                priority_rank(a.priority.as_deref()).cmp(&priority_rank(b.priority.as_deref()))
            }
            IssueSortField::CreatedAt => a.created_at.cmp(&b.created_at),
            IssueSortField::UpdatedAt => a.updated_at.cmp(&b.updated_at),
            IssueSortField::Title => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
        };
        if descending { ord.reverse() } else { ord }
    });

    let total_count = issues.len();
    let offset = req.offset.unwrap_or(0).max(0) as usize;
    let limit = req.limit.unwrap_or(50).max(0) as usize;
    let page: Vec<ApiIssue> = issues
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(to_api_issue)
        .collect();

    Ok(ok(ListIssuesResponse {
        issues: page,
        total_count,
        limit,
        offset,
    }))
}

async fn get_issue(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<ApiIssue>>, ApiError> {
    let issue = DbIssue::find_by_id(&deployment.db().pool, id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("issue not found".into()))?;
    Ok(ok(to_api_issue(issue)))
}

#[derive(Debug, Deserialize)]
struct DispatchToWorkspaceRequest {
    workspace_id: Uuid,
    /// Optional explicit session to dispatch into. Defaults to the workspace's
    /// latest session. When provided, must belong to `workspace_id`.
    #[serde(default)]
    session_id: Option<Uuid>,
}

/// Run an issue in an existing workspace: sends the issue's title + description
/// to the workspace's (latest, or `session_id`) session as a follow-up prompt
/// (context retained), spawning a coding-agent execution. Returns the same
/// envelope as `POST /api/sessions/{id}/follow-up`.
///
/// This is the single owner of the dispatch guard matrix (archived workspace,
/// orchestrator workspace, concurrent-run, resume-stage prompt) — the MCP
/// `run_issue_in_workspace` tool delegates here so the two paths cannot drift.
async fn dispatch_issue_to_workspace(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Json(body): Json<DispatchToWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<FollowUpResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let issue = DbIssue::find_by_id(pool, id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("issue not found".into()))?;

    let workspace = Workspace::find_by_id(pool, body.workspace_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("workspace not found".into()))?;

    // Cannot dispatch into an archived workspace.
    if workspace.archived {
        return Err(ApiError::BadRequest(format!(
            "cannot dispatch to archived workspace '{}'",
            workspace.name.as_deref().unwrap_or("")
        )));
    }

    // The orchestrator is a special workspace (headed /loop session); dispatching
    // a card into it would corrupt its orchestration loop.
    if workspace.kind == Some(WorkspaceKind::Orchestrator) {
        return Err(ApiError::BadRequest(
            "cannot dispatch a card to the orchestrator workspace".to_string(),
        ));
    }

    // Resolve the target session: an explicit one (must belong to this
    // workspace) or the workspace's latest. The MCP tool and the UI both
    // delegate here, so session ownership is validated in one place.
    let session = match body.session_id {
        Some(session_id) => {
            let session = Session::find_by_id(pool, session_id)
                .await?
                .ok_or_else(|| ApiError::BadRequest("session not found".into()))?;
            if session.workspace_id != workspace.id {
                return Err(ApiError::BadRequest(format!(
                    "session {session_id} does not belong to workspace {}",
                    workspace.id
                )));
            }
            session
        }
        None => Session::find_latest_by_workspace_id(pool, workspace.id)
            .await?
            .ok_or_else(|| ApiError::BadRequest("workspace has no sessions".into()))?,
    };

    // Reject concurrent dispatch: a second agent process on the same session
    // would corrupt the conversation. (The DB unique partial index is the hard
    // guarantee against the check-then-act race; this preflight just gives a
    // clean 409 before we mutate anything.)
    if ExecutionProcess::has_running_coding_agent_for_session(pool, session.id).await? {
        return Err(ApiError::Conflict(
            "workspace session is currently executing; wait for it to finish before dispatching another card"
                .to_string(),
        ));
    }

    // Re-dispatch of the SAME card the workspace is currently on: if it already
    // ran pipeline stages, tell the agent to continue from the next stage rather
    // than restart the whole pipeline. Only applies when this card is the
    // workspace's current linked card (the stage counter is workspace-scoped).
    let current_link =
        IssueWorkspace::find_issue_and_project_by_workspace(pool, workspace.id).await?;
    let resume_stage = if workspace
        .current_pipeline_stage
        .map(|s| s > 0)
        .unwrap_or(false)
    {
        match current_link {
            Some((current_issue_id, _)) if current_issue_id == id => {
                workspace.current_pipeline_stage
            }
            _ => None,
        }
    } else {
        None
    };

    let mut prompt = match &issue.description {
        Some(desc) if !desc.is_empty() => format!("{}\n\n{}", issue.title, desc),
        _ => issue.title.clone(),
    };
    if let Some(stage) = resume_stage {
        prompt = format!(
            "You previously worked on this issue and completed stages 1 through {stage}. \
             The card text below includes the full pipeline for context. \
             Continue from stage {next}.\n\n{prompt}",
            next = stage + 1,
        );
    }

    // Preserve the session's last-used executor profile (variant/preset) instead
    // of dropping back to the base default — a workspace on a custom preset
    // would otherwise lose it on its next card. Falls back to the session's base
    // executor when there's no prior coding-agent run.
    let executor_config =
        match ExecutionProcess::latest_executor_profile_for_session(pool, session.id).await? {
            Some(profile) => ExecutorConfig::from(profile),
            None => {
                let executor_str = session.executor.as_deref().ok_or_else(|| {
                    ApiError::BadRequest("session has no executor configured".into())
                })?;
                let executor = BaseCodingAgent::from_str(executor_str)
                    .map_err(|error| ApiError::BadRequest(format!("invalid executor: {error}")))?;
                ExecutorConfig::new(executor)
            }
        };

    // Spawn first: this can still fail with a 409 (the DB unique partial index
    // is the hard gate against a concurrent dispatch between the advisory
    // preflight above and here) or a container-start error. Nothing below
    // mutates until it has succeeded, so a failed dispatch leaves the
    // workspace linked to its ORIGINAL card with its pipeline stage intact.
    let workspace_id = workspace.id;
    let response = run_follow_up(
        &deployment,
        session,
        workspace,
        prompt,
        executor_config,
        None,
        None,
        None,
    )
    .await?;

    // Only now that the execution is guaranteed to be running: move the
    // workspace's link to this card and (for a fresh card) clear any stale
    // pipeline stage from the previous card so the board doesn't show old
    // progress against the new one.
    if resume_stage.is_none() {
        Workspace::set_current_pipeline_stage(pool, workspace_id, None).await?;
    }
    IssueWorkspace::link(pool, id, workspace_id).await?;

    Ok(response)
}

async fn create_issue(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<CreateIssueRequest>,
) -> Result<ResponseJson<ApiResponse<MutationResponse<ApiIssue>>>, ApiError> {
    let issue = create_issue_record(&deployment.db().pool, req).await?;
    Ok(mutated(to_api_issue(issue)))
}

async fn update_issue(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateIssueRequest>,
) -> Result<ResponseJson<ApiResponse<MutationResponse<ApiIssue>>>, ApiError> {
    let issue = merge_and_update_issue(&deployment.db().pool, id, req)
        .await?
        .ok_or_else(|| ApiError::BadRequest("issue not found".into()))?;
    Ok(mutated(to_api_issue(issue)))
}

async fn delete_issue(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    DbIssue::delete(&deployment.db().pool, id).await?;
    Ok(ok(()))
}

async fn list_issue_pull_requests(
    State(deployment): State<DeploymentImpl>,
    Path(issue_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<ListPullRequestsResponse>>, ApiError> {
    let pool = &deployment.db().pool;
    let Some(issue) = DbIssue::find_by_id(pool, issue_id).await? else {
        return Ok(ok(ListPullRequestsResponse {
            pull_requests: vec![],
        }));
    };

    let workspace_ids: Vec<Uuid> = IssueWorkspace::list_linked_all(pool)
        .await?
        .into_iter()
        .filter(|l| l.issue_id == issue_id)
        .map(|l| l.workspace_id)
        .collect();

    let mut pull_requests = Vec::new();
    for workspace_id in workspace_ids {
        for pr in DbPullRequest::find_by_workspace_id(pool, workspace_id).await? {
            pull_requests.push(to_api_pr(pr, issue.project_id, issue_id));
        }
    }
    Ok(ok(ListPullRequestsResponse { pull_requests }))
}

// --- issue tags -------------------------------------------------------------

async fn list_issue_tags(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<IssueScope>,
) -> Result<ResponseJson<ApiResponse<ListIssueTagsResponse>>, ApiError> {
    let issue_tags = DbIssueTag::list_by_issue(&deployment.db().pool, q.issue_id)
        .await?
        .into_iter()
        .map(to_api_issue_tag)
        .collect();
    Ok(ok(ListIssueTagsResponse { issue_tags }))
}

async fn create_issue_tag(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<CreateIssueTagRequest>,
) -> Result<ResponseJson<ApiResponse<MutationResponse<ApiIssueTag>>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = DbIssueTag::create(&deployment.db().pool, id, req.issue_id, req.tag_id).await?;
    Ok(mutated(to_api_issue_tag(row)))
}

async fn delete_issue_tag(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    DbIssueTag::delete(&deployment.db().pool, id).await?;
    Ok(ok(()))
}

// --- issue relationships ----------------------------------------------------

async fn list_issue_relationships(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<ListIssueRelationshipsQuery>,
) -> Result<ResponseJson<ApiResponse<ListIssueRelationshipsResponse>>, ApiError> {
    list_issue_relationships_with_pool(&deployment.db().pool, q).await
}

/// One route, two scopes (same `ListIssueRelationshipsResponse` shape):
///
/// - `?issue_id=` — unchanged: that issue's OUTGOING rows only.
/// - `?project_id=` — the project's whole edge set in one call, so the
///   orchestrator's lane dependency gate costs one request per sweep instead of
///   one per non-terminal card (which is what forced it to cap the gate and
///   hold candidates it could not verify).
///
/// Exactly one is required: neither is an unscoped table read, and both at once
/// is an ambiguous caller rather than a meaningful intersection.
async fn list_issue_relationships_with_pool(
    pool: &sqlx::SqlitePool,
    q: ListIssueRelationshipsQuery,
) -> Result<ResponseJson<ApiResponse<ListIssueRelationshipsResponse>>, ApiError> {
    let rows = match (q.issue_id, q.project_id) {
        (Some(issue_id), None) => DbIssueRelationship::list_by_issue(pool, issue_id).await?,
        (None, Some(project_id)) => DbIssueRelationship::list_by_project(pool, project_id).await?,
        (Some(_), Some(_)) => {
            return Err(ApiError::BadRequest(
                "provide either issue_id or project_id, not both".into(),
            ));
        }
        (None, None) => {
            return Err(ApiError::BadRequest(
                "issue_id or project_id is required".into(),
            ));
        }
    };
    Ok(ok(ListIssueRelationshipsResponse {
        issue_relationships: rows.into_iter().map(to_api_relationship).collect(),
    }))
}

async fn create_issue_relationship(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<CreateIssueRelationshipRequest>,
) -> Result<ResponseJson<ApiResponse<MutationResponse<ApiIssueRelationship>>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = DbIssueRelationship::create(
        &deployment.db().pool,
        id,
        req.issue_id,
        req.related_issue_id,
        rel_type_to_str(req.relationship_type),
    )
    .await?;
    Ok(mutated(to_api_relationship(row)))
}

async fn delete_issue_relationship(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    DbIssueRelationship::delete(&deployment.db().pool, id).await?;
    Ok(ok(()))
}

// --- workspace context ------------------------------------------------------

async fn workspace_issue_link(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<WorkspaceScope>,
) -> Result<ResponseJson<ApiResponse<WorkspaceIssueLink>>, ApiError> {
    let link =
        IssueWorkspace::find_issue_and_project_by_workspace(&deployment.db().pool, q.workspace_id)
            .await?;
    let (issue_id, project_id) = match link {
        Some((issue_id, project_id)) => (Some(issue_id), Some(project_id)),
        None => (None, None),
    };
    Ok(ok(WorkspaceIssueLink {
        project_id,
        issue_id,
    }))
}

/// Every issue↔workspace link in one call. Backed by `list_linked_all`, whose
/// JOINs against `issues`/`workspaces` naturally exclude dangling links.
async fn list_workspace_issue_links(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<Vec<WorkspaceIssueLinkRow>>>, ApiError> {
    let links = IssueWorkspace::list_linked_all(&deployment.db().pool)
        .await?
        .into_iter()
        .map(|link| WorkspaceIssueLinkRow {
            workspace_id: link.workspace_id,
            issue_id: link.issue_id,
        })
        .collect();
    Ok(ok(links))
}

#[derive(Debug, Deserialize)]
pub struct AssociateAttachmentsRequest {
    pub attachment_ids: Vec<Uuid>,
}

async fn link_issue_attachments(
    State(deployment): State<DeploymentImpl>,
    Path(issue_id): Path<Uuid>,
    axum::Json(payload): axum::Json<AssociateAttachmentsRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    IssueAttachment::associate_many_dedup(&deployment.db().pool, issue_id, &payload.attachment_ids)
        .await?;
    Ok(ok(()))
}

async fn link_comment_attachments(
    State(deployment): State<DeploymentImpl>,
    Path(comment_id): Path<Uuid>,
    axum::Json(payload): axum::Json<AssociateAttachmentsRequest>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    CommentAttachment::associate_many_dedup(
        &deployment.db().pool,
        comment_id,
        &payload.attachment_ids,
    )
    .await?;
    Ok(ok(()))
}

// --- orchestrator prompts (ADR-016) -----------------------------------------
//
// Three endpoints, all envelope-wrapped so the MCP tool
// (`get_orchestrator_prompt` in `crates/mcp/src/task_server/tools/orchestrator_prompt.rs`)
// and the frontend editor (`projectsApi.*OrchestratorPrompt` in
// `packages/web-core/src/shared/lib/api.ts`) can share one wire shape. The
// editor fetches the raw value to seed its textarea; the MCP tool fetches the
// resolved value to drive each tick.

/// GET raw local value. The editor seeds its textarea from this.
async fn get_project_orchestrator_prompt(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<OrchestratorPromptResponse>>, ApiError> {
    get_project_orchestrator_prompt_with_pool(&deployment.db().pool, id).await
}

async fn get_project_orchestrator_prompt_with_pool(
    pool: &sqlx::SqlitePool,
    id: Uuid,
) -> Result<ResponseJson<ApiResponse<OrchestratorPromptResponse>>, ApiError> {
    let project = DbProject::find_by_id(pool, id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("project not found".into()))?;
    Ok(ok(OrchestratorPromptResponse {
        project_id: project.id,
        orchestrator_prompt: project.orchestrator_prompt,
    }))
}

/// PUT replaces the prompt (REPLACE semantics — no deep-merge). Empty string
/// clears.
///
/// Single round-trip: rely on `update_orchestrator_prompt`'s `RowNotFound`
/// instead of a separate `find_by_id` existence check (E1: the preflight was a
/// TOCTOU — between the check and the UPDATE another tx could DELETE the
/// row, returning a 500).
async fn put_project_orchestrator_prompt(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateOrchestratorPromptRequest>,
) -> Result<ResponseJson<ApiResponse<OrchestratorPromptResponse>>, ApiError> {
    put_project_orchestrator_prompt_with_pool(&deployment.db().pool, id, req).await
}

async fn put_project_orchestrator_prompt_with_pool(
    pool: &sqlx::SqlitePool,
    id: Uuid,
    req: UpdateOrchestratorPromptRequest,
) -> Result<ResponseJson<ApiResponse<OrchestratorPromptResponse>>, ApiError> {
    let updated = DbProject::update_orchestrator_prompt(pool, id, &req.orchestrator_prompt)
        .await
        .map_err(|err| match err {
            sqlx::Error::RowNotFound => ApiError::BadRequest("project not found".into()),
            other => ApiError::Database(other),
        })?;
    Ok(ok(OrchestratorPromptResponse {
        project_id: updated.id,
        orchestrator_prompt: updated.orchestrator_prompt,
    }))
}

/// GET walked value + provenance. The MCP tool and the editor's
/// "Inherited from {name}" badge both consume this shape (single source of
/// truth).
///
/// Resolver double-read note: we deliberately skip a `find_by_id` existence
/// preflight — `resolve_orchestrator_prompt` returns `("", None)` for a
/// missing project (the row is simply absent when walked), the same shape
/// it returns for an all-empty chain. Both collapse to `source = "default"`
/// which is the correct answer for a missing row too (orchestrator uses
/// built-in behavior; editor shows the "Using default behavior" badge).
/// `Self_` vs `Ancestor` is distinguished without an extra read by comparing
/// the resolver's `source_project_id` to the path's `id` — the resolver
/// returns the id of the MOST-SPECIFIC (top-of-stack) prompt row, which is
/// `Some(local_id)` only when the local row itself contributed a prompt.
///
/// ADR-016 (stack amendment): `orchestrator_prompt` is no longer a single
/// walked value — it's the rendered stack (preamble + `[Board: …]` /
/// `[Project: …]` sections) emitted by `resolve_orchestrator_prompt`. The
/// `source_project_id` / `source` semantics are unchanged at the
/// top-of-stack granularity (where the most-specific section came from).
async fn resolve_project_orchestrator_prompt(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<ResolvedOrchestratorPromptResponse>>, ApiError> {
    resolve_project_orchestrator_prompt_with_pool(&deployment.db().pool, id).await
}

async fn resolve_project_orchestrator_prompt_with_pool(
    pool: &sqlx::SqlitePool,
    id: Uuid,
) -> Result<ResponseJson<ApiResponse<ResolvedOrchestratorPromptResponse>>, ApiError> {
    let (prompt, source_project_id) = DbProject::resolve_orchestrator_prompt(pool, id).await?;
    Ok(ok(ResolvedOrchestratorPromptResponse {
        project_id: id,
        orchestrator_prompt: prompt,
        source_project_id,
        source: resolve_source_kind(id, source_project_id),
    }))
}

/// Map `(path_id, source_project_id)` to the wire `OrchestratorPromptSource`
/// enum. Pulled out so the mapping can be unit-tested without standing up an
/// axum handler. The resolver walks the chain collecting a stack of prompts;
/// `source_project_id` is the id of the MOST-SPECIFIC (first / top-of-stack)
/// prompt — i.e. the queried row if it had a prompt, else the nearest
/// ancestor that did. If that id equals `path_id`, the local row is on the
/// stack (`Self_`); if not, only ancestors contributed (`Ancestor`). `None`
/// means no prompt at any scope (`Default`). This avoids the second
/// `find_by_id` round-trip the original handler had.
fn resolve_source_kind(path_id: Uuid, source_project_id: Option<Uuid>) -> OrchestratorPromptSource {
    match source_project_id {
        Some(source_id) if source_id == path_id => OrchestratorPromptSource::Self_,
        Some(_) => OrchestratorPromptSource::Ancestor,
        None => OrchestratorPromptSource::Default,
    }
}

pub fn router(_deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    Router::new()
        .route("/projects", get(list_projects))
        .route("/project-statuses", get(list_project_statuses))
        .route("/project-tags", get(list_project_tags))
        // ADR-016: orchestrator prompt endpoints. Envelope-wrapped because
        // BOTH consumers (MCP `get_orchestrator_prompt`, frontend editor)
        // speak the `ApiResponse` contract (see `routes/mod.rs` doc — the
        // `/v1/*` router returns bare/MutationResponse shapes; `/api/*`
        // returns `ApiResponse` envelopes).
        //
        // The `/resolve` sub-resource is registered on a separate static
        // route because matchit resolves static segments before dynamic
        // ones — keeping it on the same `/projects/{id}/orchestrator-prompt`
        // route would make `/resolve` a candidate for `{id}`.
        .route(
            "/projects/{id}/orchestrator-prompt",
            get(get_project_orchestrator_prompt).put(put_project_orchestrator_prompt),
        )
        .route(
            "/projects/{id}/orchestrator-prompt/resolve",
            get(resolve_project_orchestrator_prompt),
        )
        .route("/issues", get(list_issues).post(create_issue))
        .route("/issues/search", post(search_issues))
        .route(
            "/issues/{id}",
            get(get_issue).patch(update_issue).delete(delete_issue),
        )
        .route("/issues/{id}/pull-requests", get(list_issue_pull_requests))
        .route(
            "/issues/{id}/dispatch-to-workspace",
            post(dispatch_issue_to_workspace),
        )
        .route("/issues/{id}/attachments", post(link_issue_attachments))
        .route("/comments/{id}/attachments", post(link_comment_attachments))
        .route("/issue-tags", get(list_issue_tags).post(create_issue_tag))
        .route("/issue-tags/{id}", delete(delete_issue_tag))
        .route(
            "/issue-relationships",
            get(list_issue_relationships).post(create_issue_relationship),
        )
        .route(
            "/issue-relationships/{id}",
            delete(delete_issue_relationship),
        )
        .route("/workspace-issue-link", get(workspace_issue_link))
        .route("/workspace-issue-links", get(list_workspace_issue_links))
}

#[cfg(test)]
mod tests {
    use super::super::local_kanban::clear_key_chain_cache;
    use db::models::project::{NewProject, Project as DbProject};
    use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
    use uuid::Uuid;

    use super::super::local_kanban::derive_key_chain;

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
    async fn orchestrator_prompt_routes_return_single_wrapped_envelopes() {
        use api_types::UpdateOrchestratorPromptRequest;
        use axum::{
            Router,
            body::{Body, to_bytes},
            extract::{Json, Path, State},
            http::{Request, StatusCode},
            routing::get,
        };
        use serde_json::{Value, json};
        use tower::ServiceExt;

        async fn put_prompt(
            State(pool): State<SqlitePool>,
            Path(id): Path<Uuid>,
            Json(req): Json<UpdateOrchestratorPromptRequest>,
        ) -> Result<impl axum::response::IntoResponse, crate::error::ApiError> {
            super::put_project_orchestrator_prompt_with_pool(&pool, id, req).await
        }

        async fn get_prompt(
            State(pool): State<SqlitePool>,
            Path(id): Path<Uuid>,
        ) -> Result<impl axum::response::IntoResponse, crate::error::ApiError> {
            super::get_project_orchestrator_prompt_with_pool(&pool, id).await
        }

        async fn resolve_prompt(
            State(pool): State<SqlitePool>,
            Path(id): Path<Uuid>,
        ) -> Result<impl axum::response::IntoResponse, crate::error::ApiError> {
            super::resolve_project_orchestrator_prompt_with_pool(&pool, id).await
        }

        let pool = pool().await;
        let project_id = Uuid::new_v4();
        DbProject::create(
            &pool,
            NewProject {
                id: project_id,
                name: "Prompt test",
                key: Some("PROMPT"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();

        let app = Router::new()
            .route(
                "/api/projects/{id}/orchestrator-prompt",
                axum::routing::put(put_prompt).get(get_prompt),
            )
            .route(
                "/api/projects/{id}/orchestrator-prompt/resolve",
                get(resolve_prompt),
            )
            .with_state(pool);

        let put_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/projects/{project_id}/orchestrator-prompt"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "orchestrator_prompt": "Ship safely" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(put_response.status(), StatusCode::OK);
        let put_body: Value = serde_json::from_slice(
            &to_bytes(put_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(put_body["data"]["project_id"], json!(project_id));
        assert_eq!(put_body["data"]["orchestrator_prompt"], "Ship safely");
        assert!(put_body["data"].get("data").is_none());

        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/projects/{project_id}/orchestrator-prompt"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);
        let get_body: Value = serde_json::from_slice(
            &to_bytes(get_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(get_body["data"]["project_id"], json!(project_id));
        assert_eq!(get_body["data"]["orchestrator_prompt"], "Ship safely");
        assert!(get_body["data"].get("data").is_none());

        let resolve_response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/projects/{project_id}/orchestrator-prompt/resolve"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resolve_response.status(), StatusCode::OK);
        let resolve_body: Value = serde_json::from_slice(
            &to_bytes(resolve_response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(resolve_body["data"]["project_id"], json!(project_id));
        // ADR-016 (stack amendment): resolve no longer returns the raw
        // walked value — it returns the rendered stack (preamble +
        // labeled sections). For a root project with its own prompt and
        // no parent, the stack is exactly one `[Project: …]` section.
        let resolved_prompt = resolve_body["data"]["orchestrator_prompt"]
            .as_str()
            .expect("orchestrator_prompt must be a JSON string (the rendered stack)");
        assert!(
            resolved_prompt.contains("[Project: Ship safely]"),
            "root-only stack must contain the Project section; got:\n{resolved_prompt}"
        );
        assert!(
            !resolved_prompt.contains("[Board:"),
            "no board scope here → no Board section; got:\n{resolved_prompt}"
        );
        assert!(resolved_prompt.contains("MANDATORY"));
        assert!(resolved_prompt.contains("<orchestrator_prompt_stack>"));
        assert_eq!(resolve_body["data"]["source_project_id"], json!(project_id));
        assert_eq!(resolve_body["data"]["source"], "self");
        assert!(resolve_body["data"].get("data").is_none());
    }

    /// B-1 regression: the MCP `create_issue` path must produce a chain-prefixed
    /// key for nested projects, not a leaf key. `derive_key_chain` is the single
    /// function the handler relies on now; assert it walks the parent chain.
    #[tokio::test]
    async fn mcp_create_issue_uses_chain_key_for_nested_projects() {
        clear_key_chain_cache();
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let sub_id = Uuid::new_v4();
        let leaf_id = Uuid::new_v4();

        DbProject::create(
            &pool,
            NewProject {
                id: root_id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        DbProject::create(
            &pool,
            NewProject {
                id: sub_id,
                name: "Sub",
                key: Some("SUB"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(root_id),
            },
        )
        .await
        .unwrap();
        DbProject::create(
            &pool,
            NewProject {
                id: leaf_id,
                name: "X",
                key: Some("X"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(sub_id),
            },
        )
        .await
        .unwrap();

        let root_key = derive_key_chain(&pool, root_id).await.unwrap();
        let sub_key = derive_key_chain(&pool, sub_id).await.unwrap();
        let leaf_key = derive_key_chain(&pool, leaf_id).await.unwrap();

        assert_eq!(root_key, "ACME");
        assert_eq!(sub_key, "ACME-SUB");
        assert_eq!(leaf_key, "ACME-SUB-X");
    }

    /// A board's lanes: `lanes[i][j]` is the j-th card of lane i, chained
    /// `card0 -blocking-> card1 -> card2 -> ...` within the lane and sharing no
    /// edge across lanes (that absence of an edge is the parallelism).
    struct Board {
        project_id: Uuid,
        lanes: Vec<Vec<Uuid>>,
    }

    /// Seed `lanes` × `cards_per_lane` issues in a fresh project, chained by
    /// `blocking` edges inside each lane.
    async fn seed_board(
        pool: &SqlitePool,
        key: &str,
        lanes: usize,
        cards_per_lane: usize,
    ) -> Board {
        use super::{DbIssue, DbIssueRelationship, DbProjectStatus};
        use db::models::issue::NewIssue;

        clear_key_chain_cache();
        let project_id = Uuid::new_v4();
        DbProject::create(
            pool,
            NewProject {
                id: project_id,
                name: key,
                key: Some(key),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();

        let status_id = Uuid::new_v4();
        DbProjectStatus::create(
            pool, status_id, project_id, "Todo", "#94a3b8", 0, false, false,
        )
        .await
        .unwrap();

        let mut board = Board {
            project_id,
            lanes: Vec::new(),
        };
        for lane in 0..lanes {
            let mut cards = Vec::new();
            for card in 0..cards_per_lane {
                let id = Uuid::new_v4();
                DbIssue::create(
                    pool,
                    NewIssue {
                        id,
                        project_id,
                        status_id,
                        title: &format!("{key} lane {lane} card {card}"),
                        description: None,
                        priority: None,
                        start_date: None,
                        target_date: None,
                        completed_at: None,
                        sort_order: card as f64,
                        parent_issue_id: None,
                        parent_issue_sort_order: None,
                        extension_metadata: "{}",
                        key,
                    },
                )
                .await
                .unwrap();
                cards.push(id);
            }
            for pair in cards.windows(2) {
                DbIssueRelationship::create(pool, Uuid::new_v4(), pair[0], pair[1], "blocking")
                    .await
                    .unwrap();
            }
            board.lanes.push(cards);
        }
        board
    }

    /// The route under test, wired to a bare pool the way the real handler is
    /// wired to the deployment's pool.
    fn relationships_app(pool: SqlitePool) -> axum::Router {
        use api_types::ListIssueRelationshipsQuery;
        use axum::{
            Router,
            extract::{Query, State},
            routing::get,
        };

        async fn list_rels(
            State(pool): State<SqlitePool>,
            Query(q): Query<ListIssueRelationshipsQuery>,
        ) -> Result<impl axum::response::IntoResponse, crate::error::ApiError> {
            super::list_issue_relationships_with_pool(&pool, q).await
        }

        Router::new()
            .route("/api/issue-relationships", get(list_rels))
            .with_state(pool)
    }

    async fn get_json(
        app: &axum::Router,
        uri: &str,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        use axum::{
            body::{Body, to_bytes},
            http::Request,
        };
        use tower::ServiceExt;

        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    /// VIBE-3: the lane dependency gate must be able to read a board's whole
    /// edge set in ONE call. 3 lanes × 4 cards = 9 `blocking` edges; a second
    /// project's edges must not leak in.
    #[tokio::test]
    async fn project_scope_returns_the_whole_edge_set_in_one_call() {
        use axum::http::StatusCode;

        let pool = pool().await;
        let board = seed_board(&pool, "LANE", 3, 4).await;
        let other = seed_board(&pool, "OTHER", 2, 3).await;
        let app = relationships_app(pool);

        let (status, body) = get_json(
            &app,
            &format!("/api/issue-relationships?project_id={}", board.project_id),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let rows = body["data"]["issue_relationships"].as_array().unwrap();
        // 3 lanes × (4 cards - 1) chain edges.
        assert_eq!(rows.len(), 9, "whole edge set in one call; got {rows:#?}");

        let mut got: Vec<(Uuid, Uuid)> = rows
            .iter()
            .map(|r| {
                (
                    serde_json::from_value(r["issue_id"].clone()).unwrap(),
                    serde_json::from_value(r["related_issue_id"].clone()).unwrap(),
                )
            })
            .collect();
        let mut expected: Vec<(Uuid, Uuid)> = board
            .lanes
            .iter()
            .flat_map(|lane| lane.windows(2).map(|p| (p[0], p[1])))
            .collect();
        got.sort();
        expected.sort();
        assert_eq!(got, expected, "edges must be this project's chains exactly");

        let other_cards: Vec<Uuid> = other.lanes.into_iter().flatten().collect();
        assert!(
            !got.iter()
                .any(|(a, b)| other_cards.contains(a) || other_cards.contains(b)),
            "another project's edges must not leak into a project-scoped read"
        );
    }

    /// The pre-existing `?issue_id=` contract is load-bearing for its current
    /// caller: OUTGOING rows only (`WHERE issue_id = ?`), same envelope, same
    /// row fields. Adding `?project_id=` must not move any of it.
    #[tokio::test]
    async fn issue_scope_response_shape_is_unchanged() {
        use axum::http::StatusCode;
        use serde_json::json;

        let pool = pool().await;
        let board = seed_board(&pool, "PIN", 1, 3).await;
        let app = relationships_app(pool);
        // The middle card: blocked by card 0, blocking card 2. Only the
        // outgoing edge may come back.
        let (a, b, c) = (board.lanes[0][0], board.lanes[0][1], board.lanes[0][2]);

        let (status, body) =
            get_json(&app, &format!("/api/issue-relationships?issue_id={b}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], json!(true));

        let rows = body["data"]["issue_relationships"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            1,
            "outgoing rows only — the a->b edge is not b's"
        );
        let row = rows[0].as_object().unwrap();
        let mut keys: Vec<&str> = row.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "created_at",
                "id",
                "issue_id",
                "related_issue_id",
                "relationship_type"
            ],
            "row fields are the frozen wire shape"
        );
        assert_eq!(row["issue_id"], json!(b));
        assert_eq!(row["related_issue_id"], json!(c));
        assert_eq!(row["relationship_type"], json!("blocking"));
        assert_ne!(row["issue_id"], json!(a));

        // Exactly one scope: neither and both are caller errors, not an
        // unscoped table read.
        let (status, _) = get_json(&app, "/api/issue-relationships").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = get_json(
            &app,
            &format!(
                "/api/issue-relationships?issue_id={b}&project_id={}",
                board.project_id
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    /// The kanban router must build without a matchit path conflict (e.g.
    /// `/issues/search` static vs `/issues/{id}` param).
    #[test]
    fn router_builds_without_route_conflicts() {
        // Router construction panics on conflict; just ensure the route table
        // assembles. We can't build a DeploymentImpl here, so re-declare the
        // same paths to exercise matchit.
        let _r: axum::Router<()> = axum::Router::new()
            .route("/issues", axum::routing::get(|| async {}))
            .route("/issues/search", axum::routing::post(|| async {}))
            .route("/issues/{id}", axum::routing::get(|| async {}))
            .route(
                "/issues/{id}/pull-requests",
                axum::routing::get(|| async {}),
            )
            .route(
                "/projects/{id}/orchestrator-prompt",
                axum::routing::get(|| async {}).put(|| async {}),
            )
            .route(
                "/projects/{id}/orchestrator-prompt/resolve",
                axum::routing::get(|| async {}),
            );
    }

    /// ADR-016: `resolve_source_kind` is the branchy bit of the resolve
    /// handler — it must correctly distinguish `Self_` (local row supplied
    /// the prompt), `Ancestor` (an ancestor did), and `Default` (no prompt
    /// at any scope). The mapping now uses ONLY `(path_id,
    /// source_project_id)` — no second `find_by_id` call — so the test
    /// verifies that contract.
    #[test]
    fn resolve_source_kind_maps_path_and_source_to_wire_enum() {
        use api_types::OrchestratorPromptSource;
        let path_id = Uuid::new_v4();
        let ancestor_id = Uuid::new_v4();

        // Resolver returned the local row → `Self_`.
        assert!(matches!(
            super::resolve_source_kind(path_id, Some(path_id)),
            OrchestratorPromptSource::Self_
        ));

        // Resolver returned an ancestor id (≠ path_id) → `Ancestor`.
        assert!(matches!(
            super::resolve_source_kind(path_id, Some(ancestor_id)),
            OrchestratorPromptSource::Ancestor
        ));

        // Resolver returned nothing → `Default`.
        assert!(matches!(
            super::resolve_source_kind(path_id, None),
            OrchestratorPromptSource::Default
        ));

        // Wire shape: the JSON value of `Self_` MUST rename to `"self"`
        // (per ADR). Other variants lowercase naturally.
        assert_eq!(
            serde_json::to_value(OrchestratorPromptSource::Self_).unwrap(),
            serde_json::json!("self")
        );
        assert_eq!(
            serde_json::to_value(OrchestratorPromptSource::Ancestor).unwrap(),
            serde_json::json!("ancestor")
        );
        assert_eq!(
            serde_json::to_value(OrchestratorPromptSource::Default).unwrap(),
            serde_json::json!("default")
        );
    }
}
