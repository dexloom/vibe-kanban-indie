//! Parse the backend's `/api/approvals/stream/ws` patches into approval events
//! and format Telegram escalation messages.

use chrono::{DateTime, Utc};
use json_patch::{Patch, PatchOperation};
use serde::Deserialize;
use uuid::Uuid;

/// Mirror of `services::services::approvals::ApprovalInfo`.
#[derive(Debug, Clone, Deserialize)]
pub struct ApprovalInfo {
    pub approval_id: String,
    pub tool_name: String,
    pub execution_process_id: Uuid,
    pub is_question: bool,
    /// Parsed for fidelity; not currently displayed.
    #[allow(dead_code)]
    pub created_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
}

/// A change derived from an approvals-stream patch.
#[derive(Debug)]
pub enum ApprovalEvent {
    /// Initial snapshot of all currently-pending approvals.
    Snapshot(Vec<ApprovalInfo>),
    Created(ApprovalInfo),
    Resolved(String),
}

/// Translate one RFC6902 patch (from the approvals stream) into events.
pub fn parse_patch(patch: &Patch) -> Vec<ApprovalEvent> {
    let mut out = Vec::new();
    for op in &patch.0 {
        match op {
            PatchOperation::Replace(r) => handle_set(r.path.as_str(), &r.value, &mut out),
            PatchOperation::Add(a) => handle_set(a.path.as_str(), &a.value, &mut out),
            PatchOperation::Remove(rm) => {
                if let Some(id) = approval_id_from_path(rm.path.as_str()) {
                    out.push(ApprovalEvent::Resolved(id));
                }
            }
            _ => {}
        }
    }
    out
}

fn handle_set(path: &str, value: &serde_json::Value, out: &mut Vec<ApprovalEvent>) {
    if path == "/pending" {
        // Snapshot: the whole pending map.
        if let Some(map) = value.as_object() {
            let infos = map
                .values()
                .filter_map(|v| serde_json::from_value::<ApprovalInfo>(v.clone()).ok())
                .collect();
            out.push(ApprovalEvent::Snapshot(infos));
        }
    } else if approval_id_from_path(path).is_some()
        && let Ok(info) = serde_json::from_value::<ApprovalInfo>(value.clone())
    {
        out.push(ApprovalEvent::Created(info));
    }
}

/// Extract the approval id from a `/pending/{id}` pointer (un-escaping `~1`/`~0`).
fn approval_id_from_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/pending/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest.replace("~1", "/").replace("~0", "~"))
}

/// Format an escalation message. The trailing `‹vk …›` line is machine-readable
/// so the PM agent can extract the ids and call `respond_to_approval`.
pub fn format_escalation(info: &ApprovalInfo) -> String {
    let kind = if info.is_question {
        "question"
    } else {
        "approval"
    };
    let how = if info.is_question {
        "answer it: respond_to_approval(decision=\"answer\", answers=[…])"
    } else {
        "decide: respond_to_approval(decision=\"approve\" | \"deny\")"
    };
    format!(
        "🔔 Agent needs attention\n\
         tool: {tool}{q}\n\
         exec: {exec}\n\
         deadline: {deadline}\n\
         {how}\n\
         ‹vk approval_id={id} exec={exec} kind={kind}›",
        tool = info.tool_name,
        q = if info.is_question { " (question)" } else { "" },
        exec = info.execution_process_id,
        deadline = info.timeout_at.to_rfc3339(),
        how = how,
        id = info.approval_id,
        kind = kind,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn info_json(id: &str, is_question: bool) -> serde_json::Value {
        json!({
            "approval_id": id,
            "tool_name": "Bash",
            "execution_process_id": "00000000-0000-0000-0000-0000000000ee",
            "is_question": is_question,
            "created_at": "2026-05-23T03:00:00Z",
            "timeout_at": "2026-05-23T13:00:00Z",
        })
    }

    #[test]
    fn parses_created_and_resolved() {
        let created: Patch = serde_json::from_value(json!([
            {"op": "replace", "path": "/pending/a1", "value": info_json("a1", false)}
        ]))
        .unwrap();
        let events = parse_patch(&created);
        assert!(matches!(events.as_slice(), [ApprovalEvent::Created(i)] if i.approval_id == "a1"));

        let resolved: Patch =
            serde_json::from_value(json!([{"op": "remove", "path": "/pending/a1"}])).unwrap();
        let events = parse_patch(&resolved);
        assert!(matches!(events.as_slice(), [ApprovalEvent::Resolved(id)] if id == "a1"));
    }

    #[test]
    fn parses_snapshot() {
        let snap: Patch = serde_json::from_value(json!([
            {"op": "replace", "path": "/pending", "value": {"a1": info_json("a1", true)}}
        ]))
        .unwrap();
        match parse_patch(&snap).as_slice() {
            [ApprovalEvent::Snapshot(v)] => {
                assert_eq!(v.len(), 1);
                assert!(v[0].is_question);
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
    }

    #[test]
    fn escalation_contains_machine_footer() {
        let info: ApprovalInfo = serde_json::from_value(info_json("xyz", false)).unwrap();
        let msg = format_escalation(&info);
        assert!(msg.contains("‹vk approval_id=xyz"));
        assert!(msg.contains("kind=approval"));
        assert!(msg.contains("exec=00000000-0000-0000-0000-0000000000ee"));
    }
}
