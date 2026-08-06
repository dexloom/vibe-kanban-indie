use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExportRequest {
    /// If empty, exports all projects.
    pub project_ids: Vec<Uuid>,
    pub include_attachments: bool,
}
