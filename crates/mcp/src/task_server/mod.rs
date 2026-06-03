mod handler;
mod tools;

use std::path::Path;

use anyhow::Context;
use db::models::{requests::ContainerQuery, workspace::WorkspaceContext};
use rmcp::{handler::server::tool::ToolRouter, schemars};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) use crate::ApiResponseEnvelope;

/// The single implicit organization used by the local-only fork. Mirrors
/// `db::models::project::LOCAL_ORGANIZATION_ID` (`Uuid::from_u128(0xA001)`); kept
/// as a literal here so the MCP crate doesn't depend on the db crate.
const LOCAL_ORGANIZATION_ID: Uuid = Uuid::from_u128(0xA001);

/// Local kanban response for `GET /api/workspace-issue-link`.
#[derive(Debug, Clone, Deserialize)]
struct WorkspaceIssueLink {
    project_id: Option<Uuid>,
    issue_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct McpRepoContext {
    #[schemars(description = "The unique identifier of the repository")]
    pub repo_id: Uuid,
    #[schemars(description = "The name of the repository")]
    pub repo_name: String,
    #[schemars(description = "The target branch for this repository in this workspace")]
    pub target_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct McpContext {
    #[schemars(description = "The organization ID (if workspace is linked to remote)")]
    pub organization_id: Option<Uuid>,
    #[schemars(description = "The remote project ID (if workspace is linked to remote)")]
    pub project_id: Option<Uuid>,
    #[schemars(description = "The remote issue ID (if workspace is linked to a remote issue)")]
    pub issue_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(description = "The orchestrator session ID when running in orchestrator mode")]
    pub orchestrator_session_id: Option<Uuid>,
    pub workspace_id: Uuid,
    pub workspace_branch: String,
    #[schemars(
        description = "Repository info and target branches for each repo in this workspace"
    )]
    pub workspace_repos: Vec<McpRepoContext>,
}

#[derive(Debug, Clone)]
pub enum McpMode {
    Global,
    Orchestrator,
}

#[derive(Debug, Clone)]
pub struct McpServer {
    client: reqwest::Client,
    base_url: String,
    tool_router: ToolRouter<McpServer>,
    context: Option<McpContext>,
    mode: McpMode,
    /// Opt-in "headed local control" capability (launcher `--headed-local-control`).
    /// When enabled, Claude-Code-Headed direct-access identifiers (claude session
    /// id, `vk-<exec_id>` tmux name, transcript path) are surfaced to the
    /// orchestrator; when disabled, only the portable last-message progress is
    /// returned. Off by default to keep the default MCP surface host-agnostic.
    headed_local_control: bool,
}

impl McpServer {
    pub fn new_global(base_url: &str, headed_local_control: bool) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.to_string(),
            tool_router: Self::global_mode_router(),
            context: None,
            mode: McpMode::Global,
            headed_local_control,
        }
    }

    pub fn new_orchestrator(base_url: &str, headed_local_control: bool) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.to_string(),
            tool_router: Self::orchestrator_mode_router(),
            context: None,
            mode: McpMode::Orchestrator,
            headed_local_control,
        }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    pub async fn init(mut self) -> anyhow::Result<Self> {
        let context = self.fetch_context_at_startup().await?;

        if context.is_none() {
            self.tool_router.map.remove("get_context");
            tracing::debug!("VK context not available, get_context tool will not be registered");
        } else {
            tracing::info!("VK context loaded, get_context tool available");
        }

        self.context = context;
        Ok(self)
    }

    pub fn mode(&self) -> &McpMode {
        &self.mode
    }

    /// Whether the opt-in "headed local control" capability is enabled.
    pub fn headed_local_control(&self) -> bool {
        self.headed_local_control
    }

    async fn fetch_context_at_startup(&self) -> anyhow::Result<Option<McpContext>> {
        let current_dir = std::env::current_dir().context("Failed to resolve current directory")?;
        let canonical_path = current_dir.canonicalize().unwrap_or(current_dir);
        let normalized_path = utils::path::normalize_macos_private_alias(&canonical_path);

        match self.try_fetch_attempt_context(&normalized_path).await {
            Ok(Some(ctx)) => Ok(Some(
                self.build_mcp_context_from_workspace_context(&ctx).await,
            )),
            Ok(None) | Err(_) if matches!(self.mode(), McpMode::Global) => Ok(None),
            Ok(None) => anyhow::bail!(
                "Failed to load orchestrator MCP context from /api/containers/attempt-context"
            ),
            Err(error) => Err(error.context("Failed to load orchestrator MCP context")),
        }
    }

    async fn try_fetch_attempt_context(
        &self,
        path: &Path,
    ) -> anyhow::Result<Option<WorkspaceContext>> {
        let url = self.url("/api/containers/attempt-context");
        let query = ContainerQuery {
            container_ref: path.to_string_lossy().to_string(),
        };

        let response = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            self.client.get(&url).query(&query).send(),
        )
        .await
        .context("Timed out fetching /api/containers/attempt-context")?
        .context("Failed to fetch /api/containers/attempt-context")?;

        if !response.status().is_success() {
            return Ok(None);
        }

        let api_response: ApiResponseEnvelope<WorkspaceContext> = response
            .json()
            .await
            .context("Failed to parse /api/containers/attempt-context response")?;

        if !api_response.success {
            return Ok(None);
        }

        Ok(api_response.data)
    }

    async fn build_mcp_context_from_workspace_context(&self, ctx: &WorkspaceContext) -> McpContext {
        let workspace_repos: Vec<McpRepoContext> = ctx
            .workspace_repos
            .iter()
            .map(|rwb| McpRepoContext {
                repo_id: rwb.repo.id,
                repo_name: rwb.repo.name.clone(),
                target_branch: rwb.target_branch.clone(),
            })
            .collect();

        let workspace_id = ctx.workspace.id;
        let workspace_branch = ctx.workspace.branch.clone();
        let orchestrator_session_id = if matches!(self.mode(), McpMode::Orchestrator) {
            ctx.orchestrator_session_id
        } else {
            None
        };

        let (project_id, issue_id) = self
            .fetch_workspace_issue_link(workspace_id)
            .await
            .unwrap_or((None, None));
        // Local-only: a single implicit organization once a workspace resolves
        // to a project.
        let organization_id = project_id.map(|_| LOCAL_ORGANIZATION_ID);

        McpContext {
            organization_id,
            project_id,
            issue_id,
            orchestrator_session_id,
            workspace_id,
            workspace_branch,
            workspace_repos,
        }
    }

    /// Resolve the project/issue a workspace is linked to via the local kanban
    /// API. Returns `(project_id, issue_id)`, each `None` if the workspace isn't
    /// linked to a kanban issue.
    async fn fetch_workspace_issue_link(
        &self,
        workspace_id: Uuid,
    ) -> Option<(Option<Uuid>, Option<Uuid>)> {
        let url = self.url(&format!(
            "/api/workspace-issue-link?workspace_id={}",
            workspace_id
        ));

        let response = tokio::time::timeout(
            std::time::Duration::from_millis(2000),
            self.client.get(&url).send(),
        )
        .await
        .ok()?
        .ok()?;

        if !response.status().is_success() {
            return None;
        }

        let api_response: ApiResponseEnvelope<WorkspaceIssueLink> = response.json().await.ok()?;

        if !api_response.success {
            return None;
        }

        let link = api_response.data?;
        Some((link.project_id, link.issue_id))
    }
}
