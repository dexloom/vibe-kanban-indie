use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::some_if_present;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Project {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub name: String,
    pub color: String,
    pub sort_order: i32,
    // F-N7: `parent_id` is `Option<Uuid>` but always populated by the
    // server (rows with no parent use `None`, which ts-rs renders as
    // `string | null`, NOT `undefined`). Marking it `#[ts(optional)]` would
    // generate `parent_id?: string | null` and contradict the wire
    // contract (`shared/remote-types.ts:7` has `parent_id: string | null`
    // required). Drop the marker so the response type matches the always-
    // present shape the server emits.
    pub parent_id: Option<Uuid>,
    // ADR-016: truthy-only on the wire. The body of the prompt is never
    // shipped on the list shape (keeps `GET /v1/projects`, the Electric
    // snapshot, and `sidebarProjects` lean). The dedicated
    // `GET /v1/projects/{id}/orchestrator-prompt` returns the raw text;
    // `resolve_orchestrator_prompt` returns the walked value with
    // provenance.
    pub has_orchestrator_prompt: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct CreateProjectRequest {
    /// Optional client-generated ID. If not provided, server generates one.
    /// Using client-generated IDs enables stable optimistic updates.
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub organization_id: Uuid,
    pub name: String,
    pub color: String,
    #[ts(optional)]
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateProjectRequest {
    #[serde(default, deserialize_with = "some_if_present")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub sort_order: Option<i32>,
    #[serde(default, deserialize_with = "some_if_present")]
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListProjectsQuery {
    pub organization_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListProjectsResponse {
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BulkUpdateProjectItem {
    pub id: Uuid,
    #[serde(flatten)]
    pub changes: UpdateProjectRequest,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BulkUpdateProjectsRequest {
    pub updates: Vec<BulkUpdateProjectItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BulkUpdateProjectsResponse {
    pub data: Vec<Project>,
    pub txid: i64,
}

// ADR-016 — per-project / per-board orchestrator prompt API surface.
// Dedicated GET/PUT/resolve endpoints so the wire list shape stays lean:
// the prompt body never ships on `GET /v1/projects`, the Electric
// snapshot, or `sidebarProjects`. The MCP tool and the editor pane hit
// the dedicated endpoints instead.

/// PUT body for `PUT /v1/projects/{id}/orchestrator-prompt`. REPLACE
/// semantics (no deep-merge — it's a flat string). Empty string clears.
#[derive(Debug, Clone, Deserialize, TS)]
pub struct UpdateOrchestratorPromptRequest {
    pub orchestrator_prompt: String,
}

/// Raw local value for a single project — what the editor edits.
#[derive(Debug, Clone, Serialize, TS)]
pub struct OrchestratorPromptResponse {
    pub project_id: Uuid,
    pub orchestrator_prompt: String,
}

/// Provenance of a resolved prompt. `Self` = the row we asked for;
/// `Ancestor` = an ancestor row supplied it; `Default` = no prompt at
/// any scope, use built-in behavior. Note the Rust variant name is
/// `Self_` because `Self` is a reserved keyword in Rust; serde renames
/// it to `self` on the wire so the JSON contract stays ergonomic.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum OrchestratorPromptSource {
    #[serde(rename = "self")]
    Self_,
    Ancestor,
    Default,
}

impl OrchestratorPromptSource {
    /// Wire name for this source — matches the serde `rename` so consumers
    /// (MCP tool, frontend) get the exact same string the JSON decoder would
    /// hand them. Exhaustive match so a future variant fails to compile
    /// instead of silently returning a stale wire name.
    pub fn as_str(&self) -> &'static str {
        match self {
            OrchestratorPromptSource::Self_ => "self",
            OrchestratorPromptSource::Ancestor => "ancestor",
            OrchestratorPromptSource::Default => "default",
        }
    }
}

/// Resolved prompt plus provenance. The MCP tool returns this exact
/// shape so the orchestrator plugin can branch on `source` without a
/// second round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ResolvedOrchestratorPromptResponse {
    pub project_id: Uuid,
    pub orchestrator_prompt: String,
    pub source_project_id: Option<Uuid>,
    pub source: OrchestratorPromptSource,
}
