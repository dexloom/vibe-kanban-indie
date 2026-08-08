use std::str::FromStr;

use api_types::{Issue, ListProjectStatusesResponse, ProjectStatus};
use db::models::{execution_process::ExecutionProcessStatus, tag::Tag};
use executors::executors::BaseCodingAgent;
use regex::Regex;
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
mod issue_relationships;
mod issue_tags;
mod issues;
mod orchestrator_prompt;
mod projects;
mod repos;
mod sessions;
mod task_attempts;
mod workspaces;

impl McpServer {
    pub fn global_mode_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        Self::context_tools_router()
            + Self::workspaces_tools_router()
            + Self::repos_tools_router()
            // The card surface every board-driving agent depends on
            // (orchestrator, intake, product). Deleted alongside the cloud
            // stack in e41e2c16 and restored here: the tools were always
            // local-REST-backed, only their module names said "remote".
            // `global_mode_exposes_the_full_card_surface` pins the set.
            + Self::projects_tools_router()
            + Self::issues_tools_router()
            + Self::issue_tags_tools_router()
            + Self::issue_relationships_tools_router()
            + Self::task_attempts_tools_router()
            + Self::session_tools_router()
            + Self::approvals_tools_router()
            // ADR-016 (reachability amendment): per-tick orchestrator prompt
            // lookup. Every real client — including the sombra_plugins
            // orchestrator, whose `.mcp.json` passes no `--mode` — connects
            // in global mode, so the prompt tool must live here to be
            // reachable. Prompts are owner-authored text in a local,
            // auth-less DB (already exposed via the REST resolve endpoint);
            // mode was never a confidentiality boundary.
            + Self::orchestrator_prompt_tools_router()
    }

    pub fn orchestrator_mode_router() -> rmcp::handler::server::tool::ToolRouter<Self> {
        let mut router = Self::context_tools_router()
            + Self::workspaces_tools_router()
            + Self::session_tools_router()
            // Orchestrators need to answer questions / approve plans (and stop
            // runaway executions) for the headed agents they drive.
            + Self::approvals_tools_router()
            // ADR-016: per-tick orchestrator prompt lookup. Kept here as well
            // so orchestrator mode stays coherent if a client is ever
            // launched with `--mode orchestrator`; the reachable surface is
            // the global router above.
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

    // Expands @tagname references in text by replacing them with tag content.
    async fn expand_tags(&self, text: &str) -> String {
        let tag_pattern = match Regex::new(r"@([^\s@]+)") {
            Ok(re) => re,
            Err(_) => return text.to_string(),
        };

        let tag_names: Vec<String> = tag_pattern
            .captures_iter(text)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        if tag_names.is_empty() {
            return text.to_string();
        }

        let url = self.url("/api/tags");
        let tags: Vec<Tag> = match self.client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<ApiResponseEnvelope<Vec<Tag>>>().await {
                    Ok(envelope) if envelope.success => envelope.data.unwrap_or_default(),
                    _ => return text.to_string(),
                }
            }
            _ => return text.to_string(),
        };

        let tag_map: std::collections::HashMap<&str, &str> = tags
            .iter()
            .map(|t| (t.tag_name.as_str(), t.content.as_str()))
            .collect();

        let result = tag_pattern.replace_all(text, |caps: &regex::Captures| {
            let tag_name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            match tag_map.get(tag_name) {
                Some(content) => (*content).to_string(),
                None => caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string(),
            }
        });

        result.into_owned()
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

    // Fetches project statuses for a project.
    async fn fetch_project_statuses(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<ProjectStatus>, ToolError> {
        let url = self.url(&format!("/api/project-statuses?project_id={}", project_id));
        let response: ListProjectStatusesResponse = self.send_json(self.client.get(&url)).await?;
        Ok(response.project_statuses)
    }

    /// Pure: resolve a status NAME to its id against an already-fetched status list.
    ///
    /// Case-insensitive. The error message is read VERBATIM by the orchestrator prompt
    /// ("use one of those exact names"), so its wording must not drift. See VIBE-2 / SPEC §4.2.
    fn status_id_from_name(
        statuses: &[ProjectStatus],
        status_name: &str,
    ) -> Result<Uuid, ToolError> {
        statuses
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(status_name))
            .map(|s| s.id)
            .ok_or_else(|| {
                let available: Vec<&str> = statuses.iter().map(|s| s.name.as_str()).collect();
                ToolError::message(format!(
                    "Unknown status '{}'. Available statuses: {:?}",
                    status_name, available
                ))
            })
    }

    /// Pure: resolve a status id to its display name against an already-fetched status list.
    /// Falls back to the UUID string when the id is not in the list — the same fallback this
    /// crate has always had.
    fn status_name_from_id(statuses: &[ProjectStatus], status_id: Uuid) -> String {
        statuses
            .iter()
            .find(|s| s.id == status_id)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| status_id.to_string())
    }

    // Gets the default status_id for a project (first non-hidden status by sort_order).
    async fn default_status_id(&self, project_id: Uuid) -> Result<Uuid, ToolError> {
        let statuses = self.fetch_project_statuses(project_id).await?;
        statuses
            .iter()
            .filter(|s| !s.hidden)
            .min_by_key(|s| s.sort_order)
            .map(|s| s.id)
            .ok_or_else(|| ToolError::message("No visible statuses found for project"))
    }

    // Resolves a status_id to its display name. Falls back to UUID string if lookup fails.
    async fn resolve_status_name(&self, project_id: Uuid, status_id: Uuid) -> String {
        match self.fetch_project_statuses(project_id).await {
            Ok(statuses) => Self::status_name_from_id(&statuses, status_id),
            Err(_) => status_id.to_string(),
        }
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

    use super::{McpServer, ProjectStatus};
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

    /// Global mode is the ONLY mode the plugin connects with (`.mcp.json` passes
    /// no `--mode`), so this exact-set assertion is the release gate for the
    /// whole agent-facing tool surface.
    ///
    /// ⚠️ Why an exact set and not a bag of `contains` checks: `e41e2c16` deleted
    /// the issue + project tools as collateral of the cloud-stack removal and
    /// nothing failed — every board-driving agent (orchestrator, intake,
    /// product) silently lost its entire card surface. A router-level `+` that
    /// disappears in a refactor now fails HERE, at `cargo test`, instead of at
    /// an operator's first tick against a fresh npm release.
    ///
    /// Adding a tool is a deliberate act: extend this set in the same commit.
    #[test]
    fn global_mode_exposes_the_full_card_surface() {
        let actual = tool_names(McpServer::global_mode_router());
        let expected = BTreeSet::from([
            "add_issue_tag".to_string(),
            "create_issue".to_string(),
            "create_issue_relationship".to_string(),
            "create_session".to_string(),
            "delete_issue".to_string(),
            "delete_issue_relationship".to_string(),
            "delete_workspace".to_string(),
            "get_context".to_string(),
            "get_execution".to_string(),
            // ADR-016 reachability amendment: the per-tick prompt read is in
            // the global router (the mode the orchestrator connects with), so
            // one session can both read board prompts and sweep.
            "get_orchestrator_prompt".to_string(),
            "get_issue".to_string(),
            "get_repo".to_string(),
            "link_workspace_issue".to_string(),
            "list_issue_priorities".to_string(),
            "list_issue_tags".to_string(),
            "list_issues".to_string(),
            "list_pending_approvals".to_string(),
            "list_projects".to_string(),
            "list_repos".to_string(),
            "list_sessions".to_string(),
            "list_tags".to_string(),
            "list_workspaces".to_string(),
            "remove_issue_tag".to_string(),
            "respond_to_approval".to_string(),
            "run_issue_in_workspace".to_string(),
            "run_session_prompt".to_string(),
            "start_workspace".to_string(),
            "stop_execution".to_string(),
            "update_cleanup_script".to_string(),
            "update_dev_server_script".to_string(),
            "update_issue".to_string(),
            "update_session".to_string(),
            "update_setup_script".to_string(),
            "update_workspace".to_string(),
        ]);

        assert_eq!(actual, expected);
    }

    /// The seven tools the board-driving agents' allowlists name by hand. Named
    /// individually (on top of the exact-set assertion above) so a failure says
    /// WHICH card tool went missing, not just "the set changed".
    #[test]
    fn global_mode_keeps_every_tool_the_board_agents_allowlist() {
        let actual = tool_names(McpServer::global_mode_router());

        for tool in [
            "list_issues",
            "get_issue",
            "create_issue",
            "update_issue",
            "delete_issue",
            "list_issue_priorities",
            "list_projects",
        ] {
            assert!(
                actual.contains(tool),
                "`{tool}` MUST stay in the global_mode router - the plugin's agent \
                 allowlists name it exactly, and without it every board-driving \
                 agent loses part of its card surface"
            );
        }
    }

    /// ADR-016 reachability amendment: `get_orchestrator_prompt` must be
    /// exposed by the GLOBAL router — the mode the orchestrator plugin
    /// actually connects with (`.mcp.json` passes no `--mode`) — so one MCP
    /// session can both read board prompts and drive a full sweep
    /// (`list_workspaces`, `start_workspace`, the card surface). Asserting
    /// the POSITIVE here catches a regression where someone re-restricts
    /// the tool to the unreachable orchestrator-only router.
    #[test]
    fn orchestrator_prompt_tool_is_reachable_in_global_mode() {
        let orch = tool_names(McpServer::orchestrator_mode_router());
        let global = tool_names(McpServer::global_mode_router());

        assert!(orch.contains("get_orchestrator_prompt"));
        assert!(
            global.contains("get_orchestrator_prompt"),
            "get_orchestrator_prompt MUST be in the global_mode router — \
             the orchestrator plugin connects with no --mode flag"
        );
        // One session, full sweep: prompt read + workspace discovery +
        // dispatch must coexist in the same router.
        assert!(global.contains("list_workspaces"));
        assert!(global.contains("start_workspace"));
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

    fn status_fixture(id: Uuid, name: &str) -> ProjectStatus {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "project_id": "11111111-1111-1111-1111-111111111111",
            "name": name,
            "color": "#000000",
            "sort_order": 0,
            "hidden": false,
            "created_at": "2026-01-01T00:00:00Z"
        }))
        .expect("fixture JSON should deserialize into ProjectStatus")
    }

    #[test]
    fn status_id_from_name_matches_case_insensitively() {
        let in_progress = Uuid::new_v4();
        let statuses = [
            status_fixture(Uuid::new_v4(), "Todo"),
            status_fixture(in_progress, "In Progress"),
        ];

        assert_eq!(
            McpServer::status_id_from_name(&statuses, "in progress").unwrap(),
            in_progress
        );
        // Round-trips to the board's CANONICAL casing — this is why `update_issue` reports the
        // resolved name rather than echoing what the caller typed.
        assert_eq!(
            McpServer::status_name_from_id(&statuses, in_progress),
            "In Progress"
        );
    }

    #[test]
    fn status_id_from_name_error_text_is_unchanged() {
        // The orchestrator prompt reads this string VERBATIM. Byte-for-byte pin.
        let statuses = [
            status_fixture(Uuid::new_v4(), "Todo"),
            status_fixture(Uuid::new_v4(), "In Progress"),
        ];

        let err = McpServer::status_id_from_name(&statuses, "Shipped").unwrap_err();
        assert_eq!(
            err.to_string(),
            "Unknown status 'Shipped'. Available statuses: [\"Todo\", \"In Progress\"]"
        );

        // An unknown id falls back to the UUID string rather than erroring.
        let missing = Uuid::new_v4();
        assert_eq!(
            McpServer::status_name_from_id(&statuses, missing),
            missing.to_string()
        );
    }
}
