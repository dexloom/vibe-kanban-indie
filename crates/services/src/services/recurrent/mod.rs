//! File-based recurrent task ("routine") catalog.
//!
//! Each `~/.vibe-kanban/recurrent/*.toml` file defines one scheduled routine:
//! a `name`, `prompt`, optional `agent`/`executor_profile`/`max_runtime`, and
//! exactly one schedule (`cron` or `every`). The file stem is the routine
//! `id` (e.g. `inbox-triage.toml` → `inbox-triage`).
//!
//! ```toml
//! name = "Daily triage"
//! enabled = false
//! prompt = "..."
//! agent = "vibe-kanban-indie:..."      # optional
//! executor_profile = "CLAUDE_CODE"     # optional; "headed"/"headless"/BaseCodingAgent
//! max_runtime = "30m"                  # optional; default 30m
//! cron = "0 9 * * *"                   # exactly one of cron/every
//! # every = "30m"
//! ```
//!
//! `GET /api/recurrent` reads these (enriched with `last_run` from the DB),
//! the recurrent scheduler (`recurrent::scheduler`) fires due routines via
//! `recurrent::spawn`. Bundled defaults are seeded to disk on first run.

use std::{path::Path, str::FromStr};

use chrono::{DateTime, Utc};
use executors::executors::BaseCodingAgent;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

pub mod schedule;
pub mod scheduler;
pub mod spawn;

pub use schedule::{RoutineScheduleView, Schedule, parse_schedule};

/// Default max runtime for a routine run when `max_runtime` is unset.
pub const DEFAULT_MAX_RUNTIME_SECS: u64 = 30 * 60;

/// Bundled default routine files, seeded to `recurrent_dir()` on first run.
/// Both are shipped disabled — the operator opts in explicitly.
const BUNDLED: &[(&str, &str)] = &[
    (
        "inbox-triage.toml",
        include_str!("../../../../../assets/recurrent/inbox-triage.toml"),
    ),
    (
        "dependency-audit.toml",
        include_str!("../../../../../assets/recurrent/dependency-audit.toml"),
    ),
];

/// A recurring routine loaded from a `*.toml` file.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Routine {
    /// Stable slug = the file stem, e.g. "inbox-triage".
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    /// Optional `--agent` id (e.g. "vibe-kanban-indie:orchestrator").
    pub agent: Option<String>,
    /// Resolved `BaseCodingAgent` SCREAMING_SNAKE_CASE string, e.g. "CLAUDE_CODE".
    pub executor_profile: String,
    pub max_runtime_secs: u64,
    pub schedule: RoutineScheduleView,
    pub last_run: Option<RoutineLastRun>,
}

impl Routine {
    /// Re-parse this routine's schedule into a [`Schedule`] the scheduler can
    /// evaluate. The stringy [`RoutineScheduleView`] is what's stored on the
    /// API-facing struct (croner's `Cron` doesn't derive `Serialize` without
    /// its `serde` feature), so this reconstructs it from the raw expression —
    /// cheap, and it was already validated once at parse time.
    pub fn schedule(&self) -> Result<Schedule, RecurrentError> {
        match self.schedule.kind.as_str() {
            "cron" => schedule::parse_schedule(Some(&self.schedule.expr), None),
            "interval" => schedule::parse_schedule(None, Some(&self.schedule.expr)),
            other => Err(RecurrentError::Invalid(format!(
                "unknown schedule kind: {other}"
            ))),
        }
    }
}

/// Last known run outcome for a routine, sourced from the DB (not the TOML).
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct RoutineLastRun {
    pub status: String,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum RecurrentError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("failed to parse routine TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("invalid routine: {0}")]
    Invalid(String),
    #[error("routine not found")]
    NotFound,
    #[error("invalid routine id")]
    InvalidId,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Workspace(#[from] db::models::workspace::WorkspaceError),
    #[error(transparent)]
    Container(#[from] crate::services::container::ContainerError),
}

#[derive(Debug, Deserialize)]
struct RawRoutine {
    name: String,
    #[serde(default)]
    enabled: bool,
    prompt: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    executor_profile: Option<String>,
    #[serde(default)]
    max_runtime: Option<String>,
    #[serde(default)]
    cron: Option<String>,
    #[serde(default)]
    every: Option<String>,
}

/// A slug is a non-empty run of ASCII alphanumerics, `-`, or `_`. Used for
/// routine ids (file stems). Rejects path traversal (`/`, `\`, `..`).
fn is_valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Validate an untrusted routine id (e.g. a route path param).
pub fn validate_id(id: &str) -> Result<(), RecurrentError> {
    if is_valid_slug(id) {
        Ok(())
    } else {
        Err(RecurrentError::InvalidId)
    }
}

/// Resolve the `executor_profile` TOML field into a `BaseCodingAgent`
/// SCREAMING_SNAKE_CASE string: `"headed"` → `CLAUDE_CODE_HEADED`,
/// `"headless"`/unset → `CLAUDE_CODE`, else parsed as a `BaseCodingAgent`
/// value directly (e.g. `"CODEX"`).
fn resolve_executor_profile(raw: Option<&str>) -> Result<String, RecurrentError> {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty());
    let agent = match trimmed {
        None => BaseCodingAgent::ClaudeCode,
        Some(s) if s.eq_ignore_ascii_case("headed") => BaseCodingAgent::ClaudeCodeHeaded,
        Some(s) if s.eq_ignore_ascii_case("headless") => BaseCodingAgent::ClaudeCode,
        Some(s) => BaseCodingAgent::from_str(&s.to_uppercase())
            .map_err(|_| RecurrentError::Invalid(format!("invalid executor_profile: {s:?}")))?,
    };
    Ok(agent.to_string())
}

/// Parse and validate a single routine's TOML. `id` is the file stem.
pub fn parse_routine(id: &str, raw: &str) -> Result<Routine, RecurrentError> {
    validate_id(id)?;
    let parsed: RawRoutine = toml::from_str(raw)?;
    if parsed.name.trim().is_empty() {
        return Err(RecurrentError::Invalid(
            "routine name must not be empty".to_string(),
        ));
    }
    if parsed.prompt.trim().is_empty() {
        return Err(RecurrentError::Invalid(
            "routine prompt must not be empty".to_string(),
        ));
    }

    let parsed_schedule =
        schedule::parse_schedule(parsed.cron.as_deref(), parsed.every.as_deref())?;
    let schedule_view = RoutineScheduleView {
        kind: parsed_schedule.kind_str().to_string(),
        expr: match (parsed.cron.as_deref(), parsed.every.as_deref()) {
            (Some(c), None) => c.trim().to_string(),
            (None, Some(e)) => e.trim().to_string(),
            _ => unreachable!("parse_schedule already validated exactly one of cron/every"),
        },
    };

    let executor_profile = resolve_executor_profile(parsed.executor_profile.as_deref())?;

    let max_runtime_secs = match parsed.max_runtime.as_deref() {
        Some(s) => schedule::parse_interval(s)?.as_secs(),
        None => DEFAULT_MAX_RUNTIME_SECS,
    };

    Ok(Routine {
        id: id.to_string(),
        name: parsed.name,
        enabled: parsed.enabled,
        prompt: parsed.prompt,
        agent: parsed.agent.filter(|s| !s.trim().is_empty()),
        executor_profile,
        max_runtime_secs,
        schedule: schedule_view,
        last_run: None,
    })
}

fn has_toml(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("toml"))
        })
        .unwrap_or(false)
}

/// Seed bundled defaults, but **only when the dir is absent or contains no
/// `*.toml`** (mirrors `pipelines::ensure_seeded`).
pub fn ensure_seeded(dir: &Path) -> Result<(), RecurrentError> {
    if dir.exists() && has_toml(dir) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    for (name, content) in BUNDLED {
        let path = dir.join(name);
        if !path.exists() {
            std::fs::write(&path, content)?;
        }
    }
    Ok(())
}

/// Load every valid routine from `dir`, seeding defaults first if empty.
/// Malformed files are skipped with a warning so one bad file can't break the
/// endpoint or the scheduler tick — and it is NOT deleted/rewritten, so the
/// API still surfaces its parse error via `read_raw`/`write_raw`.
pub fn load_routines(dir: &Path) -> Vec<Routine> {
    if let Err(e) = ensure_seeded(dir) {
        tracing::warn!("failed to seed recurrent dir {}: {}", dir.display(), e);
    }
    let mut out: Vec<Routine> = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!("failed to read recurrent dir {}: {}", dir.display(), e);
            return out;
        }
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|x| x.to_str()) != Some("toml") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("skip routine {}: {}", path.display(), e);
                continue;
            }
        };
        match parse_routine(stem, &raw) {
            Ok(r) => out.push(r),
            Err(e) => tracing::warn!("skip invalid routine {}: {}", path.display(), e),
        }
    }
    let bundled_order = |id: &str| {
        BUNDLED
            .iter()
            .position(|(n, _)| n.trim_end_matches(".toml") == id)
    };
    out.sort_by(|a, b| match (bundled_order(&a.id), bundled_order(&b.id)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    });
    out
}

/// Read the raw TOML of a single routine (for the Settings editor).
pub fn read_raw(dir: &Path, id: &str) -> Result<String, RecurrentError> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.toml"));
    if !path.exists() {
        return Err(RecurrentError::NotFound);
    }
    Ok(std::fs::read_to_string(path)?)
}

/// Validate and write raw TOML for a routine. Rejects content that fails to
/// parse **before** touching disk, returning the parsed routine on success —
/// the prior file on disk is left untouched on error.
pub fn write_raw(dir: &Path, id: &str, content: &str) -> Result<Routine, RecurrentError> {
    validate_id(id)?;
    let routine = parse_routine(id, content)?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(format!("{id}.toml")), content)?;
    Ok(routine)
}

/// Flip a routine's `enabled` flag in place, preserving the rest of the TOML
/// document's formatting (via `toml_edit`).
pub fn set_enabled(dir: &Path, id: &str, enabled: bool) -> Result<Routine, RecurrentError> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.toml"));
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            RecurrentError::NotFound
        } else {
            RecurrentError::Io(e)
        }
    })?;
    let mut doc = raw
        .parse::<toml_edit::Document>()
        .map_err(|e| RecurrentError::Invalid(format!("failed to parse existing TOML: {e}")))?;
    doc["enabled"] = toml_edit::value(enabled);
    let new_raw = doc.to_string();
    let routine = parse_routine(id, &new_raw)?;
    std::fs::write(&path, &new_raw)?;
    Ok(routine)
}

/// Delete a routine file. Stays deleted while other routine files remain
/// (mirrors `pipelines::delete_pipeline`).
pub fn delete_routine(dir: &Path, id: &str) -> Result<(), RecurrentError> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.toml"));
    if !path.exists() {
        return Err(RecurrentError::NotFound);
    }
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Unique temp dir per test invocation (avoids a tempfile dev-dependency).
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!(
                "vk-recurrent-test-{}-{}",
                std::process::id(),
                n
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_valid_routine_with_cron() {
        let raw = r#"
            name = "Demo"
            prompt = "Do the thing."
            cron = "0 9 * * *"
        "#;
        let r = parse_routine("demo", raw).unwrap();
        assert_eq!(r.id, "demo");
        assert_eq!(r.name, "Demo");
        assert!(!r.enabled);
        assert_eq!(r.executor_profile, "CLAUDE_CODE");
        assert_eq!(r.max_runtime_secs, DEFAULT_MAX_RUNTIME_SECS);
        assert_eq!(r.schedule.kind, "cron");
        assert_eq!(r.schedule.expr, "0 9 * * *");
    }

    #[test]
    fn parses_valid_routine_with_interval_and_overrides() {
        let raw = r#"
            name = "Demo interval"
            enabled = true
            prompt = "Do the thing."
            agent = "vibe-kanban-indie:orchestrator"
            executor_profile = "headed"
            max_runtime = "10m"
            every = "45m"
        "#;
        let r = parse_routine("demo2", raw).unwrap();
        assert!(r.enabled);
        assert_eq!(r.agent.as_deref(), Some("vibe-kanban-indie:orchestrator"));
        assert_eq!(r.executor_profile, "CLAUDE_CODE_HEADED");
        assert_eq!(r.max_runtime_secs, 600);
        assert_eq!(r.schedule.kind, "interval");
        assert_eq!(r.schedule.expr, "45m");
    }

    #[test]
    fn rejects_two_schedules_or_zero_schedules() {
        let both = "name=\"X\"\nprompt=\"p\"\ncron=\"0 9 * * *\"\nevery=\"30m\"\n";
        assert!(matches!(
            parse_routine("x", both),
            Err(RecurrentError::Invalid(_))
        ));
        let neither = "name=\"X\"\nprompt=\"p\"\n";
        assert!(matches!(
            parse_routine("x", neither),
            Err(RecurrentError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_bad_id_and_empty_prompt() {
        assert!(validate_id("..").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("basic").is_ok());

        let empty_prompt = "name=\"X\"\nprompt=\"\"\ncron=\"0 9 * * *\"\n";
        assert!(matches!(
            parse_routine("x", empty_prompt),
            Err(RecurrentError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_invalid_executor_profile() {
        let raw =
            "name=\"X\"\nprompt=\"p\"\ncron=\"0 9 * * *\"\nexecutor_profile=\"not-a-real-agent\"\n";
        assert!(matches!(
            parse_routine("x", raw),
            Err(RecurrentError::Invalid(_))
        ));
    }

    #[test]
    fn seeds_defaults_into_empty_dir_both_disabled() {
        let d = TmpDir::new();
        let routines = load_routines(d.path());
        let ids: Vec<_> = routines.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["inbox-triage", "dependency-audit"]);
        assert!(routines.iter().all(|r| !r.enabled));
    }

    #[test]
    fn skips_malformed_file_but_keeps_valid_ones() {
        let d = TmpDir::new();
        ensure_seeded(d.path()).unwrap();
        std::fs::write(d.path().join("broken.toml"), "this is = not [valid").unwrap();
        let routines = load_routines(d.path());
        assert!(routines.iter().any(|r| r.id == "inbox-triage"));
        assert!(!routines.iter().any(|r| r.id == "broken"));
    }

    #[test]
    fn write_raw_rejects_invalid_toml_without_touching_disk() {
        let d = TmpDir::new();
        assert!(write_raw(d.path(), "custom", "not valid = [").is_err());
        assert!(!d.path().join("custom.toml").exists());
    }

    #[test]
    fn set_enabled_round_trips() {
        let d = TmpDir::new();
        ensure_seeded(d.path()).unwrap();
        let enabled = set_enabled(d.path(), "inbox-triage", true).unwrap();
        assert!(enabled.enabled);
        let disabled = set_enabled(d.path(), "inbox-triage", false).unwrap();
        assert!(!disabled.enabled);
    }
}
