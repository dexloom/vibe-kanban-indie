use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::Type;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS, JsonSchema)]
#[sqlx(type_name = "issue_relationship_type", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum IssueRelationshipType {
    Blocking,
    Related,
    HasDuplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IssueRelationship {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub related_issue_id: Uuid,
    pub relationship_type: IssueRelationshipType,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateIssueRelationshipRequest {
    /// Optional client-generated ID. If not provided, server generates one.
    /// Using client-generated IDs enables stable optimistic updates.
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub issue_id: Uuid,
    pub related_issue_id: Uuid,
    pub relationship_type: IssueRelationshipType,
}

/// Scope for `GET /api/issue-relationships`. Exactly one field must be set.
///
/// - `issue_id` — the original contract: that issue's OUTGOING rows only
///   (`WHERE issue_id = ?`).
/// - `project_id` — the project's whole edge set in one call, so a caller
///   gating on `blocking` edges pays one request per board sweep instead of
///   one per card.
#[derive(Debug, Clone, Deserialize)]
pub struct ListIssueRelationshipsQuery {
    #[serde(default)]
    pub issue_id: Option<Uuid>,
    #[serde(default)]
    pub project_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListIssueRelationshipsResponse {
    pub issue_relationships: Vec<IssueRelationship>,
}
