use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const APPROVAL_TIMEOUT_SECONDS: i64 = 36000; // 10 hours

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ApprovalRequest {
    pub id: String,
    pub tool_name: String,
    pub execution_process_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
}

impl ApprovalRequest {
    pub fn new(tool_name: String, execution_process_id: Uuid) -> Self {
        Self::new_with_timeout(tool_name, execution_process_id, APPROVAL_TIMEOUT_SECONDS)
    }

    /// Like [`Self::new`] but with an explicit timeout (seconds). The headed
    /// bridge uses this to keep the store deadline aligned with the Claude
    /// `PreToolUse` hook timeout so a parked request never outlives the agent
    /// that is waiting on it.
    pub fn new_with_timeout(
        tool_name: String,
        execution_process_id: Uuid,
        timeout_seconds: i64,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            tool_name,
            execution_process_id,
            created_at: now,
            timeout_at: now + Duration::seconds(timeout_seconds),
        }
    }
}

/// What kind of interaction an approval represents — drives how the web UI / MCP
/// render and resolve it. Headless tool gating and headed (tmux) gating share
/// the same store, so this distinguishes a plain tool permission from an
/// `AskUserQuestion` questionnaire or an `ExitPlanMode` plan approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    /// A normal tool permission (approve/deny).
    #[default]
    Tool,
    /// An `AskUserQuestion` questionnaire (answered with selected options).
    Question,
    /// An `ExitPlanMode` plan approval (approve/deny, carries the plan text).
    PlanApproval,
}

impl ApprovalKind {
    pub fn is_question(self) -> bool {
        matches!(self, ApprovalKind::Question)
    }
}

/// One selectable option of an [`ApprovalQuestion`].
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalQuestionOption {
    pub label: String,
    #[ts(optional)]
    pub description: Option<String>,
}

/// A single question from an `AskUserQuestion` tool call, surfaced to the
/// operator so a headed questionnaire is answerable from the web UI / MCP.
/// Field names mirror Claude's `tool_input.questions[]` shape (`multiSelect`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalQuestion {
    pub question: String,
    #[ts(optional)]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<ApprovalQuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// Status of a tool permission request (approve/deny for tool execution).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied {
        #[ts(optional)]
        reason: Option<String>,
    },
    TimedOut,
}

/// A question–answer pair. `answer` holds one or more selected labels/values.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct QuestionAnswer {
    pub question: String,
    pub answer: Vec<String>,
}

/// Status of a question answer request.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum QuestionStatus {
    Answered { answers: Vec<QuestionAnswer> },
    TimedOut,
}

// Tracks both approval and question answers requests
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ApprovalOutcome {
    Approved,
    Denied {
        #[ts(optional)]
        reason: Option<String>,
    },
    Answered {
        answers: Vec<QuestionAnswer>,
    },
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ApprovalResponse {
    pub execution_process_id: Uuid,
    pub status: ApprovalOutcome,
}
