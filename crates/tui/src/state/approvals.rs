//! Pending-approval inbox, reconstructed from `/api/approvals/stream/ws`.
//!
//! The backend emits an initial snapshot (`Replace /pending {map}`) followed by
//! `Replace /pending/{approval_id}` (created) and `Remove /pending/{approval_id}`
//! (resolved) patches. We keep an owned document seeded as `{"pending": {}}` and
//! project it into a list sorted by creation time — this is the set of agents
//! currently blocked waiting for a decision.

use json_patch::{Patch, PatchError};
use serde_json::Value;

use crate::api::types::ApprovalInfo;

pub struct ApprovalInbox {
    doc: Value,
}

impl Default for ApprovalInbox {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalInbox {
    pub fn new() -> Self {
        Self {
            doc: serde_json::json!({ "pending": {} }),
        }
    }

    pub fn apply(&mut self, patch: &Patch) -> Result<(), PatchError> {
        super::apply_lenient(&mut self.doc, patch)
    }

    /// Pending approvals, oldest first.
    pub fn approvals(&self) -> Vec<ApprovalInfo> {
        let Some(map) = self.doc.get("pending").and_then(Value::as_object) else {
            return Vec::new();
        };
        let mut list: Vec<ApprovalInfo> = map
            .values()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        list.sort_by_key(|a| a.created_at);
        list
    }

    pub fn len(&self) -> usize {
        self.doc
            .get("pending")
            .and_then(Value::as_object)
            .map(serde_json::Map::len)
            .unwrap_or(0)
    }
}
