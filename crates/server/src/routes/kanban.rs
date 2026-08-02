//! Local kanban API for the MCP server (envelope-wrapped).
//!
//! Re-homes the project/issue/tag/assignee/relationship endpoints `vibe-kanban-mcp`
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
    CreateIssueAssigneeRequest, CreateIssueRelationshipRequest, CreateIssueRequest,
    CreateIssueTagRequest, Issue as ApiIssue, IssueAssignee as ApiIssueAssignee, IssuePriority,
    IssueRelationship as ApiIssueRelationship, IssueRelationshipType, IssueSortField,
    IssueTag as ApiIssueTag, ListIssueAssigneesResponse, ListIssueRelationshipsResponse,
    ListIssueTagsResponse, ListIssuesResponse, ListProjectStatusesResponse, ListProjectsResponse,
    ListPullRequestsResponse, ListTagsResponse, MutationResponse, Project as ApiProject,
    ProjectStatus as ApiProjectStatus, PullRequest as ApiPullRequest, PullRequestStatus,
    SearchIssuesRequest, SortDirection, Tag as ApiTag, UpdateIssueRequest,
};
use axum::{
    Router,
    extract::{Json, Path, Query, State},
    response::Json as ResponseJson,
    routing::{delete, get, post},
};
use db::models::{
    execution_process::ExecutionProcess,
    issue::{Issue as DbIssue, NewIssue},
    issue_relationship::IssueRelationship as DbIssueRelationship,
    issue_workspace::IssueWorkspace,
    kanban_tag::{IssueAssignee as DbIssueAssignee, IssueTag as DbIssueTag, KanbanTag},
    local_user::LOCAL_USER_ID,
    merge::MergeStatus,
    project::{LOCAL_ORGANIZATION_ID, Project as DbProject},
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

use super::local_kanban::{derive_key, merge_and_update_issue};
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
        organization_id: LOCAL_ORGANIZATION_ID,
        name: p.name,
        color: p.color,
        sort_order: p.sort_order as i32,
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
        creator_user_id: i.creator_user_id,
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

fn to_api_assignee(a: DbIssueAssignee) -> ApiIssueAssignee {
    ApiIssueAssignee {
        id: a.id,
        issue_id: a.issue_id,
        user_id: a.user_id,
        assigned_at: a.assigned_at,
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
    if let Some(user_id) = req.assignee_user_id {
        let assigned: HashSet<Uuid> = DbIssueAssignee::list_by_project(pool, req.project_id)
            .await?
            .into_iter()
            .filter(|a| a.user_id == user_id)
            .map(|a| a.issue_id)
            .collect();
        issues.retain(|i| assigned.contains(&i.id));
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

// --- issue assignees --------------------------------------------------------

async fn list_issue_assignees(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<IssueScope>,
) -> Result<ResponseJson<ApiResponse<ListIssueAssigneesResponse>>, ApiError> {
    let issue_assignees = DbIssueAssignee::list_by_issue(&deployment.db().pool, q.issue_id)
        .await?
        .into_iter()
        .map(to_api_assignee)
        .collect();
    Ok(ok(ListIssueAssigneesResponse { issue_assignees }))
}

async fn create_issue_assignee(
    State(deployment): State<DeploymentImpl>,
    Json(req): Json<CreateIssueAssigneeRequest>,
) -> Result<ResponseJson<ApiResponse<MutationResponse<ApiIssueAssignee>>>, ApiError> {
    let id = req.id.unwrap_or_else(Uuid::new_v4);
    let row = DbIssueAssignee::create(&deployment.db().pool, id, req.issue_id, req.user_id).await?;
    Ok(mutated(to_api_assignee(row)))
}

async fn delete_issue_assignee(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<()>>, ApiError> {
    DbIssueAssignee::delete(&deployment.db().pool, id).await?;
    Ok(ok(()))
}

// --- issue relationships ----------------------------------------------------

async fn list_issue_relationships(
    State(deployment): State<DeploymentImpl>,
    Query(q): Query<IssueScope>,
) -> Result<ResponseJson<ApiResponse<ListIssueRelationshipsResponse>>, ApiError> {
    let issue_relationships = DbIssueRelationship::list_by_issue(&deployment.db().pool, q.issue_id)
        .await?
        .into_iter()
        .map(to_api_relationship)
        .collect();
    Ok(ok(ListIssueRelationshipsResponse {
        issue_relationships,
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

pub fn router(_deployment: &DeploymentImpl) -> Router<DeploymentImpl> {
    Router::new()
        .route("/projects", get(list_projects))
        .route("/project-statuses", get(list_project_statuses))
        .route("/project-tags", get(list_project_tags))
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
        .route("/issue-tags", get(list_issue_tags).post(create_issue_tag))
        .route("/issue-tags/{id}", delete(delete_issue_tag))
        .route(
            "/issue-assignees",
            get(list_issue_assignees).post(create_issue_assignee),
        )
        .route("/issue-assignees/{id}", delete(delete_issue_assignee))
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
            );
    }
}
