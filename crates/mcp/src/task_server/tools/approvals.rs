//! MCP tools for responding to coding-agent approvals and stopping executions.
//!
//! These close the gap that previously forced the orchestrator to leave blocked
//! agents stuck: `respond_to_approval` unblocks an agent waiting on a tool
//! permission or a question, and `stop_execution` kills a runaway process. The
//! request body reuses the real `utils::approvals::ApprovalResponse` so the wire
//! format always matches the backend.

use chrono::{DateTime, Utc};
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use utils::approvals::{ApprovalOutcome, ApprovalResponse, QuestionAnswer};
use uuid::Uuid;

use super::{McpServer, ToolError};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListPendingApprovalsRequest {
    #[schemars(
        description = "Execution process id to list pending approvals for (the same id you'd poll with get_execution / pass to respond_to_approval)"
    )]
    execution_process_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct ListPendingApprovalsResponse {
    execution_process_id: String,
    /// Server time the ages were computed against (RFC3339).
    now: String,
    count: usize,
    /// Each pending approval (raw ApprovalInfo: approval_id, tool_name, kind,
    /// is_question, questions, plan_content, created_at, timeout_at, …) augmented
    /// with `age_seconds` (how long it has been waiting) and
    /// `seconds_until_timeout` (negative once expired).
    pending: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct QuestionAnswerInput {
    #[schemars(description = "The exact question text being answered")]
    question: String,
    #[schemars(description = "Selected option label(s) for this question")]
    answer: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RespondApprovalRequest {
    #[schemars(description = "Approval id from the escalation message")]
    approval_id: String,
    #[schemars(description = "Execution process id the approval belongs to")]
    execution_process_id: Uuid,
    #[schemars(
        description = "Decision: 'approve' or 'deny' for tool permissions, 'answer' for questions"
    )]
    decision: String,
    #[schemars(description = "Reason to include when decision = deny (optional)")]
    reason: Option<String>,
    #[schemars(description = "Answers when decision = answer (one per question)")]
    answers: Option<Vec<QuestionAnswerInput>>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct RespondApprovalResponse {
    success: bool,
    approval_id: String,
    #[schemars(description = "The resolved approval outcome echoed by the backend")]
    outcome: serde_json::Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct StopExecutionRequest {
    #[schemars(description = "Execution process id to stop")]
    execution_id: Uuid,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct StopExecutionResponse {
    success: bool,
    execution_id: String,
}

#[tool_router(router = approvals_tools_router, vis = "pub")]
impl McpServer {
    #[tool(
        description = "List the pending approvals (tool-permission prompts and question/plan questionnaires) an execution process is currently blocked on, each with how long it has been waiting. Use this to discover questions an agent raised and decide, by age, when to auto-answer a stale one (e.g. answer once `age_seconds` exceeds your grace window). Returns each pending approval's full detail (approval_id, kind, is_question, questions, plan_content, created_at, timeout_at) plus computed `age_seconds` and `seconds_until_timeout`."
    )]
    async fn list_pending_approvals(
        &self,
        Parameters(req): Parameters<ListPendingApprovalsRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!(
            "/api/approvals/pending/{}",
            req.execution_process_id
        ));
        let mut pending: Vec<serde_json::Value> = match self.send_json(self.client.get(&url)).await
        {
            Ok(value) => value,
            Err(error) => return Ok(Self::tool_error(error)),
        };

        // Compute ages here (MCP-side clock) so the agent never has to do
        // datetime math: it just compares `age_seconds` to its grace window.
        let now = Utc::now();
        let parse = |v: &serde_json::Value, key: &str| -> Option<DateTime<Utc>> {
            v.get(key)
                .and_then(|s| s.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc))
        };
        for item in pending.iter_mut() {
            let created = parse(item, "created_at");
            let timeout = parse(item, "timeout_at");
            if let Some(obj) = item.as_object_mut() {
                if let Some(created) = created {
                    obj.insert(
                        "age_seconds".to_string(),
                        serde_json::json!((now - created).num_seconds()),
                    );
                }
                if let Some(timeout) = timeout {
                    obj.insert(
                        "seconds_until_timeout".to_string(),
                        serde_json::json!((timeout - now).num_seconds()),
                    );
                }
            }
        }

        Self::success(&ListPendingApprovalsResponse {
            execution_process_id: req.execution_process_id.to_string(),
            now: now.to_rfc3339(),
            count: pending.len(),
            pending,
        })
    }

    #[tool(
        description = "Respond to a coding agent's pending approval to unblock it. Use decision='approve' or 'deny' for tool-permission approvals; use decision='answer' with `answers` for question approvals."
    )]
    async fn respond_to_approval(
        &self,
        Parameters(req): Parameters<RespondApprovalRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let status = match req.decision.trim().to_lowercase().as_str() {
            "approve" | "approved" => ApprovalOutcome::Approved,
            "deny" | "denied" => ApprovalOutcome::Denied { reason: req.reason },
            "answer" | "answered" => {
                let answers = req
                    .answers
                    .unwrap_or_default()
                    .into_iter()
                    .map(|a| QuestionAnswer {
                        question: a.question,
                        answer: a.answer,
                    })
                    .collect();
                ApprovalOutcome::Answered { answers }
            }
            other => {
                return Ok(Self::tool_error(ToolError::message(format!(
                    "invalid decision '{other}' (expected approve | deny | answer)"
                ))));
            }
        };

        let body = ApprovalResponse {
            execution_process_id: req.execution_process_id,
            status,
        };
        let url = self.url(&format!("/api/approvals/{}/respond", req.approval_id));
        let outcome: serde_json::Value =
            match self.send_json(self.client.post(&url).json(&body)).await {
                Ok(value) => value,
                Err(error) => return Ok(Self::tool_error(error)),
            };

        Self::success(&RespondApprovalResponse {
            success: true,
            approval_id: req.approval_id,
            outcome,
        })
    }

    #[tool(description = "Stop (kill) a running execution process.")]
    async fn stop_execution(
        &self,
        Parameters(req): Parameters<StopExecutionRequest>,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url(&format!(
            "/api/execution-processes/{}/stop",
            req.execution_id
        ));
        if let Err(error) = self.send_empty_json(self.client.post(&url)).await {
            return Ok(Self::tool_error(error));
        }
        Self::success(&StopExecutionResponse {
            success: true,
            execution_id: req.execution_id.to_string(),
        })
    }
}
