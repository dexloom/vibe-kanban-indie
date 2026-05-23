//! MCP tools for responding to coding-agent approvals and stopping executions.
//!
//! These close the gap that previously forced the orchestrator to leave blocked
//! agents stuck: `respond_to_approval` unblocks an agent waiting on a tool
//! permission or a question, and `stop_execution` kills a runaway process. The
//! request body reuses the real `utils::approvals::ApprovalResponse` so the wire
//! format always matches the backend.

use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use utils::approvals::{ApprovalOutcome, ApprovalResponse, QuestionAnswer};
use uuid::Uuid;

use super::{McpServer, ToolError};

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
