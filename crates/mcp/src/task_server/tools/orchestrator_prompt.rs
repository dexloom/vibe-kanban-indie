use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

/// Request shape for `get_orchestrator_prompt`. `project_id` is REQUIRED
/// — the orchestrator context has no implicit project id (it's a
/// global singleton that works any project), so the caller must always
/// supply the current card's project.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct McpGetOrchestratorPromptRequest {
    #[schemars(description = "The project to resolve the orchestrator prompt for. Required.")]
    project_id: Uuid,
}

/// Wire response shape — mirrors `api_types::ResolvedOrchestratorPromptResponse`.
/// `source` is one of `self`, `ancestor`, `default`. The orchestrator plugin
/// uses `source == "default"` to mean "no custom instruction — use built-in
/// behavior". Kept as a flat shape so the plugin can branch on the wire
/// without re-decoding.
#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpGetOrchestratorPromptResponse {
    project_id: Uuid,
    orchestrator_prompt: String,
    source_project_id: Option<Uuid>,
    source: String,
}

#[tool_router(router = orchestrator_prompt_tools_router, vis = "pub")]
impl McpServer {
    /// ADR-016: per-tick orchestrator prompt lookup. The orchestrator calls
    /// this at the start of every tick with the current card's project_id
    /// and uses the returned text as its instruction. Edits apply live (no
    /// cache) — the next tick reads the new value. Registered in
    /// `orchestrator_mode_router` ONLY; card-scoped agents must not read
    /// sibling prompts.
    ///
    /// Stack semantics (ADR-016 stack amendment): `orchestrator_prompt` is
    /// a STACK of every non-empty prompt in the parent chain, rendered as
    /// a mandatory-preamble + labeled `[Board: …]` / `[Project: …]`
    /// sections (board-level first, project-level last). The preamble
    /// tells the LLM how to apply the stack (specific overrides broad on
    /// direct conflict; otherwise additive; project-level is the
    /// baseline). The orchestrator plugin consumes only the
    /// `orchestrator_prompt` string — no plugin change needed for the
    /// stack.
    #[tool(
        description = "Resolve the orchestrator prompt for a project as a STACK of every non-empty prompt in the parent chain (board-level first, project-level last), with a mandatory preamble the orchestrator must follow. The orchestrator calls this every tick with the current card's project_id. `source` is 'self' (this row supplied the most-specific section), 'ancestor' (a parent did), or 'default' (no prompt at any scope — use built-in behavior)."
    )]
    async fn get_orchestrator_prompt(
        &self,
        Parameters(McpGetOrchestratorPromptRequest { project_id }): Parameters<
            McpGetOrchestratorPromptRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        // ADR-016: live under `/api/*` (envelope-wrapped). Both consumers —
        // this tool and the frontend editor — deserialize through
        // `ApiResponseEnvelope<T>`, so a route that returned the bare
        // `ResolvedOrchestratorPromptResponse` would fail with "missing
        // field `success`" at the MCP layer (the bug the integration test
        // `mcp_get_orchestrator_prompt_decodes_envelope` catches).
        let url = self.url(&format!(
            "/api/projects/{}/orchestrator-prompt/resolve",
            project_id
        ));
        let resp: api_types::ResolvedOrchestratorPromptResponse =
            match self.send_json(self.client.get(&url)).await {
                Ok(r) => r,
                Err(e) => return Ok(Self::tool_error(e)),
            };
        // `OrchestratorPromptSource` always maps to one of
        // `"self"` / `"ancestor"` / `"default"` (the `Self_` variant
        // carries `#[serde(rename = "self")]`). `as_str` is an exhaustive
        // match so a future enum change that breaks the rename fails at
        // compile time instead of silently degrading the orchestrator to
        // "default".
        let source = resp.source.as_str().to_string();
        McpServer::success(&McpGetOrchestratorPromptResponse {
            project_id: resp.project_id,
            orchestrator_prompt: resp.orchestrator_prompt,
            source_project_id: resp.source_project_id,
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    //! ADR-016: the orchestrator-prompt endpoint originally lived under
    //! `/v1/...` returning a bare `ResolvedOrchestratorPromptResponse` —
    //! `send_json` deserializes into `ApiResponseEnvelope<T>` and fails
    //! with "missing field `success`" the moment it sees the bare shape
    //! (the original P0 bug; the MCP tool is dead at runtime). The fix
    //! moves the route to `/api/...` with an envelope.
    //!
    //! These regression tests catch anyone moving the route back to
    //! `/v1/*` (or otherwise stripping the envelope). We test the wire
    //! boundary directly — `send_json` over a real HTTP round-trip —
    //! because that's exactly the failure surface a stripped envelope
    //! produces. We don't drive the rmcp tool router; its internals are
    //! a moving target, and the wire layer is what P0 actually broke.

    use axum::{Router, routing::get, serve};
    use rmcp::handler::server::tool::ToolRouter;
    use tokio::net::TcpListener;
    use uuid::Uuid;

    use super::McpServer;
    use crate::task_server::{McpContext, McpMode, McpRepoContext};

    /// Boot an axum server that always replies with the same body for any
    /// path (the orchestrator-prompt tool only hits one path, so we
    /// don't need real routing). Returns the bound URL.
    async fn spawn_mock_server(body: String) -> String {
        let router: Router = Router::new().route(
            "/{*path}",
            get(move || {
                let body = body.clone();
                async move { (axum::http::StatusCode::OK, body) }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            serve(listener, router).await.unwrap();
        });
        format!("http://{addr}")
    }

    /// Install the rustls crypto provider once — required for reqwest's
    /// rustls backend. Reuses the same `Once` flag as the sibling
    /// `tests` module in `tools/mod.rs` so we don't double-install
    /// (which returns an error from `install_default`). Calling
    /// `install_default` is idempotent across the process — the first
    /// test wins, subsequent ones silently no-op.
    fn install_rustls_provider() {
        crate::task_server::tools::tests::install_rustls_provider();
    }

    /// Helper: build an `McpServer` in orchestrator mode pointed at `url`.
    /// `init()` is not called — the regression only exercises
    /// `send_json`, which doesn't depend on workspace context.
    fn server_for(base_url: String) -> McpServer {
        McpServer {
            client: reqwest::Client::new(),
            base_url,
            tool_router: ToolRouter::default(),
            context: Some(McpContext {
                organization_id: None,
                project_id: None,
                issue_id: None,
                orchestrator_session_id: Some(Uuid::new_v4()),
                workspace_id: Uuid::new_v4(),
                workspace_branch: "main".to_string(),
                workspace_repos: vec![McpRepoContext {
                    repo_id: Uuid::new_v4(),
                    repo_name: "repo".to_string(),
                    target_branch: "main".to_string(),
                }],
            }),
            mode: McpMode::Orchestrator,
            headed_local_control: false,
        }
    }

    /// P0 regression: `send_json` must successfully decode the envelope
    /// the `/api/...` route returns. The previous `/v1/...` route
    /// returned the bare payload and `send_json` failed with "missing
    /// field `success`" at runtime — the test below locks the envelope
    /// contract in by reproducing the round-trip over a real socket.
    #[tokio::test]
    async fn mcp_get_orchestrator_prompt_decodes_envelope() {
        install_rustls_provider();

        let project_id = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        // Envelope-wrapped response — exactly what the `/api/...`
        // handler returns. The bare shape would make `send_json` fail
        // with "missing field `success`".
        let envelope = format!(
            r#"{{
                "success": true,
                "data": {{
                    "project_id": "{project_id}",
                    "orchestrator_prompt": "be terse",
                    "source_project_id": "{source_id}",
                    "source": "self"
                }},
                "message": null
            }}"#
        );
        let url = spawn_mock_server(envelope).await;
        let server = server_for(url);

        // Drive `send_json` exactly the way the tool does. If the
        // envelope wire format is ever broken, this fails with the
        // "missing field `success`" error string.
        let url = format!(
            "{}/api/projects/{}/orchestrator-prompt/resolve",
            server.base_url, project_id
        );
        let decoded: api_types::ResolvedOrchestratorPromptResponse = server
            .send_json(server.client.get(&url))
            .await
            .expect("send_json MUST decode the ApiResponse envelope");

        assert_eq!(decoded.project_id, project_id);
        assert_eq!(decoded.orchestrator_prompt, "be terse");
        assert_eq!(decoded.source_project_id, Some(source_id));
        // `Self_` is renamed to `"self"` on the wire — verify the round-trip.
        let source_str = serde_json::to_value(decoded.source)
            .expect("OrchestratorPromptSource serializes to a JSON string")
            .as_str()
            .expect("OrchestratorPromptSource renames to a non-null string")
            .to_string();
        assert_eq!(source_str, "self");
    }

    /// Negative case: a server returning the bare (envelope-stripped)
    /// shape MUST make `send_json` fail. This locks the contract from
    /// the OTHER side — anyone re-introducing the P0 bug (route under
    /// `/v1/*` returning a bare payload) would, by definition, violate
    /// this guarantee.
    #[tokio::test]
    async fn mcp_get_orchestrator_prompt_rejects_bare_shape() {
        install_rustls_provider();

        let project_id = Uuid::new_v4();
        // Bare `ResolvedOrchestratorPromptResponse` — exactly what the
        // pre-fix `/v1/...` handler returned.
        let bare = format!(
            r#"{{
                "project_id": "{project_id}",
                "orchestrator_prompt": "be terse",
                "source_project_id": null,
                "source": "default"
            }}"#
        );
        let url = spawn_mock_server(bare).await;
        let server = server_for(url);

        let result = server
            .send_json::<api_types::ResolvedOrchestratorPromptResponse>(server.client.get(format!(
                "{}/api/projects/{}/orchestrator-prompt/resolve",
                server.base_url, project_id
            )))
            .await;

        assert!(
            result.is_err(),
            "send_json MUST reject a bare payload (no `success` field) — \
             this is the exact P0 regression the envelope-fix protects against"
        );
    }
}
