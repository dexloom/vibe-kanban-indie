//! Detects `VK-PIPELINE-STAGE: <n>` markers emitted by a card's execution
//! agent as it begins each numbered `## Pipeline` stage, and persists the
//! most recently reported stage onto the owning workspace
//! (`workspaces.current_pipeline_stage`).
//!
//! Headless (child stdout) and headed (Claude transcript tail) executions
//! both funnel their raw output into the same per-execution `MsgStore` as
//! `LogMsg::Stdout` (see `crates/local-deployment/src/container.rs:993` and
//! `:1931`), so a single regex scan over that shared stream detects the
//! marker identically in both modes with no per-executor knowledge.

use std::{
    collections::HashSet,
    sync::{Arc, LazyLock, Mutex},
};

use db::{DBService, models::workspace::Workspace};
use futures::StreamExt;
use regex::Regex;
use utils::msg_store::MsgStore;
use uuid::Uuid;

/// Case-insensitive; the value must be a bare integer (so the literal `<n>`
/// placeholder in the authored instruction text never matches). Boundary
/// safety (rejecting the token when fused into a longer identifier) is
/// applied separately in `has_valid_boundary`, not via regex `\b` — see its
/// doc comment for why.
static MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)VK-PIPELINE-STAGE:\s*(\d+)").expect("valid regex"));

/// Idempotency guard keyed by execution_process_id. The normal execution
/// start path and headed restart re-adoption are separate call sites that
/// both need a tracker on their (fresh) `MsgStore`; this ensures a given
/// execution never gets two trackers running concurrently.
static TRACKED_EXECUTIONS: LazyLock<Mutex<HashSet<Uuid>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Parse the *last* valid `VK-PIPELINE-STAGE: <n>` marker in a line, if any.
/// Stream order is top-to-bottom stage progression, so within a single line
/// (e.g. an agent quoting the instruction followed by the real marker) the
/// last occurrence wins.
pub fn parse_pipeline_stage_marker(line: &str) -> Option<i64> {
    MARKER_RE
        .captures_iter(line)
        .filter(|caps| has_valid_boundary(line, caps.get(0).expect("group 0 always set").start()))
        .last()
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse::<i64>().ok())
}

/// True when `start` (a byte offset into `line`) is a safe place for the
/// marker token to begin: start-of-string, preceded by a non-alphanumeric
/// character, or preceded by a JSON-*escaped* control character (a literal
/// `\n` / `\r` / `\t` — backslash followed by the letter, two raw ASCII
/// characters, not yet JSON-decoded).
///
/// A plain regex `\b` word-boundary is not enough here: raw (not-yet-decoded)
/// transcript/stdout text represents the newline that normally precedes the
/// agent's own marker line as the two literal characters `\` `n`, and `n` is
/// a word character — so `\b` would spuriously reject the single most common
/// real case (a headed transcript line whose marker follows `"...\nVK-PIPELINE-STAGE: 3\n..."`).
/// This still rejects the false-positive this guards against (the marker
/// fused onto the end of an unrelated identifier, e.g. `FOOVK-PIPELINE-STAGE: 1`).
fn has_valid_boundary(line: &str, start: usize) -> bool {
    let prefix = &line[..start];
    let mut chars = prefix.chars().rev();
    let Some(prev) = chars.next() else {
        return true; // start of string
    };
    if !prev.is_alphanumeric() && prev != '_' {
        return true;
    }
    matches!(prev, 'n' | 'r' | 't') && chars.next() == Some('\\')
}

/// Spawn a task that watches an execution's raw log stream for
/// `VK-PIPELINE-STAGE: N` markers and persists the most recent value onto
/// `workspace_id`. Writes are debounced (only on change) to avoid redundant
/// UPDATEs when an agent re-emits the same marker.
///
/// The underlying `MsgStore::stdout_lines_stream()` assembles complete lines
/// from chunked `LogMsg::Stdout` bytes (via `LinesCodec`), so a marker split
/// across two chunks is still detected, and internally stops at
/// `LogMsg::Finished` — so this task cannot leak holding `Arc<MsgStore>`
/// once the execution completes.
///
/// No-op (idempotent) if a tracker for `execution_process_id` is already
/// running.
pub fn spawn_pipeline_stage_tracker(
    store: Arc<MsgStore>,
    workspace_id: Uuid,
    execution_process_id: Uuid,
    db: DBService,
) {
    {
        let mut tracked = TRACKED_EXECUTIONS.lock().unwrap();
        if !tracked.insert(execution_process_id) {
            return;
        }
    }

    tokio::spawn(async move {
        let mut lines = store.stdout_lines_stream();
        let mut last_stage: Option<i64> = None;

        while let Some(line) = lines.next().await {
            let Ok(line) = line else { continue };
            if let Some(stage) = parse_pipeline_stage_marker(&line)
                && last_stage != Some(stage)
            {
                last_stage = Some(stage);
                if let Err(e) =
                    Workspace::set_current_pipeline_stage(&db.pool, workspace_id, Some(stage)).await
                {
                    tracing::warn!(
                        "Failed to persist pipeline stage {stage} for workspace {workspace_id}: {e}"
                    );
                }
            }
        }

        TRACKED_EXECUTIONS
            .lock()
            .unwrap()
            .remove(&execution_process_id);
    });
}

#[cfg(test)]
mod tests {
    use utils::log_msg::LogMsg;

    use super::*;

    #[test]
    fn parses_digit_marker() {
        assert_eq!(parse_pipeline_stage_marker("VK-PIPELINE-STAGE: 3"), Some(3));
    }

    #[test]
    fn parses_case_insensitive_and_extra_whitespace() {
        assert_eq!(
            parse_pipeline_stage_marker("vk-pipeline-stage:   7"),
            Some(7)
        );
    }

    #[test]
    fn no_match_returns_none() {
        assert_eq!(parse_pipeline_stage_marker("nothing to see here"), None);
    }

    #[test]
    fn embedded_in_json_substring_matches() {
        // A transcript line is itself a JSON-encoded string; the newlines in
        // the agent's text are escaped (`\n`, two literal characters) rather
        // than actual line breaks, so the marker still lands within one raw
        // `LogMsg::Stdout` line.
        let json_line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Starting stage.\nVK-PIPELINE-STAGE: 2\n"}]}}"#;
        assert_eq!(parse_pipeline_stage_marker(json_line), Some(2));
    }

    #[test]
    fn placeholder_token_does_not_match() {
        assert_eq!(
            parse_pipeline_stage_marker(
                "output a single line exactly `VK-PIPELINE-STAGE: <n>` so progress can be tracked"
            ),
            None
        );
    }

    #[test]
    fn word_boundary_rejects_suffixed_token() {
        assert_eq!(parse_pipeline_stage_marker("FOOVK-PIPELINE-STAGE: 1"), None);
    }

    #[test]
    fn returns_last_valid_marker_in_line() {
        assert_eq!(
            parse_pipeline_stage_marker("VK-PIPELINE-STAGE: 1 ... VK-PIPELINE-STAGE: 2"),
            Some(2)
        );
    }

    #[tokio::test]
    async fn tracker_advances_stage_and_ends_on_finished() {
        let pool = test_pool().await;
        let workspace_id = create_workspace(&pool).await;
        let db = DBService { pool: pool.clone() };

        let store = Arc::new(MsgStore::new());
        spawn_pipeline_stage_tracker(store.clone(), workspace_id, Uuid::new_v4(), db);

        store.push(LogMsg::Stdout("VK-PIPELINE-STAGE: 1\n".to_string()));
        wait_for_stage(&pool, workspace_id, Some(1)).await;

        store.push(LogMsg::Stdout("VK-PIPELINE-STAGE: 2\n".to_string()));
        wait_for_stage(&pool, workspace_id, Some(2)).await;

        // Split a marker across two Stdout chunks — must still be detected.
        store.push(LogMsg::Stdout("VK-PIPELINE-STAGE".to_string()));
        store.push(LogMsg::Stdout(": 3\n".to_string()));
        wait_for_stage(&pool, workspace_id, Some(3)).await;

        store.push(LogMsg::Finished);

        // The task must terminate promptly after Finished (no leaked Arc<MsgStore>).
        for _ in 0..50 {
            if Arc::strong_count(&store) == 1 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("pipeline stage tracker did not release its MsgStore handle after Finished");
    }

    #[tokio::test]
    async fn plain_stdout_headless_variant_detected() {
        let pool = test_pool().await;
        let workspace_id = create_workspace(&pool).await;
        let db = DBService { pool: pool.clone() };

        let store = Arc::new(MsgStore::new());
        spawn_pipeline_stage_tracker(store.clone(), workspace_id, Uuid::new_v4(), db);

        store.push(LogMsg::Stdout(
            "Running stage 1 of pipeline\nVK-PIPELINE-STAGE: 1\n".to_string(),
        ));
        wait_for_stage(&pool, workspace_id, Some(1)).await;
        store.push(LogMsg::Finished);
    }

    // -- test helpers -----------------------------------------------------

    async fn test_pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    async fn create_workspace(pool: &sqlx::SqlitePool) -> Uuid {
        use db::models::workspace::CreateWorkspace;

        let ws = Workspace::create(
            pool,
            &CreateWorkspace {
                branch: "vk/pipeline-stage-test".to_string(),
                name: Some("pipeline-stage-test".to_string()),
                kind: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        ws.id
    }

    async fn wait_for_stage(pool: &sqlx::SqlitePool, workspace_id: Uuid, expected: Option<i64>) {
        for _ in 0..100 {
            let ws = Workspace::find_by_id(pool, workspace_id)
                .await
                .unwrap()
                .unwrap();
            if ws.current_pipeline_stage == expected {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("workspace {workspace_id} never reached stage {expected:?}");
    }
}
