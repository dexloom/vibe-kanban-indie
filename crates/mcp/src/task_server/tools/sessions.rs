use api_types::Issue;
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    session::Session,
};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateSessionRequest {
    #[schemars(
        description = "Workspace ID to create the session in. Optional when running inside a scoped orchestrator MCP."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(description = "Optional executor to pin this session to")]
    executor: Option<String>,
    #[schemars(description = "Optional display name for the session")]
    name: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateSessionPayload {
    workspace_id: Uuid,
    executor: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct SessionSummary {
    #[schemars(description = "Session ID")]
    id: String,
    #[schemars(description = "Workspace ID")]
    workspace_id: String,
    #[schemars(description = "Session display name (if set)")]
    name: Option<String>,
    #[schemars(description = "Session executor (if set)")]
    executor: Option<String>,
    #[schemars(description = "Creation timestamp")]
    created_at: String,
    #[schemars(description = "Last update timestamp")]
    updated_at: String,
    #[schemars(description = "True if this is the orchestrator session for this MCP server")]
    is_orchestrator_session: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct CreateSessionResponse {
    session: SessionSummary,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListSessionsRequest {
    #[schemars(
        description = "Workspace ID to inspect. Optional when running inside a scoped orchestrator MCP."
    )]
    workspace_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct ListSessionsResponse {
    #[schemars(description = "Workspace ID this result is scoped to")]
    workspace_id: String,
    total_count: usize,
    sessions: Vec<SessionSummary>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunCodingAgentInSessionRequest {
    #[schemars(description = "Session ID to run the coding agent in")]
    session_id: Uuid,
    #[schemars(description = "Prompt for the coding agent")]
    prompt: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunIssueInWorkspaceRequest {
    #[schemars(description = "Issue ID whose title + description are sent as the follow-up prompt")]
    issue_id: Uuid,
    #[schemars(
        description = "Workspace ID to run the issue in. Optional when running inside a scoped orchestrator MCP."
    )]
    workspace_id: Option<Uuid>,
    #[schemars(
        description = "Optional explicit session ID to run in. Defaults to the workspace's latest session."
    )]
    session_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct FollowUpPayload {
    prompt: String,
    executor_config: ExecutorConfigPayload,
    retry_process_id: Option<Uuid>,
    force_when_dirty: Option<bool>,
    perform_git_reset: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ExecutorConfigPayload {
    executor: String,
    variant: Option<String>,
    model_id: Option<String>,
    agent_id: Option<String>,
    reasoning_id: Option<String>,
    permission_policy: Option<String>,
}

/// Backend `POST /api/sessions/{id}/follow-up` response: the execution process
/// fields are flattened in, plus `delivered_to_live_session`.
#[derive(Debug, Deserialize)]
struct FollowUpResult {
    #[serde(flatten)]
    execution_process: ExecutionProcess,
    #[serde(default)]
    delivered_to_live_session: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct RunCodingAgentInSessionResponse {
    session_id: String,
    execution_id: String,
    execution: serde_json::Value,
    #[schemars(
        description = "True when the prompt was injected into an already-live Claude Code Headed tmux session (execution_id is that existing live execution, not a new one). False when a fresh execution was started."
    )]
    delivered_to_live_session: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateSessionRequest {
    #[schemars(description = "Session ID to update")]
    session_id: Uuid,
    #[schemars(description = "Set session display name (empty string clears it)")]
    name: Option<String>,
}

#[derive(Debug, Serialize)]
struct UpdateSessionPayload {
    name: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct UpdateSessionResponse {
    success: bool,
    session_id: String,
    name: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct GetExecutionRequest {
    #[schemars(description = "Execution ID to inspect")]
    execution_id: Uuid,
}

/// Mirror of the backend `AgentProgress` payload returned by
/// `GET /api/execution-processes/{id}/agent-progress`.
#[derive(Debug, Deserialize)]
struct AgentProgress {
    latest_message: Option<String>,
    claude_session_id: Option<String>,
    tmux_session_name: Option<String>,
    transcript_path: Option<String>,
}

/// One selectable option of a [`PendingApprovalQuestion`].
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct PendingApprovalOption {
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// A single question awaiting an answer (from an `AskUserQuestion` tool call).
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct PendingApprovalQuestion {
    question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    header: Option<String>,
    #[serde(default)]
    options: Vec<PendingApprovalOption>,
    #[serde(rename = "multiSelect", default)]
    multi_select: bool,
}

/// A pending approval blocking a (typically headed) execution — surfaced so an
/// orchestrator can see and answer questionnaires / plan approvals via
/// `respond_to_approval`. Mirror of the backend `ApprovalInfo`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
struct PendingApproval {
    approval_id: String,
    tool_name: String,
    /// "tool" | "question" | "plan_approval".
    kind: String,
    is_question: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_use_id: Option<String>,
    /// Present for `kind == "question"`: the questions to answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    questions: Option<Vec<PendingApprovalQuestion>>,
    /// Present for `kind == "plan_approval"`: the plan markdown to approve/deny.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plan_content: Option<String>,
    timeout_at: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct GetExecutionResponse {
    execution_id: String,
    session_id: String,
    status: String,
    is_finished: bool,
    execution: serde_json::Value,
    #[schemars(
        description = "Most recent assistant message from the agent (updates live as it works); null until the agent produces one"
    )]
    final_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Claude Code session id (`claude --session-id`). Only present for a Claude Code Headed execution when the headed-local-control capability is enabled."
    )]
    claude_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Deterministic tmux session name `vk-<execution_id>` you can reach with `tmux send-keys`. Only present for a Claude Code Headed execution when the headed-local-control capability is enabled."
    )]
    tmux_session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Absolute path to Claude's transcript JSONL for live tailing. Only present for a Claude Code Headed execution when the headed-local-control capability is enabled."
    )]
    claude_transcript_path: Option<String>,
    #[schemars(
        description = "Approvals currently blocking this execution (empty when none). A headed plan-mode agent blocks here on AskUserQuestion / ExitPlanMode; answer or approve/deny each via the respond_to_approval tool using its approval_id."
    )]
    pending_approvals: Vec<PendingApproval>,
}

#[tool_router(router = session_tools_router, vis = "pub")]
impl McpServer {
    #[tool(description = "Create a new session in a workspace.")]
    async fn create_session(
        &self,
        Parameters(CreateSessionRequest {
            workspace_id,
            executor,
            name,
        }): Parameters<CreateSessionRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let payload = CreateSessionPayload {
            workspace_id,
            executor: executor.and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }),
            name: name.and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }),
        };

        let url = self.url("/api/sessions");
        let session: Session = match self.send_json(self.client.post(&url).json(&payload)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        Self::success(&CreateSessionResponse {
            session: self.session_summary(session),
        })
    }

    #[tool(description = "List all sessions for a workspace.")]
    async fn list_sessions(
        &self,
        Parameters(ListSessionsRequest { workspace_id }): Parameters<ListSessionsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let url = self.url(&format!("/api/sessions?workspace_id={workspace_id}"));
        let sessions: Vec<Session> = match self.send_json(self.client.get(&url)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        let sessions = sessions
            .into_iter()
            .map(|session| self.session_summary(session))
            .collect::<Vec<_>>();

        Self::success(&ListSessionsResponse {
            workspace_id: workspace_id.to_string(),
            total_count: sessions.len(),
            sessions,
        })
    }

    #[tool(description = "Update a session's name. `session_id` is required.")]
    async fn update_session(
        &self,
        Parameters(UpdateSessionRequest { session_id, name }): Parameters<UpdateSessionRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        // Verify session exists and check scope
        let session_url = self.url(&format!("/api/sessions/{session_id}"));
        let session: Session = match self.send_json(self.client.get(&session_url)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(session.workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let payload = UpdateSessionPayload {
            name: name.map(|value| value.trim().to_string()),
        };
        let url = self.url(&format!("/api/sessions/{session_id}"));
        let updated: Session = match self.send_json(self.client.put(&url).json(&payload)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        Self::success(&UpdateSessionResponse {
            success: true,
            session_id: updated.id.to_string(),
            name: updated.name,
        })
    }

    #[tool(
        description = "Run a coding agent turn in an existing session and return immediately with the execution process. For a Claude Code Headed session that already has a live interactive terminal, the prompt is injected into that running session (its TUI / conversation) instead of starting a second agent; `delivered_to_live_session` is true and `execution_id` is the existing live execution. Otherwise a fresh execution is started."
    )]
    async fn run_session_prompt(
        &self,
        Parameters(RunCodingAgentInSessionRequest { session_id, prompt }): Parameters<
            RunCodingAgentInSessionRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Self::err("prompt must not be empty", None);
        }

        let session_url = self.url(&format!("/api/sessions/{session_id}"));
        let session: Session = match self.send_json(self.client.get(&session_url)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(session.workspace_id) {
            return Ok(Self::tool_error(error_result));
        }
        if self.orchestrator_session_id() == Some(session_id) {
            return Self::err(
                "Cannot run coding agent in the orchestrator session".to_string(),
                Some(
                    "Create or re-use a different session and run the coding agent there."
                        .to_string(),
                ),
            );
        }

        let executor_config = match Self::executor_config_payload_for_session(&session) {
            Ok(config) => config,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        let payload = FollowUpPayload {
            prompt: prompt.to_string(),
            executor_config,
            retry_process_id: None,
            force_when_dirty: None,
            perform_git_reset: None,
        };

        let url = self.url(&format!("/api/sessions/{session_id}/follow-up"));
        let result: FollowUpResult =
            match self.send_json(self.client.post(&url).json(&payload)).await {
                Ok(value) => value,
                Err(error_result) => return Ok(Self::tool_error(error_result)),
            };

        let execution_id = result.execution_process.id.to_string();
        let execution = match Self::serialize_execution_process(&result.execution_process) {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        Self::success(&RunCodingAgentInSessionResponse {
            session_id: session_id.to_string(),
            execution_id,
            execution,
            delivered_to_live_session: result.delivered_to_live_session,
        })
    }

    #[tool(
        description = "Run an issue in an existing workspace: sends the issue's title + description to the workspace's session as a follow-up prompt (context retained) and returns the execution process immediately. Uses the workspace's latest session unless `session_id` is given."
    )]
    async fn run_issue_in_workspace(
        &self,
        Parameters(RunIssueInWorkspaceRequest {
            issue_id,
            workspace_id,
            session_id,
        }): Parameters<RunIssueInWorkspaceRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let workspace_id = match self.resolve_workspace_id(workspace_id) {
            Ok(id) => id,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        // Build the prompt from the issue (mirrors the UI's workspace-create prompt).
        let issue_url = self.url(&format!("/api/issues/{issue_id}"));
        let issue: Issue = match self.send_json(self.client.get(&issue_url)).await {
            Ok(issue) => issue,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        let trimmed_title = issue.title.trim();
        if trimmed_title.is_empty() {
            return Self::err(
                "issue has no title; cannot build a prompt".to_string(),
                Some("Update the issue with a title first.".to_string()),
            );
        }
        let prompt = match issue.description.as_deref().map(str::trim) {
            Some(description) if !description.is_empty() => {
                format!("{trimmed_title}\n\n{description}")
            }
            _ => trimmed_title.to_string(),
        };

        // Resolve the session: explicit one, or the workspace's latest.
        let session_id = match session_id {
            Some(id) => id,
            None => {
                let list_url = self.url(&format!("/api/sessions?workspace_id={workspace_id}"));
                let sessions: Vec<Session> = match self.send_json(self.client.get(&list_url)).await
                {
                    Ok(sessions) => sessions,
                    Err(error_result) => return Ok(Self::tool_error(error_result)),
                };
                match sessions.into_iter().max_by_key(|session| session.created_at) {
                    Some(session) => session.id,
                    None => {
                        return Self::err(
                            format!("workspace {workspace_id} has no sessions"),
                            Some("Create a session in the workspace first.".to_string()),
                        );
                    }
                }
            }
        };

        let session_url = self.url(&format!("/api/sessions/{session_id}"));
        let session: Session = match self.send_json(self.client.get(&session_url)).await {
            Ok(session) => session,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if session.workspace_id != workspace_id {
            return Self::err(
                format!(
                    "session {} does not belong to workspace {workspace_id}",
                    session.id
                ),
                None,
            );
        }
        if self.orchestrator_session_id() == Some(session_id) {
            return Self::err(
                "Cannot run coding agent in the orchestrator session".to_string(),
                Some("Create or re-use a different session and run the coding agent there."
                    .to_string()),
            );
        }

        let executor_config = match Self::executor_config_payload_for_session(&session) {
            Ok(config) => config,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        let payload = FollowUpPayload {
            prompt,
            executor_config,
            retry_process_id: None,
            force_when_dirty: None,
            perform_git_reset: None,
        };

        let url = self.url(&format!("/api/sessions/{session_id}/follow-up"));
        let result: FollowUpResult = match self.send_json(self.client.post(&url).json(&payload)).await
        {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        let execution_id = result.execution_process.id.to_string();
        let execution = match Self::serialize_execution_process(&result.execution_process) {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        Self::success(&RunCodingAgentInSessionResponse {
            session_id: session_id.to_string(),
            execution_id,
            execution,
            delivered_to_live_session: result.delivered_to_live_session,
        })
    }

    #[tool(description = "Get status for an execution.")]
    async fn get_execution(
        &self,
        Parameters(GetExecutionRequest { execution_id }): Parameters<GetExecutionRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let process_url = self.url(&format!("/api/execution-processes/{execution_id}"));
        let execution_process: ExecutionProcess =
            match self.send_json(self.client.get(&process_url)).await {
                Ok(value) => value,
                Err(error_result) => return Ok(Self::tool_error(error_result)),
            };

        let session_url = self.url(&format!("/api/sessions/{}", execution_process.session_id));
        let session: Session = match self.send_json(self.client.get(&session_url)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };
        if let Err(error_result) = self.scope_allows_workspace(session.workspace_id) {
            return Ok(Self::tool_error(error_result));
        }

        let is_finished = execution_process.status != ExecutionProcessStatus::Running;

        // Slim: head-truncate long `prompt` strings so this poll-heavy tool
        // stops echoing the full coding-agent prompt on every call. See
        // `slim_execution_process` / `redact_prompts`.
        let execution_process_value = match Self::slim_execution_process(&execution_process) {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        // Latest assistant message (Option A) + headed identifiers (Option B).
        // The backend always resolves both; the B-side identifiers are surfaced
        // only when the headed-local-control capability is enabled.
        let progress_url = self.url(&format!(
            "/api/execution-processes/{execution_id}/agent-progress"
        ));
        let progress: AgentProgress = match self.send_json(self.client.get(&progress_url)).await {
            Ok(value) => value,
            Err(error_result) => return Ok(Self::tool_error(error_result)),
        };

        let expose_headed = self.headed_local_control();

        // Pending approvals (question / plan / tool) blocking this execution.
        // Portable status, so surfaced regardless of headed-local-control — the
        // orchestrator answers them via `respond_to_approval`.
        let pending_url = self.url(&format!("/api/approvals/pending/{execution_id}"));
        let pending_approvals: Vec<PendingApproval> =
            match self.send_json(self.client.get(&pending_url)).await {
                Ok(value) => value,
                Err(error_result) => return Ok(Self::tool_error(error_result)),
            };

        Self::success(&GetExecutionResponse {
            execution_id: execution_process.id.to_string(),
            session_id: execution_process.session_id.to_string(),
            status: Self::execution_process_status_label(&execution_process.status).to_string(),
            is_finished,
            execution: execution_process_value,
            final_message: progress.latest_message,
            claude_session_id: expose_headed
                .then_some(progress.claude_session_id)
                .flatten(),
            tmux_session_name: expose_headed
                .then_some(progress.tmux_session_name)
                .flatten(),
            claude_transcript_path: expose_headed.then_some(progress.transcript_path).flatten(),
            pending_approvals,
        })
    }
}

/// Longest a `"prompt"` string is allowed to be in a [`slim_execution_process`]
/// result before it is head-truncated. See `redact_prompts`.
const MAX_PROMPT_HEAD_CHARS: usize = 200;

/// Recursively walk `value`, replacing every long `"prompt"` string (at any
/// object key named `prompt`, at any depth — including inside the recursive
/// `next_action` chain and inside arrays) with a truncated head. Every other
/// key, including `updated_at` and the rest of the `ExecutionProcess`
/// scalars, is left completely untouched by construction: this function only
/// ever rewrites values it explicitly matches.
///
/// Pure and DB-free: no I/O, no dependency on the typed `ExecutorAction`
/// shape, so it also handles `ExecutorActionField::Other` (untagged legacy
/// JSON) and any future prompt-bearing variant uniformly.
fn redact_prompts(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if key == "prompt"
                    && let serde_json::Value::String(s) = val
                    && s.chars().count() > MAX_PROMPT_HEAD_CHARS
                {
                    *s = truncate_prompt(s);
                } else {
                    redact_prompts(val);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                redact_prompts(item);
            }
        }
        _ => {}
    }
}

/// Char-boundary-safe head truncation. Prompts routinely contain multi-byte
/// characters (CJK, emoji), so this takes `chars()`, never a byte slice —
/// `&s[..MAX_PROMPT_HEAD_CHARS]` would panic on a non-char-boundary index.
/// The caller (`redact_prompts`) only invokes this once it has already
/// confirmed the string is over the char threshold, so the result always
/// carries the truncation marker.
fn truncate_prompt(s: &str) -> String {
    let total_chars = s.chars().count();
    let head: String = s.chars().take(MAX_PROMPT_HEAD_CHARS).collect();
    format!("{head}… [truncated: {total_chars} chars total]")
}

impl McpServer {
    fn executor_config_payload_for_session(
        session: &Session,
    ) -> Result<ExecutorConfigPayload, super::ToolError> {
        Ok(ExecutorConfigPayload {
            executor: Self::normalize_executor_name(session.executor.as_deref())?,
            variant: None,
            model_id: None,
            agent_id: None,
            reasoning_id: None,
            permission_policy: None,
        })
    }

    fn session_summary(&self, session: Session) -> SessionSummary {
        let is_orchestrator_session = self.orchestrator_session_id() == Some(session.id);
        SessionSummary {
            id: session.id.to_string(),
            workspace_id: session.workspace_id.to_string(),
            name: session.name,
            executor: session.executor,
            created_at: session.created_at.to_rfc3339(),
            updated_at: session.updated_at.to_rfc3339(),
            is_orchestrator_session,
        }
    }

    fn serialize_execution_process(
        execution_process: &ExecutionProcess,
    ) -> Result<serde_json::Value, super::ToolError> {
        serde_json::to_value(execution_process).map_err(|error| {
            super::ToolError::new(
                "Failed to serialize execution process response",
                Some(error.to_string()),
            )
        })
    }

    /// Like `serialize_execution_process`, but head-truncates every long
    /// `"prompt"` string in the result (at any depth of the `next_action`
    /// chain) so `get_execution` stops echoing the full coding-agent prompt on
    /// every status poll. Used by `get_execution` only — `run_session_prompt`
    /// keeps calling the full `serialize_execution_process`.
    fn slim_execution_process(
        execution_process: &ExecutionProcess,
    ) -> Result<serde_json::Value, super::ToolError> {
        let mut value = Self::serialize_execution_process(execution_process)?;
        redact_prompts(&mut value);
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::iter;

    use serde_json::json;
    use uuid::Uuid;

    use super::*;

    /// Builds a fixture prompt: `head_len` copies of `head_char` followed by
    /// `tail_len` copies of `tail_char`. Using two distinct characters (rather
    /// than one repeated character) lets a test assert both "the truncated
    /// head survives" and "no part of the tail survives" without the two
    /// checks being indistinguishable from each other.
    fn fixture_prompt(
        head_char: char,
        head_len: usize,
        tail_char: char,
        tail_len: usize,
    ) -> String {
        iter::repeat_n(head_char, head_len)
            .chain(iter::repeat_n(tail_char, tail_len))
            .collect()
    }

    /// The expected truncated head for a prompt built from `fixture_prompt`
    /// with `head_char` as its first `MAX_PROMPT_HEAD_CHARS` characters.
    fn head_run(head_char: char) -> String {
        iter::repeat_n(head_char, MAX_PROMPT_HEAD_CHARS).collect()
    }

    /// Builds a real `ExecutionProcess` by deserializing a JSON fixture (the
    /// cheap path recommended by the plan): `sqlx::types::Json<T>` is
    /// transparent and `ExecutorActionField` is `#[serde(untagged)]`, so a
    /// plain `ExecutorAction`-shaped JSON object deserializes straight
    /// through.
    fn execution_process_fixture(prompt: &str) -> ExecutionProcess {
        serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "session_id": Uuid::new_v4(),
            "run_reason": "codingagent",
            "executor_action": {
                "typ": {
                    "type": "CodingAgentInitialRequest",
                    "prompt": prompt,
                    "executor_config": {"executor": "CLAUDE_CODE"},
                },
                "next_action": null
            },
            "status": "running",
            "exit_code": null,
            "dropped": false,
            "started_at": "2026-01-01T00:00:00Z",
            "completed_at": null,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T03:04:05Z"
        }))
        .expect("fixture JSON should deserialize into ExecutionProcess")
    }

    // --- Step 3: pure `Value -> Value` redactor tests ---

    #[test]
    fn top_level_prompt_is_truncated() {
        let prompt = fixture_prompt('A', MAX_PROMPT_HEAD_CHARS, 'B', 2800); // 3000 chars total
        let mut value = json!({
            "typ": {
                "type": "CodingAgentInitialRequest",
                "prompt": prompt,
                "executor_config": {"executor": "CLAUDE_CODE"},
            },
            "next_action": null
        });

        redact_prompts(&mut value);

        let result = value["typ"]["prompt"].as_str().unwrap();
        assert!(result.starts_with(&head_run('A')));
        assert!(result.len() < prompt.len());
        assert!(result.contains("truncated"));
        assert!(result.contains("3000"));
        // The tail must not survive anywhere in the result.
        assert!(!result.contains(&"B".repeat(50)));
    }

    #[test]
    fn nested_next_action_prompts_are_truncated() {
        // The load-bearing test: a depth-0-only fix compiles and passes a
        // naive test, but leaves `next_action`'s nested prompts untouched.
        let p0 = fixture_prompt('A', MAX_PROMPT_HEAD_CHARS, 'X', 2800);
        let p1 = fixture_prompt('B', MAX_PROMPT_HEAD_CHARS, 'Y', 2800);
        let p2 = fixture_prompt('C', MAX_PROMPT_HEAD_CHARS, 'Z', 2800);

        let mut value = json!({
            "typ": {"type": "CodingAgentInitialRequest", "prompt": p0},
            "next_action": {
                "typ": {"type": "CodingAgentFollowUpRequest", "prompt": p1},
                "next_action": {
                    "typ": {"type": "CodingAgentFollowUpRequest", "prompt": p2},
                    "next_action": null
                }
            }
        });

        redact_prompts(&mut value);

        let r0 = value["typ"]["prompt"].as_str().unwrap();
        let r1 = value["next_action"]["typ"]["prompt"].as_str().unwrap();
        let r2 = value["next_action"]["next_action"]["typ"]["prompt"]
            .as_str()
            .unwrap();

        assert!(r0.starts_with(&head_run('A')) && r0.contains("truncated"));
        assert!(r1.starts_with(&head_run('B')) && r1.contains("truncated"));
        assert!(r2.starts_with(&head_run('C')) && r2.contains("truncated"));

        assert!(!r0.contains(&"X".repeat(50)));
        assert!(!r1.contains(&"Y".repeat(50)));
        assert!(!r2.contains(&"Z".repeat(50)));

        // Distinguishable results, so a mis-assert (e.g. comparing r0 against
        // r0 twice by accident) can't pass silently.
        assert_ne!(r0, r1);
        assert_ne!(r1, r2);
        assert_ne!(r0, r2);
    }

    #[test]
    fn no_prompt_body_survives_anywhere() {
        let needle: String = "Q".repeat(2500);
        let prompt = format!("{}{needle}", "P".repeat(MAX_PROMPT_HEAD_CHARS));
        let mut value = json!({
            "typ": {"type": "CodingAgentInitialRequest", "prompt": prompt},
            "next_action": null
        });

        redact_prompts(&mut value);

        let serialized = serde_json::to_string(&value).unwrap();
        assert_eq!(serialized.matches(&needle).count(), 0);
    }

    #[test]
    fn non_prompt_keys_are_untouched() {
        let prompt = fixture_prompt('A', MAX_PROMPT_HEAD_CHARS, 'B', 2800);
        let mut value = json!({
            "typ": {
                "type": "CodingAgentInitialRequest",
                "prompt": prompt,
                "executor_config": {"executor": "CLAUDE_CODE", "variant": null},
                "working_dir": "sub/dir",
                "session_id": "11111111-1111-1111-1111-111111111111",
                "interactive": {
                    "session_uuid": "22222222-2222-2222-2222-222222222222",
                    "terminal": "NONE",
                },
            },
            "next_action": null
        });
        let original = value.clone();

        redact_prompts(&mut value);

        assert_eq!(
            value["typ"]["executor_config"],
            original["typ"]["executor_config"]
        );
        assert_eq!(value["typ"]["working_dir"], original["typ"]["working_dir"]);
        assert_eq!(value["typ"]["session_id"], original["typ"]["session_id"]);
        assert_eq!(value["typ"]["interactive"], original["typ"]["interactive"]);
    }

    #[test]
    fn short_prompt_is_byte_identical() {
        let prompt = "a".repeat(50);
        let mut value = json!({
            "typ": {"type": "CodingAgentInitialRequest", "prompt": prompt},
        });

        redact_prompts(&mut value);

        let result = value["typ"]["prompt"].as_str().unwrap();
        assert_eq!(result, prompt);
        assert!(!result.contains("truncated"));
    }

    #[test]
    fn multibyte_prompt_does_not_panic() {
        // CJK: 3-byte-per-char in UTF-8. `&s[..200]` would panic here because
        // byte offset 200 does not land on a char boundary.
        let cjk_prompt: String = "日".repeat(3000);
        let mut cjk_value = json!({
            "typ": {"type": "CodingAgentInitialRequest", "prompt": cjk_prompt.clone()},
        });
        redact_prompts(&mut cjk_value); // must not panic
        let cjk_result = cjk_value["typ"]["prompt"].as_str().unwrap();
        let cjk_head: String = cjk_result.chars().take(MAX_PROMPT_HEAD_CHARS).collect();
        assert_eq!(cjk_head.chars().count(), MAX_PROMPT_HEAD_CHARS);
        assert_eq!(
            cjk_head,
            cjk_prompt
                .chars()
                .take(MAX_PROMPT_HEAD_CHARS)
                .collect::<String>()
        );

        // Emoji: 4-byte-per-char in UTF-8 — a different failure offset than
        // CJK, so it exercises a distinct byte-slicing bug class.
        let emoji_prompt: String = "🚀".repeat(3000);
        let mut emoji_value = json!({
            "typ": {"type": "CodingAgentInitialRequest", "prompt": emoji_prompt.clone()},
        });
        redact_prompts(&mut emoji_value); // must not panic
        let emoji_result = emoji_value["typ"]["prompt"].as_str().unwrap();
        let emoji_head: String = emoji_result.chars().take(MAX_PROMPT_HEAD_CHARS).collect();
        assert_eq!(emoji_head.chars().count(), MAX_PROMPT_HEAD_CHARS);
        assert_eq!(
            emoji_head,
            emoji_prompt
                .chars()
                .take(MAX_PROMPT_HEAD_CHARS)
                .collect::<String>()
        );
    }

    #[test]
    fn legacy_other_json_with_array_nested_prompt_is_truncated() {
        // `ExecutorActionField::Other` arm: arbitrary JSON, not a valid
        // `ExecutorAction`, with a prompt nested inside an array element.
        let prompt = fixture_prompt('A', MAX_PROMPT_HEAD_CHARS, 'B', 2800);
        let mut value = json!({
            "legacy": true,
            "steps": [
                {"prompt": prompt},
                {"note": "keep"}
            ]
        });

        redact_prompts(&mut value);

        let result = value["steps"][0]["prompt"].as_str().unwrap();
        assert!(result.starts_with(&head_run('A')));
        assert!(result.contains("truncated"));
        assert_eq!(value["legacy"], json!(true));
        assert_eq!(value["steps"][1]["note"], json!("keep"));
    }

    // --- Step 4: `ExecutionProcess` / response-level tests ---

    #[test]
    fn slim_execution_process_preserves_scalars() {
        let prompt = fixture_prompt('A', MAX_PROMPT_HEAD_CHARS, 'B', 2300); // ~2.5KB
        let process = execution_process_fixture(&prompt);

        let full = McpServer::serialize_execution_process(&process).unwrap();
        let slim = McpServer::slim_execution_process(&process).unwrap();

        for key in [
            "id",
            "session_id",
            "run_reason",
            "status",
            "exit_code",
            "dropped",
            "started_at",
            "completed_at",
            "created_at",
            "updated_at",
        ] {
            assert_eq!(
                full[key], slim[key],
                "field `{key}` changed between full and slim"
            );
        }
        // `updated_at` matters most (nudge-stuck's progress fingerprint) —
        // assert it explicitly by name so a regression names itself.
        assert_eq!(full["updated_at"], slim["updated_at"]);
    }

    #[test]
    fn slim_execution_process_is_substantially_smaller() {
        let prompt = fixture_prompt('A', MAX_PROMPT_HEAD_CHARS, 'B', 2300); // ~2.5KB
        let process = execution_process_fixture(&prompt);

        let full = McpServer::serialize_execution_process(&process).unwrap();
        let slim = McpServer::slim_execution_process(&process).unwrap();

        let full_len = serde_json::to_string(&full).unwrap().len();
        let slim_len = serde_json::to_string(&slim).unwrap().len();

        assert!(
            full_len.saturating_sub(slim_len) >= 2_000,
            "expected slim to be at least 2000 bytes smaller: full={full_len} slim={slim_len}"
        );
    }

    #[test]
    fn run_session_prompt_serializer_keeps_full_prompt() {
        // Pins the scope boundary: `run_session_prompt` keeps calling the
        // full serializer, so its payload is unaffected by this card.
        let needle: String = "Q".repeat(2500);
        let prompt = format!("{}{needle}", "P".repeat(MAX_PROMPT_HEAD_CHARS));
        let process = execution_process_fixture(&prompt);

        let full = McpServer::serialize_execution_process(&process).unwrap();
        let serialized = serde_json::to_string(&full).unwrap();

        assert!(serialized.contains(&needle));
    }

    #[test]
    fn get_execution_response_shape_is_intact() {
        let pending_approval = PendingApproval {
            approval_id: "approval-1".to_string(),
            tool_name: "AskUserQuestion".to_string(),
            kind: "question".to_string(),
            is_question: true,
            tool_use_id: Some("tool-use-1".to_string()),
            questions: Some(vec![PendingApprovalQuestion {
                question: "Proceed?".to_string(),
                header: None,
                options: vec![PendingApprovalOption {
                    label: "Yes".to_string(),
                    description: None,
                }],
                multi_select: false,
            }]),
            plan_content: None,
            timeout_at: "2026-01-01T00:05:00Z".to_string(),
        };

        let headed = GetExecutionResponse {
            execution_id: "exec-1".to_string(),
            session_id: "session-1".to_string(),
            status: "running".to_string(),
            is_finished: false,
            execution: json!({"id": "exec-1"}),
            final_message: Some("hello".to_string()),
            claude_session_id: Some("claude-session".to_string()),
            tmux_session_name: Some("vk-exec-1".to_string()),
            claude_transcript_path: Some("/tmp/transcript.jsonl".to_string()),
            pending_approvals: vec![pending_approval],
        };

        let value = serde_json::to_value(&headed).unwrap();
        let obj = value.as_object().unwrap();
        for key in [
            "execution_id",
            "session_id",
            "status",
            "is_finished",
            "execution",
            "final_message",
            "pending_approvals",
            "claude_session_id",
            "tmux_session_name",
            "claude_transcript_path",
        ] {
            assert!(obj.contains_key(key), "missing key `{key}`");
        }

        // Headed handles are `skip_serializing_if = "Option::is_none"` — pin
        // that gating stays in place when they are absent.
        let unheaded = GetExecutionResponse {
            execution_id: "exec-1".to_string(),
            session_id: "session-1".to_string(),
            status: "running".to_string(),
            is_finished: false,
            execution: json!({"id": "exec-1"}),
            final_message: None,
            claude_session_id: None,
            tmux_session_name: None,
            claude_transcript_path: None,
            pending_approvals: vec![],
        };
        let value = serde_json::to_value(&unheaded).unwrap();
        let obj = value.as_object().unwrap();
        for key in [
            "claude_session_id",
            "tmux_session_name",
            "claude_transcript_path",
        ] {
            assert!(
                !obj.contains_key(key),
                "key `{key}` should be absent when None"
            );
        }
    }
}
