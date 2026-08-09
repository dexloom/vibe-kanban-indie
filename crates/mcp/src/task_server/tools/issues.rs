use std::collections::HashMap;

use api_types::{
    CreateIssueRequest, Issue, IssuePriority, IssueRelationshipType, IssueSortField,
    ListIssueRelationshipsResponse, ListIssueTagsResponse, ListIssuesResponse,
    ListPullRequestsResponse, ListTagsResponse, MutationResponse, PullRequestStatus,
    SearchIssuesRequest, SortDirection, UpdateIssueRequest, some_if_present,
};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{McpServer, ToolError};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpCreateIssueRequest {
    #[schemars(
        description = "The ID of the project to create the issue in. Optional if running inside a workspace linked to a remote project."
    )]
    project_id: Option<Uuid>,
    #[schemars(description = "The title of the issue")]
    title: String,
    #[schemars(description = "Optional description of the issue")]
    description: Option<String>,
    #[schemars(
        description = "Optional priority of the issue. Allowed values: 'urgent', 'high', 'medium', 'low'."
    )]
    priority: Option<String>,
    #[schemars(description = "Optional parent issue ID to create a subissue")]
    parent_issue_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpCreateIssueResponse {
    issue_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListIssuesRequest {
    #[schemars(
        description = "The ID of the project to list issues from. Optional if running inside a workspace linked to a remote project."
    )]
    project_id: Option<Uuid>,
    #[schemars(description = "Maximum number of issues to return (default: 50)")]
    limit: Option<i32>,
    #[schemars(description = "Number of results to skip before returning rows (default: 0)")]
    offset: Option<i32>,
    #[schemars(description = "Filter by status name (case-insensitive)")]
    status: Option<String>,
    #[schemars(
        description = "Filter by priority. Allowed values: 'urgent', 'high', 'medium', 'low'."
    )]
    priority: Option<String>,
    #[schemars(description = "Filter by parent issue ID (subissues of this issue)")]
    parent_issue_id: Option<Uuid>,
    #[schemars(description = "Case-insensitive substring match against title and description")]
    search: Option<String>,
    #[schemars(description = "Filter by issue simple ID (case-insensitive exact match)")]
    simple_id: Option<String>,
    #[schemars(description = "Filter to issues having this tag ID")]
    tag_id: Option<Uuid>,
    #[schemars(description = "Filter to issues having a tag with this name (case-insensitive)")]
    tag_name: Option<String>,
    #[schemars(
        description = "Field to sort by. Allowed values: 'sort_order', 'priority', 'created_at', 'updated_at', 'title'. Default: 'sort_order'."
    )]
    sort_field: Option<String>,
    #[schemars(description = "Sort direction. Allowed values: 'asc', 'desc'. Default: 'asc'.")]
    sort_direction: Option<String>,
}

/// Thin list row returned by `list_issues`. Deliberately NOT the issue: list rows are for
/// finding ids and reflecting board state, and the sanctioned deep path is `get_issue` — the
/// description body never appears here by construction (VIBE-23, following VIBE-1/VIBE-2).
/// Null-valued keys are omitted, not serialized as `null`.
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct IssueSummary {
    #[schemars(description = "The unique identifier of the issue")]
    id: String,
    #[schemars(description = "The title of the issue")]
    title: String,
    #[schemars(description = "The human-readable issue simple ID")]
    simple_id: String,
    #[schemars(description = "Current status of the issue")]
    status: String,
    #[schemars(description = "Current priority of the issue, omitted when unset")]
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<String>,
    #[schemars(description = "Parent issue ID if this is a subissue, omitted otherwise")]
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_issue_id: Option<String>,
    /// ⚠️ Must remain byte-identical to `get_issue`'s `updated_at` (both are
    /// `DateTime::to_rfc3339()`): the orchestrator's `cards{}` cache compares the two stamps by
    /// exact string equality, and a format drift here silently defeats that cache — every
    /// candidate card re-reads via `get_issue` every tick.
    #[schemars(description = "When the issue was last updated")]
    updated_at: String,
    #[schemars(description = "Number of pull requests linked to this issue, omitted when zero")]
    #[serde(skip_serializing_if = "is_zero")]
    pull_request_count: usize,
    #[schemars(description = "URL of the most recent pull request, omitted when none")]
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_pr_url: Option<String>,
    #[schemars(
        description = "Status of the most recent pull request ('open', 'merged', or 'closed'), omitted when none"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_pr_status: Option<PullRequestStatus>,
}

/// `skip_serializing_if` gate for `pull_request_count`: most board cards have no PRs, and the
/// delta gate's probe already normalizes an absent count to `null` (`.pull_request_count //
/// null`), so `0` carries no information that absence doesn't.
fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct PullRequestSummary {
    #[schemars(description = "PR number")]
    number: i32,
    #[schemars(description = "URL of the pull request")]
    url: String,
    #[schemars(description = "Status of the pull request: 'open', 'merged', or 'closed'")]
    status: PullRequestStatus,
    #[schemars(description = "When the PR was merged, if applicable")]
    merged_at: Option<String>,
    #[schemars(description = "Target branch for the PR")]
    target_branch_name: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpTagSummary {
    #[schemars(description = "The tag ID")]
    id: String,
    #[schemars(description = "The tag name")]
    name: String,
    #[schemars(description = "The tag color")]
    color: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpRelationshipSummary {
    #[schemars(description = "The relationship ID (use this to delete)")]
    id: String,
    #[schemars(description = "The related issue ID")]
    related_issue_id: String,
    #[schemars(description = "The related issue's simple ID (e.g. 'PROJ-42')")]
    related_simple_id: String,
    #[schemars(description = "Relationship type: blocking, related, or has_duplicate")]
    relationship_type: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpSubIssueSummary {
    #[schemars(description = "The sub-issue ID")]
    id: String,
    #[schemars(description = "Short human-readable identifier (e.g. 'PROJ-43')")]
    simple_id: String,
    #[schemars(description = "The sub-issue title")]
    title: String,
    #[schemars(description = "Current status of the sub-issue")]
    status: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct IssueDetails {
    #[schemars(description = "The unique identifier of the issue")]
    id: String,
    #[schemars(description = "The title of the issue")]
    title: String,
    #[schemars(description = "The human-readable issue simple ID")]
    simple_id: String,
    #[schemars(description = "Optional description of the issue")]
    description: Option<String>,
    #[schemars(description = "Current status of the issue")]
    status: String,
    #[schemars(description = "The status ID (UUID)")]
    status_id: String,
    #[schemars(description = "Current priority of the issue")]
    priority: Option<String>,
    #[schemars(description = "Parent issue ID if this is a subissue")]
    parent_issue_id: Option<String>,
    #[schemars(description = "Optional planned start date")]
    start_date: Option<String>,
    #[schemars(description = "Optional planned target date")]
    target_date: Option<String>,
    #[schemars(description = "Optional completion date")]
    completed_at: Option<String>,
    #[schemars(description = "When the issue was created")]
    created_at: String,
    #[schemars(description = "When the issue was last updated")]
    updated_at: String,
    #[schemars(description = "Pull requests linked to this issue")]
    pull_requests: Vec<PullRequestSummary>,
    #[schemars(description = "Tags attached to this issue")]
    tags: Vec<McpTagSummary>,
    #[schemars(description = "Relationships to other issues")]
    relationships: Vec<McpRelationshipSummary>,
    #[schemars(description = "Sub-issues under this issue")]
    sub_issues: Vec<McpSubIssueSummary>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListIssuesResponse {
    issues: Vec<IssueSummary>,
    total_count: usize,
    returned_count: usize,
    limit: usize,
    offset: usize,
    project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateIssueRequest {
    #[schemars(description = "The ID of the issue to update")]
    issue_id: Uuid,
    #[schemars(description = "New title for the issue")]
    title: Option<String>,
    #[schemars(description = "New description for the issue")]
    description: Option<String>,
    #[schemars(description = "New status name for the issue (must match a project status name)")]
    status: Option<String>,
    #[schemars(
        description = "New priority for the issue. Allowed values: 'urgent', 'high', 'medium', 'low'."
    )]
    priority: Option<String>,
    #[serde(default, deserialize_with = "some_if_present")]
    #[schemars(
        description = "Parent issue ID to set this as a subissue. Pass null to un-nest from parent."
    )]
    parent_issue_id: Option<Option<Uuid>>,
}

/// Minimal write-acknowledgement returned by `update_issue`.
///
/// Deliberately NOT the issue: `update_issue` is overwhelmingly a status flip, and echoing the
/// card body (spec + `## Pipeline` markdown) cost ~1,197 tokens/call. There is no `description`
/// field on this struct by construction — a caller that needs the persisted body calls
/// `get_issue`. See VIBE-2.
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpUpdateIssueResponse {
    #[schemars(description = "The unique identifier of the issue")]
    id: String,
    #[schemars(description = "The human-readable issue simple ID")]
    simple_id: String,
    #[schemars(description = "Current status name of the issue, as persisted")]
    status: String,
    #[schemars(description = "The status ID (UUID)")]
    status_id: String,
    #[schemars(description = "When the issue was last updated")]
    updated_at: String,
    #[schemars(
        description = "The fields this call supplied, in order: title, description, status, priority, parent_issue_id"
    )]
    changed: Vec<String>,
    #[schemars(description = "New title, echoed only when the title changed")]
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[schemars(description = "New priority, echoed only when the priority changed")]
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<String>,
    #[schemars(
        description = "New parent issue ID, present only when the parent changed; null means un-nested"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_issue_id: Option<Option<String>>,
    #[schemars(
        description = "Character count of the persisted (tag-expanded) description, present only when the description changed. The body itself is never returned - call `get_issue` for it."
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    description_chars: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpDeleteIssueRequest {
    #[schemars(description = "The ID of the issue to delete")]
    issue_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpDeleteIssueResponse {
    deleted_issue_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetIssueRequest {
    #[schemars(description = "The ID of the issue to retrieve")]
    issue_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpGetIssueResponse {
    issue: IssueDetails,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListIssuePrioritiesResponse {
    priorities: Vec<String>,
}

#[tool_router(router = issues_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "Create a new issue in a project. `project_id` is optional if running inside a workspace linked to a remote project."
    )]
    async fn create_issue(
        &self,
        Parameters(McpCreateIssueRequest {
            project_id,
            title,
            description,
            priority,
            parent_issue_id,
        }): Parameters<McpCreateIssueRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let project_id = match self.resolve_project_id(project_id) {
            Ok(id) => id,
            Err(e) => return Ok(McpServer::tool_error(e)),
        };

        let expanded_description = match description {
            Some(desc) => Some(self.expand_tags(&desc).await),
            None => None,
        };

        let status_id = match self.default_status_id(project_id).await {
            Ok(id) => id,
            Err(e) => return Ok(McpServer::tool_error(e)),
        };

        let priority = match priority {
            Some(p) => match Self::parse_issue_priority(&p) {
                Ok(priority) => Some(priority),
                Err(e) => return Ok(McpServer::tool_error(e)),
            },
            None => None,
        };

        let payload = CreateIssueRequest {
            id: None,
            project_id,
            status_id,
            title,
            description: expanded_description,
            priority,
            start_date: None,
            target_date: None,
            completed_at: None,
            sort_order: 0.0,
            parent_issue_id,
            parent_issue_sort_order: None,
            extension_metadata: serde_json::json!({}),
        };

        let url = self.url("/api/issues");
        let response: MutationResponse<Issue> =
            match self.send_json(self.client.post(&url).json(&payload)).await {
                Ok(r) => r,
                Err(e) => return Ok(McpServer::tool_error(e)),
            };

        McpServer::success(&McpCreateIssueResponse {
            issue_id: response.data.id.to_string(),
        })
    }

    #[tool(
        description = "List all the issues in a project. `project_id` is optional if running inside a workspace linked to a remote project. Returns thin summary rows - id, simple_id, title, status, updated_at, plus priority/parent_issue_id/PR fields only when set - NEVER the description. Null fields are omitted. Call `get_issue` for full detail (description, tags, relationships, sub-issues)."
    )]
    async fn list_issues(
        &self,
        Parameters(McpListIssuesRequest {
            project_id,
            limit,
            offset,
            status,
            priority,
            parent_issue_id,
            search,
            simple_id,
            tag_id,
            tag_name,
            sort_field,
            sort_direction,
        }): Parameters<McpListIssuesRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let project_id = match self.resolve_project_id(project_id) {
            Ok(id) => id,
            Err(e) => return Ok(McpServer::tool_error(e)),
        };

        let project_statuses = match self.fetch_project_statuses(project_id).await {
            Ok(statuses) => Some(statuses),
            Err(e) => {
                if status.is_some() {
                    return Ok(McpServer::tool_error(e));
                }
                None
            }
        };
        let status_names_by_id = project_statuses.as_ref().map(|statuses| {
            statuses
                .iter()
                .map(|status| (status.id, status.name.clone()))
                .collect::<HashMap<_, _>>()
        });

        let (status_id, status_ids, missing_status_name_match) = match status.as_deref() {
            Some(status) => match Uuid::parse_str(status) {
                Ok(status_id) => (Some(status_id), None, false),
                Err(_) => {
                    let matching_status_ids = project_statuses
                        .as_deref()
                        .map(|statuses| {
                            Self::matching_ids_by_name(
                                statuses
                                    .iter()
                                    .map(|status| (status.id, status.name.as_str())),
                                status,
                            )
                        })
                        .unwrap_or_default();
                    let missing_status_name_match = matching_status_ids.is_empty();
                    (
                        None,
                        (!missing_status_name_match).then_some(matching_status_ids),
                        missing_status_name_match,
                    )
                }
            },
            None => (None, None, false),
        };

        let priority = match priority {
            Some(priority) => match Self::parse_issue_priority(&priority) {
                Ok(priority) => Some(priority),
                Err(e) => return Ok(McpServer::tool_error(e)),
            },
            None => None,
        };

        let sort_field = match Self::parse_issue_sort_field(sort_field.as_deref()) {
            Ok(value) => Some(value),
            Err(e) => return Ok(McpServer::tool_error(e)),
        };
        let sort_direction = match Self::parse_sort_direction(sort_direction.as_deref()) {
            Ok(value) => Some(value),
            Err(e) => return Ok(McpServer::tool_error(e)),
        };

        let matching_tag_ids = match tag_name.as_deref() {
            Some(tag_name) => match self.find_tag_ids_by_name(project_id, tag_name).await {
                Ok(tag_ids) => Some(tag_ids),
                Err(e) => return Ok(McpServer::tool_error(e)),
            },
            None => None,
        };
        let (tag_id, tag_ids, missing_tag_name_match) =
            Self::resolve_tag_filters(tag_id, matching_tag_ids);

        let response = if missing_status_name_match || missing_tag_name_match {
            ListIssuesResponse {
                issues: Vec::new(),
                total_count: 0,
                limit: limit.unwrap_or(50).max(0) as usize,
                offset: offset.unwrap_or(0).max(0) as usize,
            }
        } else {
            let query = SearchIssuesRequest {
                project_id,
                status_id,
                status_ids,
                priority,
                parent_issue_id,
                search,
                simple_id,
                tag_id,
                tag_ids,
                sort_field,
                sort_direction,
                limit: Some(limit.unwrap_or(50).max(0)),
                offset: Some(offset.unwrap_or(0).max(0)),
            };
            let url = self.url("/api/issues/search");
            match self.send_json(self.client.post(&url).json(&query)).await {
                Ok(r) => r,
                Err(e) => return Ok(McpServer::tool_error(e)),
            }
        };

        let mut summaries = Vec::with_capacity(response.issues.len());
        for issue in &response.issues {
            let pull_requests = self.fetch_pull_requests(issue.id).await;
            summaries.push(Self::issue_to_summary(
                issue,
                status_names_by_id.as_ref(),
                &pull_requests,
            ));
        }

        // Compact on purpose: a 100-row list pretty-printed is ~35% whitespace (VIBE-23).
        McpServer::success_compact(&McpListIssuesResponse {
            total_count: response.total_count,
            returned_count: summaries.len(),
            limit: response.limit,
            offset: response.offset,
            issues: summaries,
            project_id: project_id.to_string(),
        })
    }

    #[tool(
        description = "Get detailed information about a specific issue. You can use `list_issues` to find issue IDs. `issue_id` is required."
    )]
    async fn get_issue(
        &self,
        Parameters(McpGetIssueRequest { issue_id }): Parameters<McpGetIssueRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!("/api/issues/{}", issue_id));
        let issue: Issue = match self.send_json(self.client.get(&url)).await {
            Ok(i) => i,
            Err(e) => return Ok(McpServer::tool_error(e)),
        };

        let pull_requests = self.fetch_pull_requests(issue_id).await;
        let details = self.issue_to_details(&issue, pull_requests).await;
        McpServer::success(&McpGetIssueResponse { issue: details })
    }

    #[tool(
        description = "Update an existing issue's title, description, status, priority, or parent. `issue_id` is required; every other field is optional. Returns a minimal acknowledgement - `id`, `simple_id`, `status`, `status_id`, `updated_at`, a `changed` list of the fields you supplied, and echoes of just those fields - NOT the issue. The description body is never returned (only `description_chars`); call `get_issue` if you need the card's body."
    )]
    async fn update_issue(
        &self,
        Parameters(McpUpdateIssueRequest {
            issue_id,
            title,
            description,
            status,
            priority,
            parent_issue_id,
        }): Parameters<McpUpdateIssueRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        // Capture which fields the caller supplied BEFORE `title` / `description` / `priority` /
        // `parent_issue_id` are moved into `UpdateIssueRequest` below (and before `description`
        // / `priority` are rebound to `Option<Option<_>>`).
        let changed = ChangedFields {
            title: title.is_some(),
            description: description.is_some(),
            status: status.is_some(),
            priority: priority.is_some(),
            parent_issue_id: parent_issue_id.is_some(),
        };

        // First get the issue to know its project_id for status resolution
        let get_url = self.url(&format!("/api/issues/{}", issue_id));
        let existing_issue: Issue = match self.send_json(self.client.get(&get_url)).await {
            Ok(i) => i,
            Err(e) => return Ok(McpServer::tool_error(e)),
        };

        // Fetch the project's statuses ONCE and use the list twice: name -> id before the PATCH,
        // and id -> canonical name after it. Resolving each side through its own round-trip
        // helper would hit `GET /api/project-statuses` twice per flip.
        //
        // A fetch failure is only fatal when the caller supplied a status (that is the request
        // we cannot honour). Otherwise carry on with an empty list: nothing needs resolving to
        // an id, and the ack's status name degrades to the UUID string — exactly the fallback
        // this crate has always had. Same shape as `list_issues` (:345-353).
        let project_statuses = match self.fetch_project_statuses(existing_issue.project_id).await {
            Ok(statuses) => statuses,
            Err(e) => {
                if status.is_some() {
                    return Ok(McpServer::tool_error(e));
                }
                Vec::new()
            }
        };

        // Resolve status name to status_id if provided
        let status_id = match status.as_deref() {
            Some(status_name) => {
                match McpServer::status_id_from_name(&project_statuses, status_name) {
                    Ok(id) => Some(id),
                    Err(e) => return Ok(McpServer::tool_error(e)),
                }
            }
            None => None,
        };

        // Expand @tagname references in description
        let expanded_description = match description {
            Some(desc) => Some(Some(self.expand_tags(&desc).await)),
            None => None,
        };

        let priority = if let Some(priority) = priority {
            match Self::parse_issue_priority(&priority) {
                Ok(parsed) => Some(Some(parsed)),
                Err(e) => return Ok(McpServer::tool_error(e)),
            }
        } else {
            None
        };

        let payload = UpdateIssueRequest {
            status_id,
            title,
            description: expanded_description,
            priority,
            start_date: None,
            target_date: None,
            completed_at: None,
            sort_order: None,
            // tri-state, passed through verbatim: do NOT lift to `Some(Some(..))` like
            // `description`/`priority` above; that would silently re-break un-nest (VIBE-16).
            parent_issue_id,
            parent_issue_sort_order: None,
            extension_metadata: None,
        };

        let url = self.url(&format!("/api/issues/{}", issue_id));
        let response: MutationResponse<Issue> =
            match self.send_json(self.client.patch(&url).json(&payload)).await {
                Ok(r) => r,
                Err(e) => return Ok(McpServer::tool_error(e)),
            };

        // Slim: return a minimal ack, never the card body. This also drops the post-PATCH
        // detail fan-out (pull requests, tags, relationships, sub-issues), so a status-only
        // flip is now 3 HTTP requests — GET issue, GET project-statuses, PATCH — instead of
        // ~8. (A description carrying an `@tag` still adds one `GET /api/tags` via
        // `expand_tags` above; that is write-path behaviour and stays.)
        let issue = response.data;
        let status = McpServer::status_name_from_id(&project_statuses, issue.status_id);
        McpServer::success(&build_update_ack(&issue, status, changed))
    }

    #[tool(description = "List allowed issue priority values.")]
    async fn list_issue_priorities(&self) -> Result<CallToolResult, ErrorData> {
        McpServer::success(&McpListIssuePrioritiesResponse {
            priorities: ["urgent", "high", "medium", "low"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        })
    }

    #[tool(description = "Delete an issue. `issue_id` is required.")]
    async fn delete_issue(
        &self,
        Parameters(McpDeleteIssueRequest { issue_id }): Parameters<McpDeleteIssueRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!("/api/issues/{}", issue_id));
        if let Err(e) = self.send_empty_json(self.client.delete(&url)).await {
            return Ok(McpServer::tool_error(e));
        }

        McpServer::success(&McpDeleteIssueResponse {
            deleted_issue_id: Some(issue_id.to_string()),
        })
    }
}

impl McpServer {
    fn parse_issue_sort_field(sort_field: Option<&str>) -> Result<IssueSortField, ToolError> {
        match sort_field
            .unwrap_or("sort_order")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "sort_order" => Ok(IssueSortField::SortOrder),
            "priority" => Ok(IssueSortField::Priority),
            "created_at" => Ok(IssueSortField::CreatedAt),
            "updated_at" => Ok(IssueSortField::UpdatedAt),
            "title" => Ok(IssueSortField::Title),
            other => Err(ToolError::message(format!(
                "Unknown sort_field '{}'. Allowed values: ['sort_order', 'priority', 'created_at', 'updated_at', 'title']",
                other
            ))),
        }
    }

    fn parse_sort_direction(sort_direction: Option<&str>) -> Result<SortDirection, ToolError> {
        match sort_direction
            .unwrap_or("asc")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "asc" => Ok(SortDirection::Asc),
            "desc" => Ok(SortDirection::Desc),
            other => Err(ToolError::message(format!(
                "Unknown sort_direction '{}'. Allowed values: ['asc', 'desc']",
                other
            ))),
        }
    }

    fn issue_to_summary(
        issue: &Issue,
        status_names_by_id: Option<&HashMap<Uuid, String>>,
        pull_requests: &ListPullRequestsResponse,
    ) -> IssueSummary {
        let status = status_names_by_id
            .and_then(|status_map| status_map.get(&issue.status_id).cloned())
            .unwrap_or_else(|| issue.status_id.to_string());
        let latest_pr = pull_requests.pull_requests.first();
        IssueSummary {
            id: issue.id.to_string(),
            title: issue.title.clone(),
            simple_id: issue.simple_id.clone(),
            status,
            priority: issue
                .priority
                .map(Self::issue_priority_label)
                .map(str::to_string),
            parent_issue_id: issue.parent_issue_id.map(|id| id.to_string()),
            updated_at: issue.updated_at.to_rfc3339(),
            pull_request_count: pull_requests.pull_requests.len(),
            latest_pr_url: latest_pr.map(|pr| pr.url.clone()),
            latest_pr_status: latest_pr.map(|pr| pr.status),
        }
    }

    async fn issue_to_details(
        &self,
        issue: &Issue,
        pull_requests: ListPullRequestsResponse,
    ) -> IssueDetails {
        let status = self
            .resolve_status_name(issue.project_id, issue.status_id)
            .await;

        let tags = self
            .fetch_issue_tags_resolved(issue.project_id, issue.id)
            .await;

        let relationships = self
            .fetch_issue_relationships_resolved(issue.project_id, issue.id)
            .await;

        let sub_issues = self.fetch_sub_issues(issue.project_id, issue.id).await;

        IssueDetails {
            id: issue.id.to_string(),
            title: issue.title.clone(),
            simple_id: issue.simple_id.clone(),
            description: issue.description.clone(),
            status,
            status_id: issue.status_id.to_string(),
            priority: issue
                .priority
                .map(Self::issue_priority_label)
                .map(str::to_string),
            parent_issue_id: issue.parent_issue_id.map(|id| id.to_string()),
            start_date: issue.start_date.map(|date| date.to_rfc3339()),
            target_date: issue.target_date.map(|date| date.to_rfc3339()),
            completed_at: issue.completed_at.map(|date| date.to_rfc3339()),
            created_at: issue.created_at.to_rfc3339(),
            updated_at: issue.updated_at.to_rfc3339(),
            pull_requests: pull_requests
                .pull_requests
                .into_iter()
                .map(|pr| PullRequestSummary {
                    number: pr.number,
                    url: pr.url,
                    status: pr.status,
                    merged_at: pr.merged_at.map(|dt| dt.to_rfc3339()),
                    target_branch_name: pr.target_branch_name,
                })
                .collect(),
            tags,
            relationships,
            sub_issues,
        }
    }

    async fn fetch_pull_requests(&self, issue_id: Uuid) -> ListPullRequestsResponse {
        let url = self.url(&format!("/api/issues/{}/pull-requests", issue_id));
        match self
            .send_json::<ListPullRequestsResponse>(self.client.get(&url))
            .await
        {
            Ok(response) => response,
            Err(_) => ListPullRequestsResponse {
                pull_requests: vec![],
            },
        }
    }

    /// Fetches tags for an issue, resolving tag_ids to names via project tags.
    async fn fetch_issue_tags_resolved(
        &self,
        project_id: Uuid,
        issue_id: Uuid,
    ) -> Vec<McpTagSummary> {
        let tags_url = self.url(&format!("/api/project-tags?project_id={}", project_id));
        let project_tags: ListTagsResponse = match self.send_json(self.client.get(&tags_url)).await
        {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let tag_map: HashMap<Uuid, &api_types::Tag> =
            project_tags.tags.iter().map(|t| (t.id, t)).collect();

        let url = self.url(&format!("/api/issue-tags?issue_id={}", issue_id));
        let response: ListIssueTagsResponse = match self.send_json(self.client.get(&url)).await {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        response
            .issue_tags
            .iter()
            .filter_map(|it| {
                tag_map.get(&it.tag_id).map(|tag| McpTagSummary {
                    id: tag.id.to_string(),
                    name: tag.name.clone(),
                    color: tag.color.clone(),
                })
            })
            .collect()
    }

    /// Fetches relationships for an issue, resolving related issue simple_ids.
    async fn fetch_issue_relationships_resolved(
        &self,
        project_id: Uuid,
        issue_id: Uuid,
    ) -> Vec<McpRelationshipSummary> {
        let rel_url = self.url(&format!("/api/issue-relationships?issue_id={}", issue_id));
        let response: ListIssueRelationshipsResponse =
            match self.send_json(self.client.get(&rel_url)).await {
                Ok(r) => r,
                Err(_) => return Vec::new(),
            };

        if response.issue_relationships.is_empty() {
            return Vec::new();
        }

        let issues_url = self.url(&format!("/api/issues?project_id={}", project_id));
        let issues_response: api_types::ListIssuesResponse = self
            .send_json(self.client.get(&issues_url))
            .await
            .unwrap_or(api_types::ListIssuesResponse {
                issues: Vec::new(),
                total_count: 0,
                limit: 0,
                offset: 0,
            });
        let simple_id_map: HashMap<Uuid, &str> = issues_response
            .issues
            .iter()
            .map(|i| (i.id, i.simple_id.as_str()))
            .collect();

        response
            .issue_relationships
            .into_iter()
            .map(|r| {
                let related_simple_id = simple_id_map
                    .get(&r.related_issue_id)
                    .unwrap_or(&"")
                    .to_string();
                McpRelationshipSummary {
                    id: r.id.to_string(),
                    related_issue_id: r.related_issue_id.to_string(),
                    related_simple_id,
                    relationship_type: match r.relationship_type {
                        IssueRelationshipType::Blocking => "blocking".to_string(),
                        IssueRelationshipType::Related => "related".to_string(),
                        IssueRelationshipType::HasDuplicate => "has_duplicate".to_string(),
                    },
                }
            })
            .collect()
    }

    /// Fetches sub-issues for a given parent issue.
    async fn fetch_sub_issues(
        &self,
        project_id: Uuid,
        parent_issue_id: Uuid,
    ) -> Vec<McpSubIssueSummary> {
        let url = self.url(&format!("/api/issues?project_id={}", project_id));
        let response: api_types::ListIssuesResponse =
            match self.send_json(self.client.get(&url)).await {
                Ok(r) => r,
                Err(_) => return Vec::new(),
            };

        let status_names = self
            .fetch_project_statuses(project_id)
            .await
            .ok()
            .map(|statuses| {
                statuses
                    .into_iter()
                    .map(|s| (s.id, s.name))
                    .collect::<HashMap<_, _>>()
            });

        response
            .issues
            .iter()
            .filter(|i| i.parent_issue_id == Some(parent_issue_id))
            .map(|i| {
                let status = status_names
                    .as_ref()
                    .and_then(|m| m.get(&i.status_id).cloned())
                    .unwrap_or_else(|| i.status_id.to_string());
                McpSubIssueSummary {
                    id: i.id.to_string(),
                    simple_id: i.simple_id.clone(),
                    title: i.title.clone(),
                    status,
                }
            })
            .collect()
    }

    fn parse_issue_priority(priority: &str) -> Result<IssuePriority, ToolError> {
        match priority.trim().to_ascii_lowercase().as_str() {
            "urgent" => Ok(IssuePriority::Urgent),
            "high" => Ok(IssuePriority::High),
            "medium" => Ok(IssuePriority::Medium),
            "low" => Ok(IssuePriority::Low),
            _ => Err(ToolError::message(format!(
                "Unknown priority '{}'. Allowed values: ['urgent', 'high', 'medium', 'low']",
                priority
            ))),
        }
    }

    fn issue_priority_label(priority: IssuePriority) -> &'static str {
        match priority {
            IssuePriority::Urgent => "urgent",
            IssuePriority::High => "high",
            IssuePriority::Medium => "medium",
            IssuePriority::Low => "low",
        }
    }

    async fn find_tag_ids_by_name(
        &self,
        project_id: Uuid,
        tag_name: &str,
    ) -> Result<Vec<Uuid>, ToolError> {
        let url = self.url(&format!("/api/project-tags?project_id={}", project_id));
        let tags: ListTagsResponse = self.send_json(self.client.get(&url)).await?;
        Ok(Self::matching_ids_by_name(
            tags.tags.iter().map(|tag| (tag.id, tag.name.as_str())),
            tag_name,
        ))
    }

    fn matching_ids_by_name<'a>(
        items: impl IntoIterator<Item = (Uuid, &'a str)>,
        name: &str,
    ) -> Vec<Uuid> {
        items
            .into_iter()
            .filter(|(_, item_name)| item_name.eq_ignore_ascii_case(name))
            .map(|(id, _)| id)
            .collect()
    }

    fn resolve_tag_filters(
        tag_id: Option<Uuid>,
        matching_tag_ids: Option<Vec<Uuid>>,
    ) -> (Option<Uuid>, Option<Vec<Uuid>>, bool) {
        match (tag_id, matching_tag_ids) {
            (Some(tag_id), Some(matching_tag_ids)) => {
                if matching_tag_ids.contains(&tag_id) {
                    (Some(tag_id), None, false)
                } else {
                    (None, None, true)
                }
            }
            (None, Some(matching_tag_ids)) => {
                let missing_tag_name_match = matching_tag_ids.is_empty();
                (
                    None,
                    (!missing_tag_name_match).then_some(matching_tag_ids),
                    missing_tag_name_match,
                )
            }
            (Some(tag_id), None) => (Some(tag_id), None, false),
            (None, None) => (None, None, false),
        }
    }
}

/// Which request fields the caller actually supplied on an `update_issue` call.
///
/// Captured from the ORIGINAL `McpUpdateIssueRequest` bindings, BEFORE they are moved into
/// `UpdateIssueRequest` and before `description` / `priority` are rebound to
/// `Option<Option<_>>`. These flags mean "the caller asked for this field", not "this field's
/// value actually moved" — an ack confirms a write, it is not a diff.
///
/// NOTE on `parent_issue_id`: a supplied `parent_issue_id` — including `Some(None)` from a JSON
/// `null` — sets this flag, and is reported in `changed[]` (VIBE-16).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ChangedFields {
    title: bool,
    description: bool,
    status: bool,
    priority: bool,
    parent_issue_id: bool,
}

impl ChangedFields {
    /// The supplied field names, in the fixed order of the spec, for determinism.
    fn names(&self) -> Vec<String> {
        let mut names = Vec::new();
        if self.title {
            names.push("title".to_string());
        }
        if self.description {
            names.push("description".to_string());
        }
        if self.status {
            names.push("status".to_string());
        }
        if self.priority {
            names.push("priority".to_string());
        }
        if self.parent_issue_id {
            names.push("parent_issue_id".to_string());
        }
        names
    }
}

/// Pure: project the PERSISTED issue (the PATCH's `response.data`) down to the ack.
///
/// No I/O, no DB — `status` is resolved by the caller and passed in. Echo values are read back
/// from `issue` (the server's truth after the write), never from the request. A changed
/// description yields only its CHARACTER COUNT: `chars()`, not `len()`, so a multi-byte
/// (CJK/emoji) body reports characters rather than bytes.
fn build_update_ack(
    issue: &Issue,
    status: String,
    changed: ChangedFields,
) -> McpUpdateIssueResponse {
    McpUpdateIssueResponse {
        id: issue.id.to_string(),
        simple_id: issue.simple_id.clone(),
        status,
        status_id: issue.status_id.to_string(),
        updated_at: issue.updated_at.to_rfc3339(),
        changed: changed.names(),
        title: changed.title.then(|| issue.title.clone()),
        priority: changed
            .priority
            .then(|| {
                issue
                    .priority
                    .map(McpServer::issue_priority_label)
                    .map(str::to_string)
            })
            .flatten(),
        // `Some(None)` => serialized as `null` => "un-nested". `None` => key omitted.
        parent_issue_id: changed
            .parent_issue_id
            .then(|| issue.parent_issue_id.map(|id| id.to_string())),
        description_chars: changed
            .description
            .then(|| issue.description.as_deref().unwrap_or("").chars().count()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body big enough to matter (~4 KB) carrying a unique needle, so a test can assert the
    /// body survives NOWHERE in the serialized ack.
    const BODY_NEEDLE: &str = "NEEDLE-SPEC-BODY-MUST-NOT-BE-ECHOED";

    fn big_description() -> String {
        format!("{}{BODY_NEEDLE}{}", "x".repeat(2_000), "y".repeat(2_000))
    }

    /// Builds a real `Issue` from a JSON fixture — `Issue` derives `Deserialize`
    /// (`api-types/src/issue.rs:20`), so this avoids hand-constructing chrono values. Same trick
    /// VIBE-1 used (`sessions.rs:617`).
    fn issue_fixture(description: Option<&str>, parent_issue_id: Option<Uuid>) -> Issue {
        serde_json::from_value(serde_json::json!({
            "id": "0f7a3c2e-5b31-4d0a-9c11-8ab4f2d61e77",
            "project_id": "11111111-1111-1111-1111-111111111111",
            "issue_number": 2,
            "simple_id": "VIBE-2",
            "status_id": "3a2b19cd-77e4-4f0b-8a55-1c9e0d4b6f21",
            "title": "Minimal update_issue MCP response",
            "description": description,
            "priority": "high",
            "start_date": null,
            "target_date": null,
            "completed_at": null,
            "sort_order": 1.0,
            "parent_issue_id": parent_issue_id,
            "parent_issue_sort_order": null,
            "extension_metadata": {},
            "creator_user_id": null,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-07-14T09:12:44.183Z"
        }))
        .expect("fixture JSON should deserialize into Issue")
    }

    /// Serialize an ack and parse it back as a JSON object, so tests can assert on OBJECT KEYS
    /// (see `assert_no_description_body`) rather than substrings.
    fn ack_json(
        ack: &McpUpdateIssueResponse,
    ) -> (String, serde_json::Map<String, serde_json::Value>) {
        let text = serde_json::to_string(ack).expect("ack serializes");
        let value: serde_json::Value = serde_json::from_str(&text).expect("ack round-trips");
        let obj = value.as_object().expect("ack is a JSON object").clone();
        (text, obj)
    }

    /// The two assertions that define this card: the ack has NO `description` key, and the body
    /// survives nowhere in the serialized output.
    ///
    /// ⚠️ READ THIS BEFORE WRITING THE ASSERTION YOURSELF (SPEC §7.1):
    /// `description_chars` CONTAINS the substring `description`. The obvious check
    /// `assert!(!text.contains("description"))` therefore FAILS SPURIOUSLY on any
    /// description-changed fixture. Assert on the PARSED OBJECT KEY for key-absence, and on a
    /// UNIQUE NEEDLE embedded in the body for body-absence. Never substring-match the word
    /// "description".
    fn assert_no_description_body(text: &str, obj: &serde_json::Map<String, serde_json::Value>) {
        assert!(
            obj.get("description").is_none(),
            "ack must have no `description` key; got keys: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            text.matches(BODY_NEEDLE).count(),
            0,
            "the description body must not survive anywhere in the ack"
        );
    }

    // --- AC1: a status-only flip returns no description body ---
    #[test]
    fn status_only_ack_omits_the_description_body() {
        let body = big_description();
        let issue = issue_fixture(Some(&body), None);

        let ack = build_update_ack(
            &issue,
            "In Review".to_string(),
            ChangedFields {
                status: true,
                ..ChangedFields::default()
            },
        );

        let (text, obj) = ack_json(&ack);
        assert_no_description_body(&text, &obj);
        // A status-only flip did not change the description, so not even the count appears.
        assert!(obj.get("description_chars").is_none());
        assert_eq!(obj["changed"], serde_json::json!(["status"]));
        assert_eq!(obj["status"], serde_json::json!("In Review"));
    }

    // --- AC2: the six always-present fields, even when nothing was supplied ---
    #[test]
    fn ack_always_carries_the_core_fields() {
        let issue = issue_fixture(Some(&big_description()), None);

        for changed in [
            ChangedFields::default(),
            ChangedFields {
                status: true,
                ..ChangedFields::default()
            },
            ChangedFields {
                title: true,
                description: true,
                status: true,
                priority: true,
                parent_issue_id: true,
            },
        ] {
            let ack = build_update_ack(&issue, "Todo".to_string(), changed);
            let (_, obj) = ack_json(&ack);
            for key in [
                "id",
                "simple_id",
                "status",
                "status_id",
                "updated_at",
                "changed",
            ] {
                assert!(obj.get(key).is_some(), "missing `{key}` for {changed:?}");
            }
        }

        // The no-op call still acks, with an empty `changed`.
        let ack = build_update_ack(&issue, "Todo".to_string(), ChangedFields::default());
        let (_, obj) = ack_json(&ack);
        assert_eq!(obj["changed"], serde_json::json!([]));
        assert_eq!(obj["simple_id"], serde_json::json!("VIBE-2"));
    }

    // --- AC3: `changed` lists exactly the supplied fields, in the fixed order, and the echoes
    //          appear iff their name is in `changed` ---
    #[test]
    fn changed_lists_supplied_fields_in_fixed_order_and_gates_the_echoes() {
        let issue = issue_fixture(Some(&big_description()), Some(Uuid::new_v4()));

        // Fixed order: title, description, status, priority, parent_issue_id.
        let all = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                title: true,
                description: true,
                status: true,
                priority: true,
                parent_issue_id: true,
            },
        );
        let (_, obj) = ack_json(&all);
        assert_eq!(
            obj["changed"],
            serde_json::json!([
                "title",
                "description",
                "status",
                "priority",
                "parent_issue_id"
            ])
        );

        // A title-only change emits `title` and NOTHING else.
        let title_only = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                title: true,
                ..ChangedFields::default()
            },
        );
        let (text, obj) = ack_json(&title_only);
        assert_eq!(obj["changed"], serde_json::json!(["title"]));
        assert_eq!(
            obj["title"],
            serde_json::json!("Minimal update_issue MCP response")
        );
        assert!(obj.get("priority").is_none());
        assert!(obj.get("parent_issue_id").is_none());
        assert!(obj.get("description_chars").is_none());
        assert_no_description_body(&text, &obj);
        // Status is present on EVERY ack, even one that did not change it (SPEC §3.3).
        assert_eq!(obj["status"], serde_json::json!("Todo"));

        // A priority-only change echoes the PERSISTED label.
        let priority_only = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                priority: true,
                ..ChangedFields::default()
            },
        );
        let (_, obj) = ack_json(&priority_only);
        assert_eq!(obj["changed"], serde_json::json!(["priority"]));
        assert_eq!(obj["priority"], serde_json::json!("high"));
        assert!(obj.get("title").is_none());
    }

    // --- AC4: description_chars, never the body; chars() not len() ---
    #[test]
    fn description_change_emits_a_char_count_never_the_body() {
        let body = big_description();
        let issue = issue_fixture(Some(&body), None);

        let ack = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                description: true,
                ..ChangedFields::default()
            },
        );
        let (text, obj) = ack_json(&ack);

        // AC1's two assertions must still hold on the description-changed path — this is the
        // case where a naive `!text.contains("description")` would misfire.
        assert_no_description_body(&text, &obj);
        assert_eq!(
            obj["description_chars"],
            serde_json::json!(body.chars().count())
        );
        assert_eq!(obj["changed"], serde_json::json!(["description"]));

        // Multi-byte: the count is characters, not bytes. CJK is 3 bytes/char and emoji 4
        // bytes/char, so `len()` would report 3x / 4x the truth.
        let multibyte = format!("{}{}", "日".repeat(1_000), "🚀".repeat(500));
        assert_eq!(multibyte.chars().count(), 1_500);
        assert!(multibyte.len() > 1_500);
        let issue = issue_fixture(Some(&multibyte), None);
        let ack = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                description: true,
                ..ChangedFields::default()
            },
        );
        let (_, obj) = ack_json(&ack);
        assert_eq!(obj["description_chars"], serde_json::json!(1_500));

        // A description cleared to empty still reports a count, not a missing key.
        let issue = issue_fixture(None, None);
        let ack = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                description: true,
                ..ChangedFields::default()
            },
        );
        let (_, obj) = ack_json(&ack);
        assert_eq!(obj["description_chars"], serde_json::json!(0));
    }

    // --- AC5: the un-nest case is unambiguous AT THE ACK LAYER ---
    //
    // This is a test of the PURE FUNCTION `build_update_ack`, and the un-nest path it pins is now
    // reachable end-to-end (VIBE-16): the request field deserialises `null` -> `Some(None)`,
    // `changed` picks it up (`:540`), the PATCH body carries `null` (pinned by
    // `update_issue_wire_test`), the server persists NULL
    // (`crates/server/src/routes/local_kanban.rs:534-537`), and this test pins the ack layer of
    // that chain.
    #[test]
    fn un_nest_serializes_null_parent_while_an_untouched_parent_is_omitted() {
        // Un-nested: persisted parent is None AND the caller supplied the field.
        let issue = issue_fixture(None, None);
        let ack = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                parent_issue_id: true,
                ..ChangedFields::default()
            },
        );
        let (text, obj) = ack_json(&ack);
        assert_eq!(obj["changed"], serde_json::json!(["parent_issue_id"]));
        // `Some(None)` must serialize as JSON `null` — NOT `{}`, and NOT omitted.
        assert!(obj.contains_key("parent_issue_id"));
        assert_eq!(obj["parent_issue_id"], serde_json::Value::Null);
        assert!(text.contains("\"parent_issue_id\":null"));

        // Re-parented: the UUID string comes back.
        let parent = Uuid::new_v4();
        let issue = issue_fixture(None, Some(parent));
        let ack = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                parent_issue_id: true,
                ..ChangedFields::default()
            },
        );
        let (_, obj) = ack_json(&ack);
        assert_eq!(
            obj["parent_issue_id"],
            serde_json::json!(parent.to_string())
        );

        // Untouched parent: the key is ABSENT even though the issue HAS a parent. This is what
        // makes the `null` above mean "un-nested" rather than "not touched".
        let ack = build_update_ack(
            &issue,
            "Todo".to_string(),
            ChangedFields {
                status: true,
                ..ChangedFields::default()
            },
        );
        let (_, obj) = ack_json(&ack);
        assert!(obj.get("parent_issue_id").is_none());
    }

    // --- AC6: the ack is substantially smaller than the old shape ---
    #[test]
    fn update_ack_is_substantially_smaller_than_the_old_issue_echo() {
        let body = big_description();
        let issue = issue_fixture(Some(&body), None);

        // The OLD shape: `IssueDetails` (what `update_issue` used to return), built by hand —
        // the real `issue_to_details` is async + HTTP. Fan-out vecs are empty, the most GENEROUS
        // possible baseline for the old shape; the real one was bigger still.
        let old = IssueDetails {
            id: issue.id.to_string(),
            title: issue.title.clone(),
            simple_id: issue.simple_id.clone(),
            description: issue.description.clone(),
            status: "In Review".to_string(),
            status_id: issue.status_id.to_string(),
            priority: issue
                .priority
                .map(McpServer::issue_priority_label)
                .map(str::to_string),
            parent_issue_id: issue.parent_issue_id.map(|id| id.to_string()),
            start_date: None,
            target_date: None,
            completed_at: None,
            created_at: issue.created_at.to_rfc3339(),
            updated_at: issue.updated_at.to_rfc3339(),
            pull_requests: Vec::new(),
            tags: Vec::new(),
            relationships: Vec::new(),
            sub_issues: Vec::new(),
        };

        let new = build_update_ack(
            &issue,
            "In Review".to_string(),
            ChangedFields {
                status: true,
                ..ChangedFields::default()
            },
        );

        let old_len = serde_json::to_string(&old).unwrap().len();
        let new_len = serde_json::to_string(&new).unwrap().len();

        assert!(
            new_len * 10 < old_len,
            "expected the ack to be under 10% of the old echo: old={old_len} new={new_len}"
        );
    }

    // --- VIBE-23: thin `list_issues` rows ---

    /// Serialize an `IssueSummary` and hand back its JSON object, so tests assert on keys.
    fn summary_json(summary: &IssueSummary) -> serde_json::Map<String, serde_json::Value> {
        let value = serde_json::to_value(summary).expect("summary serializes");
        value.as_object().expect("summary is a JSON object").clone()
    }

    fn no_pull_requests() -> ListPullRequestsResponse {
        ListPullRequestsResponse {
            pull_requests: vec![],
        }
    }

    // AC: no null-valued keys, no dropped fields resurfacing, and NEVER the description.
    #[test]
    fn list_row_omits_null_keys_and_never_the_description() {
        let body = big_description();
        let issue = issue_fixture(Some(&body), None);
        let summary = McpServer::issue_to_summary(&issue, None, &no_pull_requests());

        let text = serde_json::to_string(&summary).expect("summary serializes");
        let obj = summary_json(&summary);

        assert_no_description_body(&text, &obj);
        assert!(
            obj.values().all(|v| !v.is_null()),
            "no null-valued keys allowed in list rows: {obj:?}"
        );
        // Dropped/conditional fields stay off a row that has nothing to say.
        for key in [
            "created_at",
            "parent_issue_id",
            "pull_request_count",
            "latest_pr_url",
            "latest_pr_status",
        ] {
            assert!(obj.get(key).is_none(), "`{key}` must be omitted");
        }
        // The always-present core survives (priority is set on the fixture).
        for key in [
            "id",
            "simple_id",
            "title",
            "status",
            "priority",
            "updated_at",
        ] {
            assert!(obj.get(key).is_some(), "missing `{key}`");
        }
    }

    // The PR fields appear exactly when a PR exists — the orchestrator's status-reflection signal.
    #[test]
    fn list_row_carries_pr_fields_only_when_a_pr_exists() {
        let issue = issue_fixture(None, None);
        let pull_requests: ListPullRequestsResponse = serde_json::from_value(serde_json::json!({
            "pull_requests": [{
                "id": "22222222-2222-2222-2222-222222222222",
                "project_id": "11111111-1111-1111-1111-111111111111",
                "issue_id": issue.id.to_string(),
                "workspace_id": null,
                "number": 7,
                "url": "https://github.com/sombrax/vibe-kanban-indie/pull/7",
                "status": "open",
                "merged_at": null,
                "target_branch_name": "main",
                "created_at": "2026-07-14T09:12:44Z",
                "updated_at": "2026-07-14T09:12:44Z"
            }]
        }))
        .expect("pull request fixture deserializes");

        let with_pr = McpServer::issue_to_summary(&issue, None, &pull_requests);
        let obj = summary_json(&with_pr);
        assert_eq!(obj["pull_request_count"], serde_json::json!(1));
        assert_eq!(
            obj["latest_pr_url"],
            serde_json::json!("https://github.com/sombrax/vibe-kanban-indie/pull/7")
        );
        assert_eq!(obj["latest_pr_status"], serde_json::json!("open"));
    }

    // ⚠️ The cache contract: `list_issues.updated_at` must be byte-identical to `get_issue`'s
    // stamp (both `DateTime::to_rfc3339()`) — the orchestrator's `cards{}` cache compares the two by
    // exact STRING equality, and a one-sided format change silently defeats it (a permanent
    // cache miss = one `get_issue` per candidate per tick).
    #[test]
    fn list_row_updated_at_matches_get_issue_rendering_byte_for_byte() {
        let issue = issue_fixture(None, None);
        let summary = McpServer::issue_to_summary(&issue, None, &no_pull_requests());

        // `issue_to_details` (the `get_issue` path) renders `issue.updated_at.to_rfc3339()`.
        assert_eq!(summary.updated_at, issue.updated_at.to_rfc3339());
        // The fixture's stamp carries sub-second precision — pin that it survives, so a
        // "shorten the timestamp" edit on either side trips this test instead of the cache.
        assert_eq!(summary.updated_at, "2026-07-14T09:12:44.183+00:00");
    }

    // --- AC: a 20-issue project's list response fits the size budget ---
    //
    // The floor is contractual: a 36-char UUID (the `get_issue` key), a full-precision
    // `updated_at` (the cache contract above), `simple_id`, `status`, and the title. With
    // realistic 40-char titles that is ~190 chars/row compact, so 20 rows land ~3.9k — inside
    // the AC's "~3k" for short-titled boards and title-dominated beyond. The old shape
    // (pretty-printed, null keys, created_at) measured ~450 chars/row; pin the reduction too.
    #[test]
    fn twenty_issue_rows_fit_the_size_budget() {
        let mut issues = Vec::new();
        for i in 0..20 {
            let mut issue = issue_fixture(Some(&big_description()), None);
            issue.title = format!("Card {i:02}: a realistic forty-char issue title");
            // A resolvable status map, so rows carry a real name ("In Progress"), not
            // the 36-char status-UUID fallback.
            let status_names = HashMap::from([(issue.status_id, "In Progress".to_string())]);
            issues.push(McpServer::issue_to_summary(
                &issue,
                Some(&status_names),
                &no_pull_requests(),
            ));
        }
        let response = McpListIssuesResponse {
            total_count: issues.len(),
            returned_count: issues.len(),
            limit: 50,
            offset: 0,
            issues,
            project_id: "07fc0c5e-28a3-4f24-9d0f-52c86bc3a3e8".to_string(),
        };

        let compact = serde_json::to_string(&response).expect("response serializes");
        assert!(
            compact.len() <= 4_300,
            "20 issue rows must stay near the ~3k budget, got {} chars",
            compact.len()
        );
        // And the per-row average holds the ~190-char floor + title.
        assert!(
            compact.len() / 20 <= 215,
            "per-row average drifted: {} chars/row",
            compact.len() / 20
        );
    }

    #[test]
    fn collects_all_matching_status_ids_case_insensitively() {
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let statuses = [
            (first_id, "In Progress"),
            (second_id, "in progress"),
            (Uuid::new_v4(), "Todo"),
        ];

        assert_eq!(
            McpServer::matching_ids_by_name(statuses, "IN PROGRESS"),
            vec![first_id, second_id]
        );
    }

    #[test]
    fn collects_all_matching_tag_ids_case_insensitively() {
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let tags = [
            (first_id, "bug"),
            (second_id, "Bug"),
            (Uuid::new_v4(), "feature"),
        ];

        assert_eq!(
            McpServer::matching_ids_by_name(tags, "BUG"),
            vec![first_id, second_id]
        );
    }

    #[test]
    fn resolve_tag_filters_requires_explicit_tag_id_to_match_tag_name() {
        let tag_id = Uuid::new_v4();
        let other_tag_id = Uuid::new_v4();

        assert_eq!(
            McpServer::resolve_tag_filters(Some(tag_id), Some(vec![other_tag_id])),
            (None, None, true)
        );
    }

    #[test]
    fn resolve_tag_filters_preserves_exact_tag_id_intersection() {
        let tag_id = Uuid::new_v4();
        let other_tag_id = Uuid::new_v4();

        assert_eq!(
            McpServer::resolve_tag_filters(Some(tag_id), Some(vec![other_tag_id, tag_id])),
            (Some(tag_id), None, false)
        );
    }

    // --- VIBE-16 AC1-AC3: `McpUpdateIssueRequest.parent_issue_id` deserialization ---
    //
    // AC2 (`null` -> `Some(None)`) is the bug: under plain serde, `Option<Option<T>>` collapses a
    // JSON `null` into the outer `None` — byte-identical to the field being omitted. This is fixed
    // by `#[serde(default, deserialize_with = "some_if_present")]` on the field.

    #[test]
    fn omitted_parent_issue_id_deserializes_to_none() {
        let req: McpUpdateIssueRequest = serde_json::from_value(serde_json::json!({
            "issue_id": Uuid::new_v4().to_string(),
        }))
        .expect("an omitted parent_issue_id must not error - this is what a missing `default` would break");

        assert_eq!(req.parent_issue_id, None);
    }

    #[test]
    fn null_parent_issue_id_deserializes_to_some_none() {
        let req: McpUpdateIssueRequest = serde_json::from_value(serde_json::json!({
            "issue_id": Uuid::new_v4().to_string(),
            "parent_issue_id": null,
        }))
        .expect("an explicit null parent_issue_id must deserialize");

        assert_eq!(req.parent_issue_id, Some(None));
    }

    #[test]
    fn uuid_parent_issue_id_deserializes_to_some_some() {
        let parent = Uuid::new_v4();
        let req: McpUpdateIssueRequest = serde_json::from_value(serde_json::json!({
            "issue_id": Uuid::new_v4().to_string(),
            "parent_issue_id": parent.to_string(),
        }))
        .expect("a uuid parent_issue_id must deserialize");

        assert_eq!(req.parent_issue_id, Some(Some(parent)));
    }

    // --- VIBE-16 AC4: the handler's outbound PATCH body really carries `"parent_issue_id": null`
    //     (not merely the DTO in isolation) ---
    //
    // Naming honesty: this proves the handler's outbound WIRE CONTRACT against a loopback HTTP
    // stub, not persistence through the real server/DB (persistence is covered by code-reading —
    // `crates/server/src/routes/local_kanban.rs:534-537`). A bare
    // `serde_json::to_string(&UpdateIssueRequest { .. })` assertion would pass even if a future
    // edit re-lifted `parent_issue_id` to `Some(Some(..))` above the `UpdateIssueRequest` literal
    // (`:603`) — that lift would happen before construction, not inside it. Driving the real
    // `update_issue` method end-to-end over HTTP is what actually guards the `:603`
    // pass-through seam.
    mod update_issue_wire_test {
        use std::sync::{Arc, Mutex};

        use rmcp::handler::server::tool::ToolRouter;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::{TcpListener, TcpStream},
        };

        use super::*;
        use crate::task_server::McpMode;

        /// Every response `send_json` (`tools/mod.rs:118-149`) accepts must be wrapped in
        /// `ApiResponseEnvelope<T>` — a bare body fails to deserialize at the first GET.
        fn envelope(data: serde_json::Value) -> serde_json::Value {
            serde_json::json!({ "success": true, "data": data, "message": null })
        }

        /// Read one HTTP/1.1 request off `stream` (headers through `\r\n\r\n`, then exactly
        /// `Content-Length` body bytes), route it by `(method, path)`, respond, and close the
        /// connection. `Connection: close` is mandatory: reqwest reuses a keep-alive socket for
        /// the next request, and a stub that `accept()`s once per request would otherwise hang on
        /// the second `accept()` while reqwest writes request 2 into the first socket.
        ///
        /// Routes (see `tools/mod.rs:290,507,608`):
        /// - `GET /api/issues/{id}`             -> the issue, enveloped
        /// - `GET /api/project-statuses?...`    -> an empty status list, enveloped and wrapped in
        ///   `ListProjectStatusesResponse`'s `project_statuses` key
        /// - `PATCH /api/issues/{id}`           -> `MutationResponse<Issue>` (`{data, txid}`),
        ///   itself enveloped — genuinely double-nested under `data`. The request body is
        ///   captured into `patch_capture`.
        async fn serve_one(
            mut stream: TcpStream,
            issue_json: &serde_json::Value,
            patch_capture: &Arc<Mutex<Option<String>>>,
        ) {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).await.expect("read request bytes");
                assert!(n > 0, "connection closed before headers were complete");
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos;
                }
            };

            let header_text = std::str::from_utf8(&buf[..header_end]).expect("headers are utf8");
            let mut lines = header_text.split("\r\n");
            let request_line = lines.next().expect("request line present");
            let mut parts = request_line.split_whitespace();
            let method = parts.next().expect("method present").to_string();
            let target = parts.next().expect("target present").to_string();
            let path = target.split('?').next().unwrap_or(&target).to_string();

            let content_length: usize = lines
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse().ok())
                .unwrap_or(0);

            let mut request_body = buf[header_end + 4..].to_vec();
            while request_body.len() < content_length {
                let n = stream
                    .read(&mut chunk)
                    .await
                    .expect("read request body bytes");
                assert!(
                    n > 0,
                    "connection closed before the request body was complete"
                );
                request_body.extend_from_slice(&chunk[..n]);
            }

            let response_body = match (method.as_str(), path.as_str()) {
                ("GET", p) if p.starts_with("/api/issues/") => envelope(issue_json.clone()),
                ("GET", "/api/project-statuses") => {
                    envelope(serde_json::json!({ "project_statuses": [] }))
                }
                ("PATCH", p) if p.starts_with("/api/issues/") => {
                    let body_text = String::from_utf8(request_body).expect("PATCH body is utf8");
                    *patch_capture.lock().unwrap() = Some(body_text);
                    envelope(serde_json::json!({ "data": issue_json, "txid": 1 }))
                }
                _ => panic!("stub received an unrouted request: {method} {target}"),
            };

            let payload = serde_json::to_vec(&response_body).expect("stub response serializes");
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            stream
                .write_all(head.as_bytes())
                .await
                .expect("write response head");
            stream
                .write_all(&payload)
                .await
                .expect("write response body");
            stream.shutdown().await.ok();
        }

        /// Accept and serve exactly `n` requests, one loopback connection each.
        async fn run_stub(
            listener: TcpListener,
            n: usize,
            issue_json: serde_json::Value,
            patch_capture: Arc<Mutex<Option<String>>>,
        ) {
            for _ in 0..n {
                let (stream, _) = listener.accept().await.expect("accept stub connection");
                serve_one(stream, &issue_json, &patch_capture).await;
            }
        }

        /// Drives the REAL `update_issue` handler, from a raw JSON `parent_issue_id: null`
        /// payload (exactly what an MCP client sends — `Parameters<McpUpdateIssueRequest>` is
        /// built by deserializing that JSON, never by constructing the struct directly), through
        /// to the outbound PATCH body against the loopback stub. This exercises the WHOLE chain:
        /// step 2's `deserialize_with` turning `null` into `Some(None)`, and the `:603`
        /// pass-through not rewrapping it. Asserts the PATCH body carries the key
        /// present-and-`null` — absent vs `null` is the entire bug this card fixes.
        #[tokio::test]
        async fn update_issue_sends_null_parent_in_patch_body() {
            let parent = Uuid::new_v4();
            let issue = issue_fixture(None, Some(parent));
            let issue_json = serde_json::to_value(&issue).expect("issue serializes");

            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind loopback listener");
            let port = listener
                .local_addr()
                .expect("listener has a local addr")
                .port();

            let patch_capture: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let stub = tokio::spawn(run_stub(
                listener,
                3,
                issue_json.clone(),
                patch_capture.clone(),
            ));

            let server = McpServer {
                client: reqwest::Client::new(),
                base_url: format!("http://127.0.0.1:{port}"),
                tool_router: ToolRouter::default(),
                context: None,
                mode: McpMode::Global,
                headed_local_control: false,
            };

            let request: McpUpdateIssueRequest = serde_json::from_value(serde_json::json!({
                "issue_id": issue.id.to_string(),
                "parent_issue_id": null,
            }))
            .expect("the JSON payload a real MCP client sends must deserialize");

            let result = server
                .update_issue(Parameters(request))
                .await
                .expect("update_issue must not return a transport-level error");
            assert_ne!(
                result.is_error,
                Some(true),
                "update_issue reported a tool error: {result:?}"
            );

            stub.await.expect("stub server task must not panic");

            let patch_body = patch_capture
                .lock()
                .unwrap()
                .clone()
                .expect("the PATCH request must have been captured by the stub");
            let patch_value: serde_json::Value =
                serde_json::from_str(&patch_body).expect("PATCH body is valid JSON");
            let patch_obj = patch_value
                .as_object()
                .expect("PATCH body is a JSON object");

            assert!(
                patch_obj.contains_key("parent_issue_id"),
                "PATCH body must carry the parent_issue_id key present-and-null: {patch_value}"
            );
            assert_eq!(
                patch_obj["parent_issue_id"],
                serde_json::Value::Null,
                "parent_issue_id must be JSON null, not a UUID or omitted: {patch_value}"
            );

            // Sub-assertion, in the SAME test: an outer `None` omits the key entirely - that is
            // what gives the `null` above its meaning. `UpdateIssueRequest` does not derive
            // `Default` (`api-types/src/issue.rs:79`), so all 11 fields are constructed here,
            // copying the handler's own payload literal (`update_issue`'s
            // `UpdateIssueRequest { .. }`).
            let untouched = UpdateIssueRequest {
                status_id: None,
                title: None,
                description: None,
                priority: None,
                start_date: None,
                target_date: None,
                completed_at: None,
                sort_order: None,
                parent_issue_id: None,
                parent_issue_sort_order: None,
                extension_metadata: None,
            };
            let untouched_json =
                serde_json::to_string(&untouched).expect("untouched payload serializes");
            assert!(
                !untouched_json.contains("parent_issue_id"),
                "an outer None must omit the parent_issue_id key entirely: {untouched_json}"
            );
        }
    }

    /// Round-trip: `create_issue` -> `list_issues` (filtered by `parent_issue_id`)
    /// -> `get_issue` -> `update_issue`, all four driven as the REAL tool methods
    /// against a stateful loopback stub of the local REST API.
    ///
    /// Why a round-trip and not four unit tests: the two assertions this card
    /// cares about are both CROSS-TOOL invariants, and neither is visible from
    /// inside one tool.
    ///
    /// 1. `updated_at` must be byte-identical between a `list_issues` row and
    ///    the `get_issue` detail payload. The stamps come from two independent
    ///    code paths (`issue_to_summary` vs `issue_to_details`); the
    ///    orchestrator's `cards{}` cache compares them by exact STRING equality,
    ///    so a one-sided format change turns every cached card into a
    ///    `get_issue` every tick. The sibling unit test
    ///    `list_row_updated_at_matches_get_issue_rendering_byte_for_byte` pins
    ///    the two RENDERINGS; this pins the two PAYLOADS, over HTTP, before AND
    ///    after a write.
    /// 2. `parent_issue_id` really reaches `POST /api/issues/search` as a filter
    ///    — the plugin's sub-issue rules are built on it, and a dropped filter
    ///    would silently return the whole board instead of one card's children.
    mod round_trip_test {
        use std::sync::{Arc, Mutex};

        use axum::{
            Json, Router,
            extract::{Path, State},
            routing::{get, post},
            serve,
        };
        use rmcp::handler::server::tool::ToolRouter;
        use tokio::net::TcpListener;

        use super::*;
        use crate::task_server::McpMode;

        /// Sub-second stamps on purpose: `to_rfc3339()` renders the milliseconds,
        /// so a "just truncate to seconds" edit on either the list or the detail
        /// side breaks the byte-equality assertion instead of the cache.
        const CREATED_STAMP: &str = "2026-07-14T09:12:44.183Z";
        const UPDATED_STAMP: &str = "2026-08-08T17:04:05.007Z";
        /// What `DateTime::<Utc>::to_rfc3339()` makes of `UPDATED_STAMP`. Pinned
        /// literally so the rendering itself is part of the contract, not just
        /// "whatever both sides happen to agree on".
        const UPDATED_RFC3339: &str = "2026-08-08T17:04:05.007+00:00";

        /// The board the stub serves. Held behind a `Mutex` so a PATCH is visible
        /// to the `list_issues` / `get_issue` calls that follow it.
        struct Board {
            project_id: Uuid,
            todo_status_id: Uuid,
            in_review_status_id: Uuid,
            issues: Vec<serde_json::Value>,
            next_number: i64,
        }

        type SharedBoard = Arc<Mutex<Board>>;

        fn envelope(data: serde_json::Value) -> Json<serde_json::Value> {
            Json(serde_json::json!({ "success": true, "data": data, "message": null }))
        }

        /// A stored issue row, shaped exactly like `api_types::Issue` on the wire.
        fn stored_issue(
            board: &Board,
            id: Uuid,
            number: i64,
            title: &str,
            description: Option<&str>,
            parent_issue_id: Option<Uuid>,
        ) -> serde_json::Value {
            serde_json::json!({
                "id": id,
                "project_id": board.project_id,
                "issue_number": number,
                "simple_id": format!("VIBE-{number}"),
                "status_id": board.todo_status_id,
                "title": title,
                "description": description,
                "priority": "high",
                "start_date": null,
                "target_date": null,
                "completed_at": null,
                "sort_order": 0.0,
                "parent_issue_id": parent_issue_id,
                "parent_issue_sort_order": null,
                "extension_metadata": {},
                "created_at": CREATED_STAMP,
                "updated_at": CREATED_STAMP,
            })
        }

        fn find_issue(board: &Board, id: Uuid) -> serde_json::Value {
            board
                .issues
                .iter()
                .find(|issue| issue["id"] == serde_json::json!(id))
                .cloned()
                .unwrap_or_else(|| panic!("stub has no issue {id}"))
        }

        // --- stub handlers ---

        async fn stub_project_statuses(
            State(board): State<SharedBoard>,
        ) -> Json<serde_json::Value> {
            let board = board.lock().unwrap();
            envelope(serde_json::json!({
                "project_statuses": [
                    {
                        "id": board.todo_status_id,
                        "project_id": board.project_id,
                        "name": "Todo",
                        "color": "#888888",
                        // `default_status_id` picks the lowest sort_order among
                        // non-hidden statuses, so `create_issue` lands on Todo.
                        "sort_order": 0,
                        "hidden": false,
                        "is_terminal": false,
                        "created_at": CREATED_STAMP,
                    },
                    {
                        "id": board.in_review_status_id,
                        "project_id": board.project_id,
                        "name": "In Review",
                        "color": "#3355ff",
                        "sort_order": 1,
                        "hidden": false,
                        "is_terminal": false,
                        "created_at": CREATED_STAMP,
                    },
                ]
            }))
        }

        async fn stub_create_issue(
            State(board): State<SharedBoard>,
            Json(payload): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let mut board = board.lock().unwrap();
            let number = board.next_number;
            board.next_number += 1;
            let issue = serde_json::json!({
                "id": Uuid::new_v4(),
                "project_id": payload["project_id"],
                "issue_number": number,
                "simple_id": format!("VIBE-{number}"),
                "status_id": payload["status_id"],
                "title": payload["title"],
                "description": payload["description"],
                "priority": payload["priority"],
                "start_date": null,
                "target_date": null,
                "completed_at": null,
                "sort_order": payload["sort_order"],
                "parent_issue_id": payload["parent_issue_id"],
                "parent_issue_sort_order": null,
                "extension_metadata": {},
                "created_at": CREATED_STAMP,
                "updated_at": CREATED_STAMP,
            });
            board.issues.push(issue.clone());
            envelope(serde_json::json!({ "data": issue, "txid": 1 }))
        }

        /// `POST /api/issues/search`. Honours ONLY `parent_issue_id` — the filter
        /// under test. Everything else the real endpoint supports is irrelevant
        /// here and deliberately not emulated.
        async fn stub_search_issues(
            State(board): State<SharedBoard>,
            Json(query): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let board = board.lock().unwrap();
            let parent_filter = query.get("parent_issue_id").cloned();
            let rows: Vec<serde_json::Value> = board
                .issues
                .iter()
                .filter(|issue| match &parent_filter {
                    Some(parent) => &issue["parent_issue_id"] == parent,
                    None => true,
                })
                .cloned()
                .collect();
            envelope(serde_json::json!({
                "issues": rows,
                "total_count": rows.len(),
                "limit": 50,
                "offset": 0,
            }))
        }

        async fn stub_list_issues(State(board): State<SharedBoard>) -> Json<serde_json::Value> {
            let board = board.lock().unwrap();
            envelope(serde_json::json!({
                "issues": board.issues,
                "total_count": board.issues.len(),
                "limit": 50,
                "offset": 0,
            }))
        }

        async fn stub_get_issue(
            State(board): State<SharedBoard>,
            Path(id): Path<Uuid>,
        ) -> Json<serde_json::Value> {
            let board = board.lock().unwrap();
            envelope(find_issue(&board, id))
        }

        async fn stub_patch_issue(
            State(board): State<SharedBoard>,
            Path(id): Path<Uuid>,
            Json(payload): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let mut board = board.lock().unwrap();
            let issue = board
                .issues
                .iter_mut()
                .find(|issue| issue["id"] == serde_json::json!(id))
                .unwrap_or_else(|| panic!("stub has no issue {id}"));
            for field in [
                "status_id",
                "title",
                "description",
                "priority",
                "parent_issue_id",
            ] {
                if let Some(value) = payload.get(field) {
                    issue[field] = value.clone();
                }
            }
            // A write moves the stamp — which is exactly what makes the
            // post-update half of this test meaningful.
            issue["updated_at"] = serde_json::json!(UPDATED_STAMP);
            let updated = issue.clone();
            envelope(serde_json::json!({ "data": updated, "txid": 2 }))
        }

        async fn stub_empty_pull_requests() -> Json<serde_json::Value> {
            envelope(serde_json::json!({ "pull_requests": [] }))
        }

        async fn stub_empty_project_tags() -> Json<serde_json::Value> {
            envelope(serde_json::json!({ "tags": [] }))
        }

        async fn stub_empty_issue_tags() -> Json<serde_json::Value> {
            envelope(serde_json::json!({ "issue_tags": [] }))
        }

        async fn stub_empty_issue_relationships() -> Json<serde_json::Value> {
            envelope(serde_json::json!({ "issue_relationships": [] }))
        }

        /// Boot the stub and return `(base_url, board)`. `/issues/search` is
        /// registered as its own static route alongside `/issues/{id}`; matchit
        /// resolves static segments first, same as the real router
        /// (`crates/server/src/routes/kanban.rs`).
        async fn spawn_board_stub(board: SharedBoard) -> String {
            let app: Router = Router::new()
                .route("/api/project-statuses", get(stub_project_statuses))
                .route("/api/project-tags", get(stub_empty_project_tags))
                .route("/api/issue-tags", get(stub_empty_issue_tags))
                .route(
                    "/api/issue-relationships",
                    get(stub_empty_issue_relationships),
                )
                .route("/api/issues", get(stub_list_issues).post(stub_create_issue))
                .route("/api/issues/search", post(stub_search_issues))
                .route(
                    "/api/issues/{id}",
                    get(stub_get_issue).patch(stub_patch_issue),
                )
                .route(
                    "/api/issues/{id}/pull-requests",
                    get(stub_empty_pull_requests),
                )
                .with_state(board);

            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind loopback listener");
            let addr = listener.local_addr().expect("listener has a local addr");
            tokio::spawn(async move {
                serve(listener, app).await.expect("stub server serves");
            });
            format!("http://{addr}")
        }

        fn server_for(base_url: String) -> McpServer {
            McpServer {
                client: reqwest::Client::new(),
                base_url,
                tool_router: ToolRouter::default(),
                context: None,
                mode: McpMode::Global,
                headed_local_control: false,
            }
        }

        /// Unwrap a tool result into its JSON payload, failing loudly on a tool
        /// error (which is `Ok(..)` with `is_error: Some(true)`, not `Err`).
        fn payload(result: &CallToolResult) -> serde_json::Value {
            assert_ne!(
                result.is_error,
                Some(true),
                "tool reported an error: {result:?}"
            );
            let text = &result
                .content
                .first()
                .expect("tool result carries content")
                .as_text()
                .expect("tool result content is text")
                .text;
            serde_json::from_str(text).expect("tool result payload is JSON")
        }

        /// `list_issues` filtered to `parent_id`'s children.
        async fn list_children(
            server: &McpServer,
            project_id: Uuid,
            parent_id: Uuid,
        ) -> serde_json::Value {
            let request: McpListIssuesRequest = serde_json::from_value(serde_json::json!({
                "project_id": project_id,
                "parent_issue_id": parent_id,
            }))
            .expect("list payload deserializes");
            payload(
                &server
                    .list_issues(Parameters(request))
                    .await
                    .expect("list_issues must not fail at the transport level"),
            )
        }

        async fn get_one(server: &McpServer, issue_id: Uuid) -> serde_json::Value {
            let request: McpGetIssueRequest = serde_json::from_value(serde_json::json!({
                "issue_id": issue_id,
            }))
            .expect("get payload deserializes");
            payload(
                &server
                    .get_issue(Parameters(request))
                    .await
                    .expect("get_issue must not fail at the transport level"),
            )
        }

        #[tokio::test]
        async fn create_list_get_update_keeps_updated_at_byte_identical() {
            crate::task_server::tools::tests::install_rustls_provider();

            let project_id = Uuid::new_v4();
            let parent_id = Uuid::new_v4();
            let board = Arc::new(Mutex::new(Board {
                project_id,
                todo_status_id: Uuid::from_u128(0xa1),
                in_review_status_id: Uuid::from_u128(0xa2),
                issues: Vec::new(),
                next_number: 1,
            }));
            // Seed the parent card, so the `parent_issue_id` filter has something
            // real to be the child OF — and something it must NOT return.
            {
                let mut guard = board.lock().unwrap();
                let parent = stored_issue(&guard, parent_id, 1, "Parent card", None, None);
                guard.issues.push(parent);
                guard.next_number = 2;
            }

            let url = spawn_board_stub(board.clone()).await;
            let server = server_for(url);

            // --- 1. create_issue: one child of `parent_id`, one unparented control ---
            let child_request: McpCreateIssueRequest = serde_json::from_value(serde_json::json!({
                "project_id": project_id,
                "title": "Restore the issue MCP tools",
                "description": big_description(),
                "priority": "high",
                "parent_issue_id": parent_id,
            }))
            .expect("create payload deserializes");
            let created = payload(
                &server
                    .create_issue(Parameters(child_request))
                    .await
                    .expect("create_issue must not fail at the transport level"),
            );
            let child_id: Uuid = created["issue_id"]
                .as_str()
                .expect("create_issue returns an issue_id string")
                .parse()
                .expect("issue_id is a UUID");

            let control_request: McpCreateIssueRequest =
                serde_json::from_value(serde_json::json!({
                    "project_id": project_id,
                    "title": "An unrelated top-level card",
                }))
                .expect("control create payload deserializes");
            server
                .create_issue(Parameters(control_request))
                .await
                .expect("the control create_issue must not fail");

            // --- 2. list_issues filtered by parent_issue_id ---
            let listed = list_children(&server, project_id, parent_id).await;
            // The filter is load-bearing: three cards exist (parent, child,
            // control) and exactly ONE is a child of `parent_id`.
            assert_eq!(
                listed["returned_count"], 1,
                "parent_issue_id must reach the search endpoint as a real filter: {listed}"
            );
            let row = &listed["issues"][0];
            assert_eq!(row["id"], serde_json::json!(child_id.to_string()));
            assert_eq!(
                row["parent_issue_id"],
                serde_json::json!(parent_id.to_string()),
                "the row-level parent_issue_id is what the plugin's sub-issue rules read"
            );
            // The thin-row contract holds over the wire too (VIBE-23).
            assert!(
                row.as_object()
                    .expect("a list row is a JSON object")
                    .get("description")
                    .is_none(),
                "a list row must never carry the description: {row}"
            );
            let list_updated_at = row["updated_at"]
                .as_str()
                .expect("a list row carries updated_at")
                .to_string();

            // --- 3. get_issue on the same card ---
            let detail = get_one(&server, child_id).await;
            let detail_updated_at = detail["issue"]["updated_at"]
                .as_str()
                .expect("the detail payload carries updated_at")
                .to_string();

            // ⚠️ THE CACHE CONTRACT. Two independent renderings, one string.
            assert_eq!(
                list_updated_at, detail_updated_at,
                "list_issues and get_issue must render updated_at identically - \
                 the orchestrator's cards{{}} cache compares them by exact string equality"
            );
            assert_eq!(list_updated_at, "2026-07-14T09:12:44.183+00:00");
            // Sanity: the detail path DOES carry the body the list path withholds.
            assert!(
                detail["issue"]["description"]
                    .as_str()
                    .expect("get_issue returns the description")
                    .contains(BODY_NEEDLE),
                "get_issue is the sanctioned deep path - it must return the body"
            );

            // --- 4. update_issue: flip the status, lowercase, to also prove
            //        case-insensitive status resolution ---
            let update_request: McpUpdateIssueRequest = serde_json::from_value(serde_json::json!({
                "issue_id": child_id,
                "status": "in review",
            }))
            .expect("update payload deserializes");
            let ack = payload(
                &server
                    .update_issue(Parameters(update_request))
                    .await
                    .expect("update_issue must not fail at the transport level"),
            );
            assert_eq!(ack["changed"], serde_json::json!(["status"]));
            assert_eq!(
                ack["status"],
                serde_json::json!("In Review"),
                "the ack reports the board's CANONICAL status name, not what the caller typed"
            );
            assert_eq!(ack["updated_at"], serde_json::json!(UPDATED_RFC3339));

            // --- 5. the contract survives the write ---
            //
            // A stale-cache regression only bites AFTER a status flip: that is
            // when the orchestrator compares its cached stamp against a fresh
            // list row. All three renderings must still agree.
            let listed = list_children(&server, project_id, parent_id).await;
            let detail = get_one(&server, child_id).await;
            let list_updated_at = listed["issues"][0]["updated_at"]
                .as_str()
                .expect("a list row carries updated_at");
            let detail_updated_at = detail["issue"]["updated_at"]
                .as_str()
                .expect("the detail payload carries updated_at");

            assert_eq!(list_updated_at, detail_updated_at);
            assert_eq!(list_updated_at, UPDATED_RFC3339);
            assert_eq!(
                ack["updated_at"],
                serde_json::json!(list_updated_at),
                "the update ack's stamp must match what the next list row reports, \
                 or the orchestrator caches a value it can never match"
            );
            assert_eq!(
                listed["issues"][0]["status"],
                serde_json::json!("In Review")
            );
        }
    }
}
