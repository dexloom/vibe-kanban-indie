//! Live conversation transcript, reconstructed from the normalized-logs WS.
//!
//! The backend streams RFC6902 patches that target `/entries/{index}`, where the
//! value is a `PatchType` envelope (`{"type": "...", "content": ...}`). We keep
//! an owned JSON document seeded as `{"entries": {}}` (an *object* keyed by the
//! integer index, so adds/replaces/removes are order- and gap-tolerant) and
//! project it into display lines on demand.
//!
//! The projection reads the JSON structurally rather than via fully-typed mirror
//! enums: the backend's `NormalizedEntryType`/`ActionType`/`ToolStatus` trees are
//! large and evolving, and a display transcript should degrade gracefully on
//! unknown variants rather than fail to parse. The exact field names mirror
//! `crates/executors/src/logs`.

use json_patch::{Patch, PatchError};
use serde_json::Value;

/// One question to answer, extracted from an `AskUserQuestion` tool call.
#[derive(Debug, Clone)]
pub struct QuestionItem {
    pub question: String,
    pub header: String,
    pub options: Vec<String>,
    /// Parsed for contract fidelity; the picker is single-select for now.
    #[allow(dead_code)]
    pub multi_select: bool,
}

/// Status badge derived from `ToolStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolBadge {
    Created,
    Success,
    Failed,
    Denied,
    PendingApproval,
    TimedOut,
    Unknown,
}

/// A single render-ready transcript line.
#[derive(Debug, Clone)]
pub enum Line {
    User(String),
    Assistant(String),
    Thinking(String),
    System(String),
    Error(String),
    Tool {
        name: String,
        badge: ToolBadge,
        summary: String,
        /// Set when the tool is blocked on an approval (`ToolStatus::PendingApproval`);
        /// consumed by the approvals inbox (T-M3).
        #[allow(dead_code)]
        approval_id: Option<String>,
    },
    Stdout(String),
    Stderr(String),
    Diff(String),
    Other(String),
}

/// Accumulates normalized-log patches into a projectable transcript.
pub struct Conversation {
    doc: Value,
}

impl Default for Conversation {
    fn default() -> Self {
        Self::new()
    }
}

impl Conversation {
    pub fn new() -> Self {
        Self {
            doc: serde_json::json!({ "entries": {} }),
        }
    }

    /// Apply a normalized-logs RFC6902 patch (lenient: see `state::apply_lenient`).
    pub fn apply(&mut self, patch: &Patch) -> Result<(), PatchError> {
        super::apply_lenient(&mut self.doc, patch)
    }

    /// Project the current document into ordered display lines.
    pub fn lines(&self) -> Vec<Line> {
        let Some(entries) = self.doc.get("entries").and_then(Value::as_object) else {
            return Vec::new();
        };
        let mut keyed: Vec<(u64, &Value)> = entries
            .iter()
            .filter_map(|(k, v)| k.parse::<u64>().ok().map(|n| (n, v)))
            .collect();
        keyed.sort_by_key(|(n, _)| *n);
        keyed
            .into_iter()
            .filter_map(|(_, v)| project_patch_type(v))
            .collect()
    }

    /// Extract the `AskUserQuestion` items for the tool entry blocked on
    /// `approval_id`, if present in the transcript.
    pub fn find_questions(&self, approval_id: &str) -> Option<Vec<QuestionItem>> {
        let entries = self.doc.get("entries").and_then(Value::as_object)?;
        for v in entries.values() {
            if v.get("type").and_then(Value::as_str) != Some("NORMALIZED_ENTRY") {
                continue;
            }
            let et = match v.get("content").and_then(|c| c.get("entry_type")) {
                Some(et) => et,
                None => continue,
            };
            if et.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let status = et.get("status");
            let matches_id = status.and_then(|s| s.get("status")).and_then(Value::as_str)
                == Some("pending_approval")
                && status
                    .and_then(|s| s.get("approval_id"))
                    .and_then(Value::as_str)
                    == Some(approval_id);
            if !matches_id {
                continue;
            }
            let action = et.get("action_type")?;
            if action.get("action").and_then(Value::as_str) != Some("ask_user_question") {
                continue;
            }
            let questions = action.get("questions").and_then(Value::as_array)?;
            return Some(questions.iter().map(parse_question).collect());
        }
        None
    }

    /// Approval ids for tool entries currently blocked on approval — used to
    /// join the transcript with the approvals stream (consumed by T-M3).
    #[allow(dead_code)]
    pub fn pending_approval_ids(&self) -> Vec<String> {
        self.lines()
            .into_iter()
            .filter_map(|l| match l {
                Line::Tool {
                    approval_id: Some(id),
                    ..
                } => Some(id),
                _ => None,
            })
            .collect()
    }
}

/// Project a stored `PatchType` envelope (`{"type", "content"}`).
fn project_patch_type(v: &Value) -> Option<Line> {
    let ty = v.get("type")?.as_str()?;
    match ty {
        "NORMALIZED_ENTRY" => project_normalized(v.get("content")?),
        "STDOUT" => Some(Line::Stdout(string_content(v))),
        "STDERR" => Some(Line::Stderr(string_content(v))),
        "DIFF" => Some(Line::Diff(summarize_diff(v.get("content")))),
        _ => None,
    }
}

fn string_content(v: &Value) -> String {
    v.get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Project a `NormalizedEntry` (`{timestamp, entry_type, content, metadata}`).
fn project_normalized(entry: &Value) -> Option<Line> {
    let text = entry
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let et = entry.get("entry_type")?;
    let kind = et.get("type")?.as_str()?;

    let line = match kind {
        "user_message" | "user_feedback" => Line::User(text),
        "assistant_message" => Line::Assistant(text),
        "thinking" => Line::Thinking(text),
        "system_message" => Line::System(text),
        "error_message" => Line::Error(text),
        "loading" => Line::System(if text.is_empty() { "…".into() } else { text }),
        "user_answered_questions" => Line::System(if text.is_empty() {
            "answered question".into()
        } else {
            text
        }),
        // Bookkeeping entries that add no transcript value.
        "next_action" | "token_usage_info" => return None,
        "tool_use" => {
            let name = et
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let (badge, approval_id) = project_status(et.get("status"));
            let summary = project_action(et.get("action_type"), &text);
            Line::Tool {
                name,
                badge,
                summary,
                approval_id,
            }
        }
        _ => Line::Other(if text.is_empty() {
            kind.to_string()
        } else {
            text
        }),
    };
    Some(line)
}

/// Map `ToolStatus` (`{"status": "...", ...}`) to a badge + optional approval id.
fn project_status(status: Option<&Value>) -> (ToolBadge, Option<String>) {
    let Some(s) = status else {
        return (ToolBadge::Unknown, None);
    };
    match s.get("status").and_then(Value::as_str) {
        Some("created") => (ToolBadge::Created, None),
        Some("success") => (ToolBadge::Success, None),
        Some("failed") => (ToolBadge::Failed, None),
        Some("denied") => (ToolBadge::Denied, None),
        Some("timed_out") => (ToolBadge::TimedOut, None),
        Some("pending_approval") => (
            ToolBadge::PendingApproval,
            s.get("approval_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        _ => (ToolBadge::Unknown, None),
    }
}

/// Summarize `ActionType` (`{"action": "...", ...}`) into a one-line preview.
fn project_action(action: Option<&Value>, fallback: &str) -> String {
    let Some(a) = action else {
        return fallback.to_string();
    };
    let pick = |key: &str| a.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    match a.get("action").and_then(Value::as_str) {
        Some("command_run") => pick("command"),
        Some("file_read") | Some("file_edit") => pick("path"),
        Some("search") => pick("query"),
        Some("web_fetch") => pick("url"),
        Some("plan_presentation") => "plan".to_string(),
        Some("ask_user_question") => {
            let n = a
                .get("questions")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            format!("{n} question(s)")
        }
        Some("other") => pick("description"),
        _ => fallback.to_string(),
    }
}

/// Parse one `AskUserQuestionItem` JSON object into a `QuestionItem`.
fn parse_question(q: &Value) -> QuestionItem {
    let options = q
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|o| o.get("label").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    QuestionItem {
        question: q
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        header: q
            .get("header")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        options,
        // serde renames the Rust field `multi_select` to `multiSelect`.
        multi_select: q
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn summarize_diff(content: Option<&Value>) -> String {
    content
        .and_then(|c| {
            c.get("path")
                .or_else(|| c.get("file_name"))
                .and_then(Value::as_str)
        })
        .map(|p| format!("diff: {p}"))
        .unwrap_or_else(|| "diff".to_string())
}
