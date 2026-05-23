//! Live list of a session's execution processes, reconstructed from the
//! `/execution-processes/stream/session/ws` stream.
//!
//! The backend emits patches against `/execution_processes/{id}` (Add/Replace/
//! Remove) plus an initial snapshot (`Replace /execution_processes {map}`). We
//! keep an owned document seeded as `{"execution_processes": {}}` and project it
//! into a list sorted by start time.

use json_patch::{Patch, PatchError};
use serde_json::Value;

use crate::api::types::ExecutionProcess;

pub struct ProcessList {
    doc: Value,
}

impl Default for ProcessList {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessList {
    pub fn new() -> Self {
        Self {
            doc: serde_json::json!({ "execution_processes": {} }),
        }
    }

    pub fn apply(&mut self, patch: &Patch) -> Result<(), PatchError> {
        super::apply_lenient(&mut self.doc, patch)
    }

    /// Processes sorted oldest → newest by `started_at`. Soft-deleted (dropped)
    /// processes are kept but flagged via `ExecutionProcess::dropped`.
    pub fn processes(&self) -> Vec<ExecutionProcess> {
        let Some(map) = self
            .doc
            .get("execution_processes")
            .and_then(Value::as_object)
        else {
            return Vec::new();
        };
        let mut list: Vec<ExecutionProcess> = map
            .values()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();
        list.sort_by_key(|p| p.started_at);
        list
    }
}
