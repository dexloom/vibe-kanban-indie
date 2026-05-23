//! Event-sourced view models built by applying RFC6902 patches from the backend
//! WS streams to a local JSON document, then projecting that document into
//! render-friendly shapes.

pub mod approvals;
pub mod conversation;
pub mod processes;

use json_patch::{AddOperation, Patch, PatchError, PatchOperation};
use serde_json::Value;

/// Apply a patch leniently: `Replace` ops are rewritten as `Add` (which inserts
/// a missing object member and replaces an existing one), matching the
/// frontend's JSON-patch semantics. The backend emits `Replace /pending/{id}`
/// for *newly created* approvals, which strict RFC6902 `replace` would reject
/// because the member does not yet exist.
pub(crate) fn apply_lenient(doc: &mut Value, patch: &Patch) -> Result<(), PatchError> {
    let ops = patch
        .0
        .iter()
        .map(|op| match op {
            PatchOperation::Replace(r) => PatchOperation::Add(AddOperation {
                path: r.path.clone(),
                value: r.value.clone(),
            }),
            other => other.clone(),
        })
        .collect();
    json_patch::patch(doc, &Patch(ops))
}
