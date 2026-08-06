use std::str::FromStr;

use api_types::Issue;
use db::models::execution_process::ExecutionProcessStatus;
use executors::executors::BaseCodingAgent;
use rmcp::{
    ErrorData,
    model::{CallToolResult, Content},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

use super::{ApiResponseEnvelope, McpMode, McpServer};

type ToolCallResult = Result<CallToolResult, ErrorData>;

#[derive(Debug, Error)]
#[error("{message}")]
struct ToolError {
    message: String,
    details: Option<String>,
}

impl ToolError {
    fn new(message: impl Into<String>, details: Option<impl Into<String>>) -> Self {
        Self {
            message: message.into(),
            details: details.map(Into::into),
        }
    }

    fn message(message: impl Into<String>) -> Self {
        Self::new(message, None::<String>)
    }
}

mod approvals;
mod context;
mod issue_assignees;
mod issue_relationships;
mod issue_tags;
mod orchestrator_prompt;
mod organizations;
mod repos;
mod sessions;
mod task_attempts;
mod workspaces;

impl McpServer {
    pub fn global_mode_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        Self::context_tools_router()
            + Self::workspaces_tools_router()
            + Self::organizations_tools_router()
            + Self::repos_tools_router()
            + Self::issue_assignees_tools_router()
            + Self::issue_tags_tools_router()
            + Self::issue_relationships_tools_router()
            + Self::task_attempts_tools_router()
            + Self::session_tools_router()
            + Self::approvals_tools_router()
    }

    pub fn orchestrator_mode_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        let mut router = Self::context_tools_router()
            + Self::workspaces_tools_router()
            + Self::session_tools_router()
            // Orchestrators need to answer questions / approve plans (and stop
            // runaway executions) for the headed agents they drive.
            + Self::approvals_tools_router()
            // ADR-016: per-tick orchestrator prompt lookup. Card-scoped
            // agents must NOT read sibling prompts; this router is
            // exposed only to the orchestrator instance.
            + Self::orchestrator_prompt_tools_router();
        router.remove_route("list_workspaces");
        router.remove_route("delete_workspace");
        router
    }
}

impl McpServer {
    fn orchestrator_session_id(&self) -> Option<Uuid> {
        self.context
            .as_ref()
            .and_then(|ctx| ctx.orchestrator_session_id)
    }

    fn scoped_workspace_id(&self) -> Option<Uuid> {
        self.context.as_ref().map(|ctx| ctx.workspace_id)
    }

    fn success<T: Serialize>(data: &T) -> ToolCallResult {
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(data)
                .unwrap_or_else(|_| "Failed to serialize response".to_string()),
        )]))
    }

    /// Like `success`, but compact (no pretty-printing). Used by list-shaped
    /// tools (`list_issues`, `list_workspaces`): their rows are machine-read by
    /// agents, and pretty-printing a many-row list is ~35% indentation and
    /// newlines by weight (VIBE-23).
    fn success_compact<T: Serialize>(data: &T) -> ToolCallResult {
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string(data)
                .unwrap_or_else(|_| "Failed to serialize response".to_string()),
        )]))
    }

    fn err<S: Into<String>>(msg: S, details: Option<S>) -> ToolCallResult {
        Ok(Self::tool_error(ToolError::new(msg, details)))
    }

    fn tool_error(error: ToolError) -> CallToolResult {
        let mut value = serde_json::json!({
            "success": false,
            "error": error.message,
        });
        if let Some(details) = error.details {
            value["details"] = serde_json::json!(details);
        }

        CallToolResult::error(vec![Content::text(
            serde_json::to_string_pretty(&value)
                .unwrap_or_else(|_| "Failed to serialize error".to_string()),
        )])
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        rb: reqwest::RequestBuilder,
    ) -> Result<T, ToolError> {
        let resp = rb.send().await.map_err(|error| {
            ToolError::new("Failed to connect to VK API", Some(error.to_string()))
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            return Err(ToolError::message(format!(
                "VK API returned error status: {}",
                status
            )));
        }

        let api_response = resp
            .json::<ApiResponseEnvelope<T>>()
            .await
            .map_err(|error| {
                ToolError::new("Failed to parse VK API response", Some(error.to_string()))
            })?;

        if !api_response.success {
            let msg = api_response.message.as_deref().unwrap_or("Unknown error");
            return Err(ToolError::new("VK API returned error", Some(msg)));
        }

        api_response
            .data
            .ok_or_else(|| ToolError::message("VK API response missing data field"))
    }

    async fn send_empty_json(&self, rb: reqwest::RequestBuilder) -> Result<(), ToolError> {
        let resp = rb.send().await.map_err(|error| {
            ToolError::new("Failed to connect to VK API", Some(error.to_string()))
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            return Err(ToolError::message(format!(
                "VK API returned error status: {}",
                status
            )));
        }

        #[derive(Deserialize)]
        struct EmptyApiResponse {
            success: bool,
            message: Option<String>,
        }

        let api_response = resp.json::<EmptyApiResponse>().await.map_err(|error| {
            ToolError::new("Failed to parse VK API response", Some(error.to_string()))
        })?;

        if !api_response.success {
            let msg = api_response.message.as_deref().unwrap_or("Unknown error");
            return Err(ToolError::new("VK API returned error", Some(msg)));
        }

        Ok(())
    }

    fn resolve_workspace_id(&self, explicit: Option<Uuid>) -> Result<Uuid, ToolError> {
        if let Some(id) = explicit {
            return Ok(id);
        }
        if let Some(workspace_id) = self.scoped_workspace_id() {
            return Ok(workspace_id);
        }
        Err(ToolError::message(
            "workspace_id is required (not available from current MCP context)",
        ))
    }

    fn scope_allows_workspace(&self, workspace_id: Uuid) -> Result<(), ToolError> {
        if matches!(self.mode(), McpMode::Orchestrator)
            && let Some(scoped_workspace_id) = self.scoped_workspace_id()
            && scoped_workspace_id != workspace_id
        {
            return Err(ToolError::new(
                "Operation is outside the configured workspace scope",
                Some(format!(
                    "requested workspace_id={}, configured workspace_id={}",
                    workspace_id, scoped_workspace_id
                )),
            ));
        }

        Ok(())
    }

    // Resolves a project_id from an explicit parameter or falls back to context.
    fn resolve_project_id(&self, explicit: Option<Uuid>) -> Result<Uuid, ToolError> {
        if let Some(id) = explicit {
            return Ok(id);
        }
        if let Some(ctx) = &self.context
            && let Some(id) = ctx.project_id
        {
            return Ok(id);
        }
        Err(ToolError::message(
            "project_id is required (not available from workspace context)",
        ))
    }

    // Resolves an organization_id from an explicit parameter or context, falling
    // back to the single implicit local organization.
    fn resolve_organization_id(&self, explicit: Option<Uuid>) -> Result<Uuid, ToolError> {
        if let Some(id) = explicit {
            return Ok(id);
        }
        if let Some(ctx) = &self.context
            && let Some(id) = ctx.organization_id
        {
            return Ok(id);
        }
        Ok(super::LOCAL_ORGANIZATION_ID)
    }

    // Links a workspace to a remote issue by fetching issue.project_id and calling link endpoint.
    async fn link_workspace_to_issue(
        &self,
        workspace_id: Uuid,
        issue_id: Uuid,
    ) -> Result<(), ToolError> {
        let issue_url = self.url(&format!("/api/issues/{}", issue_id));
        let issue: Issue = self.send_json(self.client.get(&issue_url)).await?;

        let link_url = self.url(&format!("/api/workspaces/{}/links", workspace_id));
        let link_payload = serde_json::json!({
            "project_id": issue.project_id,
            "issue_id": issue_id,
        });
        self.send_empty_json(self.client.post(&link_url).json(&link_payload))
            .await
    }

    fn parse_executor_agent(executor: &str) -> Result<BaseCodingAgent, ToolError> {
        let normalized = executor.replace('-', "_").to_ascii_uppercase();
        BaseCodingAgent::from_str(&normalized)
            .map_err(|_| ToolError::message(format!("Unknown executor '{executor}'.")))
    }

    fn normalize_executor_name(executor: Option<&str>) -> Result<String, ToolError> {
        let Some(executor) = executor.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok("CODEX".to_string());
        };

        Self::parse_executor_agent(executor)
            .map(|agent| agent.to_string())
            .map_err(|_| {
                ToolError::message(format!(
                    "Unknown executor '{}' configured for session",
                    executor
                ))
            })
    }

    fn execution_process_status_label(status: &ExecutionProcessStatus) -> &'static str {
        match status {
            ExecutionProcessStatus::Running => "running",
            ExecutionProcessStatus::Completed => "completed",
            ExecutionProcessStatus::Failed => "failed",
            ExecutionProcessStatus::Killed => "killed",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, sync::Once};

    use rmcp::handler::server::tool::ToolRouter;
    use uuid::Uuid;

    use super::McpServer;
    use crate::task_server::{McpContext, McpMode, McpRepoContext};

    static RUSTLS_PROVIDER: Once = Once::new();

    /// Install the rustls crypto provider once per process. Shared across
    /// every `#[cfg(test)]` module that needs reqwest over rustls — the
    /// sibling `orchestrator_prompt` tests call this through
    /// `super::super::install_rustls_provider` so a single process-wide
    /// install covers them all.
    pub(crate) fn install_rustls_provider() {
        RUSTLS_PROVIDER.call_once(|| {
            rustls::crypto::aws_lc_rs::default_provider()
                .install_default()
                .expect("Failed to install rustls crypto provider");
        });
    }

    // (Tests continue below.)

    fn tool_names(router: rmcp::handler::server::tool::ToolRouter<McpServer>) -> BTreeSet<String> {
        router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect()
    }

    #[test]
    fn orchestrator_mode_exposes_only_scoped_workflow_tools() {
        let actual = tool_names(McpServer::orchestrator_mode_router());
        let expected = BTreeSet::from([
            "create_session".to_string(),
            "get_context".to_string(),
            "get_execution".to_string(),
            // ADR-016: per-tick orchestrator prompt lookup. Card-scoped
            // agents must NOT read sibling prompts, so this lives only
            // in the orchestrator router.
            "get_orchestrator_prompt".to_string(),
            "list_sessions".to_string(),
            // Approval-control tools so the orchestrator can read, unblock, and
            // stop the agents it drives (mirrors global mode).
            "list_pending_approvals".to_string(),
            "respond_to_approval".to_string(),
            "run_issue_in_workspace".to_string(),
            "run_session_prompt".to_string(),
            "stop_execution".to_string(),
            "update_session".to_string(),
            "update_workspace".to_string(),
        ]);

        assert_eq!(actual, expected);
    }

    #[test]
    fn global_mode_keeps_workspace_admin_and_discovery_tools() {
        let actual = tool_names(McpServer::global_mode_router());

        assert!(actual.contains("list_workspaces"));
        assert!(actual.contains("delete_workspace"));
        assert!(!actual.contains("output_markdown"));
        // Approval-control tools must be available so the orchestrator can
        // unblock and stop agents.
        assert!(actual.contains("respond_to_approval"));
        assert!(actual.contains("stop_execution"));
    }

    /// ADR-016: `get_orchestrator_prompt` is orchestrator-only — card-scoped
    /// agents must never read sibling prompts. Asserting the NEGATIVE here
    /// (global mode does NOT expose it) catches a regression where someone
    /// adds the router to the wrong scope.
    #[test]
    fn orchestrator_prompt_tool_is_orchestrator_only() {
        let orch = tool_names(McpServer::orchestrator_mode_router());
        let global = tool_names(McpServer::global_mode_router());

        assert!(orch.contains("get_orchestrator_prompt"));
        assert!(
            !global.contains("get_orchestrator_prompt"),
            "get_orchestrator_prompt MUST NOT be in the global_mode router"
        );
    }

    #[test]
    fn orchestrator_session_id_is_resolved_from_context() {
        install_rustls_provider();
        let session_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        let server = McpServer {
            client: reqwest::Client::new(),
            base_url: "http://127.0.0.1:3000".to_string(),
            tool_router: ToolRouter::default(),
            context: Some(McpContext {
                organization_id: None,
                project_id: None,
                issue_id: None,
                orchestrator_session_id: Some(session_id),
                workspace_id,
                workspace_branch: "main".to_string(),
                workspace_repos: vec![McpRepoContext {
                    repo_id: Uuid::new_v4(),
                    repo_name: "repo".to_string(),
                    target_branch: "main".to_string(),
                }],
            }),
            mode: McpMode::Global,
            headed_local_control: false,
        };

        assert_eq!(server.orchestrator_session_id(), Some(session_id));
        assert_eq!(server.resolve_workspace_id(None).unwrap(), workspace_id);
    }

    #[test]
    fn orchestrator_scope_requires_context_when_missing() {
        install_rustls_provider();
        let server = McpServer {
            client: reqwest::Client::new(),
            base_url: "http://127.0.0.1:3000".to_string(),
            tool_router: ToolRouter::default(),
            context: None,
            mode: McpMode::Orchestrator,
            headed_local_control: false,
        };

        assert_eq!(server.orchestrator_session_id(), None);
        assert!(server.resolve_workspace_id(None).is_err());
        assert!(server.scope_allows_workspace(Uuid::new_v4()).is_ok());
    }

    #[test]
    fn global_context_omits_orchestrator_session_id_from_serialized_output() {
        install_rustls_provider();
        let context = McpContext {
            organization_id: None,
            project_id: None,
            issue_id: None,
            orchestrator_session_id: None,
            workspace_id: Uuid::new_v4(),
            workspace_branch: "main".to_string(),
            workspace_repos: vec![],
        };

        let serialized = serde_json::to_value(&context).expect("context should serialize");

        assert!(serialized.get("orchestrator_session_id").is_none());
    }
}
