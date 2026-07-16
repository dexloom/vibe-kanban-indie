use std::collections::HashMap;

use db::models::{requests::UpdateWorkspace, workspace::Workspace};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpListWorkspacesRequest {
    #[schemars(description = "Filter by archived state")]
    archived: Option<bool>,
    #[schemars(description = "Filter by pinned state")]
    pinned: Option<bool>,
    #[schemars(description = "Filter by branch name (exact match, case-insensitive)")]
    branch: Option<String>,
    #[schemars(description = "Case-insensitive substring match against workspace name")]
    name_search: Option<String>,
    #[schemars(description = "Maximum number of workspaces to return (default: 50)")]
    limit: Option<i32>,
    #[schemars(description = "Number of results to skip before returning rows (default: 0)")]
    offset: Option<i32>,
}

/// Thin list row returned by `list_workspaces`: identity, flags, the linked card, and
/// timestamps — never scripts, prompts, or other long text (VIBE-23). Null-valued keys are
/// omitted, not serialized as `null`. `created_at` stays: the sweeper's lane-letter
/// assignment sorts the inventory by `(created_at ASC, workspace_id ASC)`.
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct WorkspaceSummary {
    #[schemars(description = "Workspace ID")]
    id: String,
    #[schemars(description = "Workspace branch")]
    branch: String,
    #[schemars(description = "Whether the workspace is archived")]
    archived: bool,
    #[schemars(description = "Whether the workspace is pinned")]
    pinned: bool,
    #[schemars(description = "Workspace display name, omitted when unset")]
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[schemars(
        description = "ID of the issue (card) this workspace is linked to, omitted when unlinked"
    )]
    #[serde(skip_serializing_if = "Option::is_none")]
    issue_id: Option<String>,
    #[schemars(description = "Creation timestamp")]
    created_at: String,
    #[schemars(description = "Last update timestamp")]
    updated_at: String,
}

/// One row of `GET /api/workspace-issue-links` — the whole link table in a single call, so
/// `list_workspaces` costs one extra request instead of one per row.
#[derive(Debug, Deserialize)]
struct WorkspaceIssueLinkRow {
    workspace_id: Uuid,
    issue_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListWorkspacesResponse {
    workspaces: Vec<WorkspaceSummary>,
    total_count: usize,
    returned_count: usize,
    limit: usize,
    offset: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpUpdateWorkspaceRequest {
    #[schemars(
        description = "Workspace ID to update. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(description = "Set archived state")]
    archived: Option<bool>,
    #[schemars(description = "Set pinned state")]
    pinned: Option<bool>,
    #[schemars(description = "Set workspace display name (empty string clears it)")]
    name: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpUpdateWorkspaceResponse {
    success: bool,
    workspace_id: String,
    archived: bool,
    pinned: bool,
    name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpDeleteWorkspaceRequest {
    #[schemars(
        description = "Workspace ID to delete. Optional if running inside that workspace context."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Also delete linked remote workspace when available (default: false)"
    )]
    delete_remote: Option<bool>,
    #[schemars(description = "Also delete workspace branches from repos (default: false)")]
    delete_branches: Option<bool>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpDeleteWorkspaceResponse {
    success: bool,
    workspace_id: String,
    delete_remote: bool,
    delete_branches: bool,
}

#[tool_router(router = workspaces_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "List local workspaces with optional filters and pagination. Returns thin summary rows - id, branch, archived, pinned, created_at, updated_at, plus name and the linked card's issue_id only when set - never scripts, prompts, or other long text. Null fields are omitted."
    )]
    async fn list_workspaces(
        &self,
        Parameters(McpListWorkspacesRequest {
            archived,
            pinned,
            branch,
            name_search,
            limit,
            offset,
        }): Parameters<McpListWorkspacesRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url("/api/workspaces");
        let mut workspaces: Vec<Workspace> = match self.send_json(self.client.get(&url)).await {
            Ok(ws) => ws,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        if let Some(archived_filter) = archived {
            workspaces.retain(|w| w.archived == archived_filter);
        }
        if let Some(pinned_filter) = pinned {
            workspaces.retain(|w| w.pinned == pinned_filter);
        }
        if let Some(branch_filter) = branch.as_deref() {
            workspaces.retain(|w| w.branch.eq_ignore_ascii_case(branch_filter));
        }
        if let Some(name_search) = name_search.as_deref() {
            let needle = name_search.to_ascii_lowercase();
            workspaces.retain(|w| {
                w.name
                    .as_deref()
                    .map(|name| name.to_ascii_lowercase().contains(&needle))
                    .unwrap_or(false)
            });
        }

        // Keep ordering deterministic after filtering.
        workspaces.sort_by_key(|w| std::cmp::Reverse(w.created_at));

        let total_count = workspaces.len();
        let offset = offset.unwrap_or(0).max(0) as usize;
        let limit = limit.unwrap_or(50).max(0) as usize;

        // One bulk fetch of the whole link table, joined onto the rows in memory.
        // Best-effort: a failure here degrades to rows without `issue_id` (consumers
        // fall back to name/branch mapping), never to a failed list.
        let links_url = self.url("/api/workspace-issue-links");
        let issue_by_workspace: HashMap<Uuid, Uuid> = match self
            .send_json::<Vec<WorkspaceIssueLinkRow>>(self.client.get(&links_url))
            .await
        {
            Ok(links) => links
                .into_iter()
                .map(|link| (link.workspace_id, link.issue_id))
                .collect(),
            Err(_) => HashMap::new(),
        };

        let workspace_summaries = workspaces
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|workspace| {
                let issue_id = issue_by_workspace.get(&workspace.id).copied();
                workspace_to_summary(workspace, issue_id)
            })
            .collect::<Vec<_>>();

        // Compact on purpose: a many-row list pretty-printed is ~35% whitespace (VIBE-23).
        McpServer::success_compact(&McpListWorkspacesResponse {
            returned_count: workspace_summaries.len(),
            total_count,
            limit,
            offset,
            workspaces: workspace_summaries,
        })
    }

    #[tool(
        description = "Update a workspace's archived, pinned, or name fields. `workspace_id` is optional if running inside that workspace context."
    )]
    async fn update_workspace(
        &self,
        Parameters(McpUpdateWorkspaceRequest {
            workspace_id,
            archived,
            pinned,
            name,
        }): Parameters<McpUpdateWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let url = self.url(&format!("/api/workspaces/{}", workspace_id));
        let payload = UpdateWorkspace {
            archived,
            pinned,
            name,
        };

        let updated: Workspace = match self.send_json(self.client.put(&url).json(&payload)).await {
            Ok(ws) => ws,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        McpServer::success(&McpUpdateWorkspaceResponse {
            success: true,
            workspace_id: updated.id.to_string(),
            archived: updated.archived,
            pinned: updated.pinned,
            name: updated.name,
        })
    }

    #[tool(
        description = "Delete a local workspace. `workspace_id` is optional if running inside that workspace context."
    )]
    async fn delete_workspace(
        &self,
        Parameters(McpDeleteWorkspaceRequest {
            workspace_id,
            delete_remote,
            delete_branches,
        }): Parameters<McpDeleteWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let delete_remote = delete_remote.unwrap_or(false);
        let delete_branches = delete_branches.unwrap_or(false);

        let url = self.url(&format!("/api/workspaces/{}", workspace_id));
        if let Err(e) = self
            .send_empty_json(self.client.delete(&url).query(&[
                ("delete_remote", delete_remote),
                ("delete_branches", delete_branches),
            ]))
            .await
        {
            return Ok(Self::tool_error(e));
        }

        McpServer::success(&McpDeleteWorkspaceResponse {
            success: true,
            workspace_id: workspace_id.to_string(),
            delete_remote,
            delete_branches,
        })
    }
}

/// Pure: project a `Workspace` (+ its resolved link, if any) down to the thin list row.
fn workspace_to_summary(workspace: Workspace, issue_id: Option<Uuid>) -> WorkspaceSummary {
    WorkspaceSummary {
        id: workspace.id.to_string(),
        branch: workspace.branch,
        archived: workspace.archived,
        pinned: workspace.pinned,
        name: workspace.name,
        issue_id: issue_id.map(|id| id.to_string()),
        created_at: workspace.created_at.to_rfc3339(),
        updated_at: workspace.updated_at.to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a real `Workspace` from a JSON fixture — same trick as VIBE-1/VIBE-2's issue
    /// fixtures: `Workspace` derives `Deserialize`, so no hand-constructed chrono values.
    fn workspace_fixture(name: Option<&str>) -> Workspace {
        serde_json::from_value(serde_json::json!({
            "id": "af804716-4577-46bb-8e9f-ffb6d54cd161",
            "task_id": null,
            "container_ref": null,
            "branch": "vk/af80-slim-list-issues",
            "setup_completed_at": null,
            "created_at": "2026-07-14T08:33:26.079338Z",
            "updated_at": "2026-07-16T10:40:02.498Z",
            "archived": false,
            "pinned": false,
            "name": name,
            "worktree_deleted": false,
            "ephemeral": false,
            "kind": null,
            "current_pipeline_stage": null
        }))
        .expect("fixture JSON should deserialize into Workspace")
    }

    fn summary_json(summary: &WorkspaceSummary) -> serde_json::Map<String, serde_json::Value> {
        let value = serde_json::to_value(summary).expect("summary serializes");
        value.as_object().expect("summary is a JSON object").clone()
    }

    // --- AC: no null-valued keys in list rows ---
    #[test]
    fn unlinked_unnamed_row_omits_null_keys() {
        let summary = workspace_to_summary(workspace_fixture(None), None);
        let obj = summary_json(&summary);

        assert!(obj.get("name").is_none(), "unset name must be omitted");
        assert!(
            obj.get("issue_id").is_none(),
            "unlinked issue_id must be omitted"
        );
        assert!(
            obj.values().all(|v| !v.is_null()),
            "no null-valued keys allowed in list rows: {obj:?}"
        );
        // The always-present core survives.
        for key in [
            "id",
            "branch",
            "archived",
            "pinned",
            "created_at",
            "updated_at",
        ] {
            assert!(obj.get(key).is_some(), "missing `{key}`");
        }
    }

    #[test]
    fn linked_named_row_carries_name_and_issue_id() {
        let issue_id = Uuid::new_v4();
        let summary = workspace_to_summary(workspace_fixture(Some("VIBE-23")), Some(issue_id));
        let obj = summary_json(&summary);

        assert_eq!(obj["name"], serde_json::json!("VIBE-23"));
        assert_eq!(obj["issue_id"], serde_json::json!(issue_id.to_string()));
    }

    // --- AC: ~10 workspaces ≤ ~2k chars ---
    #[test]
    fn ten_workspace_rows_fit_the_size_budget() {
        let workspaces = (0..10)
            .map(|i| {
                let named = i % 2 == 0;
                workspace_to_summary(
                    workspace_fixture(named.then_some("VIBE-23")),
                    named.then(Uuid::new_v4),
                )
            })
            .collect::<Vec<_>>();
        let response = McpListWorkspacesResponse {
            returned_count: workspaces.len(),
            total_count: workspaces.len(),
            limit: 50,
            offset: 0,
            workspaces,
        };

        let compact = serde_json::to_string(&response).expect("response serializes");
        assert!(
            compact.len() <= 2_600,
            "10 workspace rows must stay near the ~2k budget, got {} chars",
            compact.len()
        );
    }
}
