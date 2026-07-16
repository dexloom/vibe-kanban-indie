//! Backend watchdog that keeps the singleton Orchestrator session's Claude
//! context healthy by typing `/compact` into its tmux session (typed keys via
//! [`ContainerService::send_interactive_input`], which executes slash
//! commands — never the bracketed-paste `send_interactive_message`). Mirrors
//! `RecurrentScheduler`'s spawn/start/tick_once shape
//! (`recurrent/scheduler.rs`): a single long-lived tokio task polling on a
//! fixed interval, errors logged, never panicking the loop.
//!
//! Two triggers, evaluated each tick against the live orchestrator's latest
//! measured context (`input_tokens + cache_creation_input_tokens +
//! cache_read_input_tokens` summed from the last usage-bearing assistant
//! record in its transcript JSONL; `output_tokens` excluded):
//! - **Size:** usage > `token_threshold` (default 400_000).
//! - **Age:** time since the last watchdog-sent `/compact` (or the process's
//!   `started_at` if none sent yet) >= `max_age` (default 1h), and usage >=
//!   `age_floor_tokens` (default 50_000) — compacting a near-empty context is
//!   pure information loss.
//!
//! A `cooldown` (default 10m) since the last send gates both triggers
//! (widened to `max(cooldown, max_age)` once escalated, as a backoff). Sends
//! that don't bring usage back under threshold count as failures; three
//! consecutive counted failures escalate once via
//! `utils::telegram::Telegram::send_escalation_best_effort`. Usage dropping
//! back to/under threshold on any tick resets the failure/escalation state
//! (the episode is resolved).
//!
//! Configured via `~/.vibe-kanban/orchestrator.toml`'s `[compact]` table
//! (`~/.vibe-kanban-dev` in debug builds). Absent file ⇒ defaults (feature
//! on); invalid/unreadable file ⇒ warn once and use defaults — never
//! disabled silently, never a crash:
//! ```toml
//! [compact]
//! enabled = true            # default true — file absent ⇒ feature on with defaults
//! max_age = "1h"            # time-based trigger period
//! token_threshold = 400000  # size-based trigger
//! age_floor_tokens = 50000  # min context for the age trigger to bother
//! cooldown = "10m"          # min gap between sends
//! ```

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, Utc};
use db::{
    DBService,
    models::{execution_process::ExecutionProcess, workspace::Workspace},
};
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    time::interval,
};
use uuid::Uuid;

use crate::services::{
    container::{ContainerError, ContainerService},
    recurrent::schedule::parse_interval,
};

/// How often the watchdog checks the orchestrator's live context.
const TICK_INTERVAL: Duration = Duration::from_secs(60);

/// Initial byte tail read from the transcript file.
const INITIAL_TAIL: u64 = 256 * 1024;
/// Ceiling on the adaptive re-read (a transcript whose last JSONL record
/// alone exceeds this is not supported — measurement degrades to `None`).
const MAX_TAIL: u64 = 4 * 1024 * 1024;

/// Reject configured durations above this bound — keeps every later
/// `chrono::Duration` conversion (the trigger/cooldown math below) well
/// inside both `std::time::Duration` and `chrono`'s signed-seconds range, so
/// no conversion can overflow.
const MAX_CONFIG_DURATION: Duration = Duration::from_secs(365 * 86_400);

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CompactConfig {
    enabled: bool,
    max_age: Duration,
    token_threshold: u64,
    age_floor_tokens: u64,
    cooldown: Duration,
}

impl Default for CompactConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_age: Duration::from_secs(3600),
            token_threshold: 400_000,
            age_floor_tokens: 50_000,
            cooldown: Duration::from_secs(600),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct RawOrchestratorToml {
    #[serde(default)]
    compact: RawCompact,
}

#[derive(Debug, Deserialize, Default)]
struct RawCompact {
    enabled: Option<bool>,
    max_age: Option<String>,
    token_threshold: Option<u64>,
    age_floor_tokens: Option<u64>,
    cooldown: Option<String>,
}

/// Parse the `[compact]` table of `orchestrator.toml`, merging any present
/// fields over `CompactConfig::default()`. Pure — no IO.
pub(crate) fn parse_config(raw: &str) -> Result<CompactConfig, String> {
    let parsed: RawOrchestratorToml = toml::from_str(raw).map_err(|e| e.to_string())?;
    let defaults = CompactConfig::default();
    let compact = parsed.compact;

    let max_age = match compact.max_age {
        Some(s) => parse_bounded_interval(&s)?,
        None => defaults.max_age,
    };
    let cooldown = match compact.cooldown {
        Some(s) => parse_bounded_interval(&s)?,
        None => defaults.cooldown,
    };

    Ok(CompactConfig {
        enabled: compact.enabled.unwrap_or(defaults.enabled),
        max_age,
        token_threshold: compact.token_threshold.unwrap_or(defaults.token_threshold),
        age_floor_tokens: compact
            .age_floor_tokens
            .unwrap_or(defaults.age_floor_tokens),
        cooldown,
    })
}

/// Parse a duration string via the (checked-multiply-hardened) recurrent
/// interval parser, then reject anything above `MAX_CONFIG_DURATION`.
fn parse_bounded_interval(s: &str) -> Result<Duration, String> {
    let d = parse_interval(s).map_err(|e| e.to_string())?;
    if d > MAX_CONFIG_DURATION {
        return Err(format!(
            "duration {s:?} exceeds the 365-day maximum for orchestrator.toml"
        ));
    }
    Ok(d)
}

fn config_path() -> PathBuf {
    utils::path::get_vibe_kanban_home_dir().join("orchestrator.toml")
}

// ---------------------------------------------------------------------
// Transcript usage parsing
// ---------------------------------------------------------------------

/// Walk `tail`'s lines on raw bytes (`split` on `b'\n'` with byte-position
/// tracking — no `from_utf8_lossy` first, offsets must be exact) and return
/// the last assistant record's summed usage plus the byte offset of the end
/// of that line within `tail`. Malformed lines are skipped, never fatal.
/// Sidechain (subagent) entries are skipped defensively — `[unverified]`
/// field name, but skipping on absence is a no-op so this can only help.
///
/// Usage = `input_tokens + cache_creation_input_tokens +
/// cache_read_input_tokens` (missing fields ⇒ 0; `output_tokens` excluded),
/// summed with `saturating_add` so a syntactically valid but extreme value
/// clamps rather than panicking — the saturated sum is far above any
/// threshold, so behavior degrades to "compact", which is correct.
pub(crate) fn last_assistant_usage(tail: &[u8]) -> Option<(u64, u64)> {
    let mut best: Option<(u64, u64)> = None;
    let mut pos: usize = 0;

    for line in tail.split(|&b| b == b'\n') {
        let line_end = pos + line.len();

        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
            let is_sidechain = value
                .get("isSidechain")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let is_assistant = value.get("type").and_then(|v| v.as_str()) == Some("assistant");

            if !is_sidechain
                && is_assistant
                && let Some(usage) = value
                    .get("message")
                    .and_then(|m| m.get("usage"))
                    .and_then(|u| u.as_object())
            {
                let has_any_input_field = usage.contains_key("input_tokens")
                    || usage.contains_key("cache_creation_input_tokens")
                    || usage.contains_key("cache_read_input_tokens");
                if has_any_input_field {
                    let field = |name: &str| usage.get(name).and_then(|v| v.as_u64()).unwrap_or(0);
                    let sum = field("input_tokens")
                        .saturating_add(field("cache_creation_input_tokens"))
                        .saturating_add(field("cache_read_input_tokens"));
                    best = Some((sum, line_end as u64));
                }
            }
        }

        pos = line_end + 1;
    }

    best
}

/// A single context-usage measurement: the summed token usage of the last
/// assistant record found, and the absolute byte offset (in the transcript
/// file) of the end of that record. `usage_record_end` is the provenance a
/// resend decision needs: transcript-file growth alone is not proof a
/// measurement is fresh (post-`/compact` bookkeeping records can grow the
/// file while the last usage-bearing assistant record is still the
/// pre-compaction one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Measurement {
    pub(crate) usage: u64,
    pub(crate) usage_record_end: u64,
}

/// Read the last-assistant-usage measurement from the transcript at `path`,
/// using an adaptive tail read (starts at 256 KiB, quadruples up to 4 MiB if
/// the initial cut may have landed inside a single oversized JSONL record).
/// Any IO error, missing file, or unparseable tail ⇒ `None` (no measurement
/// ⇒ no action; never propagated as an error).
pub(crate) async fn read_usage(path: &Path) -> Option<Measurement> {
    read_usage_with_tail(path, INITIAL_TAIL).await
}

/// Test seam for `read_usage`: lets tests exercise the adaptive-retry path
/// with a tiny initial tail instead of waiting on a multi-hundred-KB fixture.
async fn read_usage_with_tail(path: &Path, initial_tail: u64) -> Option<Measurement> {
    let mut tail_size = initial_tail;
    loop {
        let (tail, base_offset, seek_offset) = read_tail_bytes(path, tail_size).await?;

        match last_assistant_usage(&tail) {
            Some((usage, within_tail_offset)) => {
                return Some(Measurement {
                    usage,
                    usage_record_end: base_offset + within_tail_offset,
                });
            }
            None => {
                if seek_offset > 0 && tail_size < MAX_TAIL {
                    tail_size = tail_size.saturating_mul(4).min(MAX_TAIL);
                    continue;
                }
                return None;
            }
        }
    }
}

/// Read the last `tail_size` bytes of `path` (or the whole file, if
/// smaller). Returns `(tail_bytes, base_offset, seek_offset)`:
/// `base_offset` is the absolute file offset of `tail_bytes[0]` (after
/// dropping any partial first line cut by the seek), `seek_offset` is the
/// raw seek position before that trim — used by the caller to tell whether
/// this read may have cut into an oversized record (`seek_offset > 0`).
/// `None` on any IO error (including a missing file).
async fn read_tail_bytes(path: &Path, tail_size: u64) -> Option<(Vec<u8>, u64, u64)> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    let len = metadata.len();
    let seek_offset = len.saturating_sub(tail_size);

    if seek_offset > 0 {
        file.seek(std::io::SeekFrom::Start(seek_offset))
            .await
            .ok()?;
    }

    let mut buf = Vec::new();
    file.read_to_end(&mut buf).await.ok()?;

    if seek_offset == 0 {
        return Some((buf, 0, 0));
    }

    // Drop the partial first line (up to and including the first `\n`),
    // adjusting the base offset by however many bytes were dropped.
    match buf.iter().position(|&b| b == b'\n') {
        Some(idx) => {
            let dropped = idx + 1;
            let base = seek_offset + dropped as u64;
            Some((buf[dropped..].to_vec(), base, seek_offset))
        }
        None => {
            // The entire tail is one partial line (no newline found) —
            // nothing usable at this tail size; signal via the empty tail
            // and let the caller retry with a bigger one.
            Some((Vec::new(), seek_offset + buf.len() as u64, seek_offset))
        }
    }
}

// ---------------------------------------------------------------------
// Per-execution state and trigger decision
// ---------------------------------------------------------------------

/// Per-execution-id watchdog state, owned exclusively by the single tick
/// loop. `size_attempt_open` marks an unresolved size-compaction episode: set
/// on every `Size`-reason send, cleared whenever usage recovers to/under
/// `token_threshold`. Because that recovery reset runs on every tick
/// regardless of which trigger (if any) fires, the flag is true only while
/// usage has stayed above threshold continuously since the episode's first
/// send.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct ExecState {
    last_compact_sent: Option<DateTime<Utc>>,
    usage_record_end_at_send: u64,
    size_attempt_open: bool,
    consecutive_failures: u32,
    escalated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendReason {
    Size,
    Age,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Send {
        reason: SendReason,
        counts_failure: bool,
    },
    Skip,
}

/// Pure trigger/retry decision for one tick. See the module doc for the
/// trigger definitions; the logic here is the retry/freshness/escalation
/// gating layered on top of them (spec requirements 3, 4, 6, 7).
fn decide(
    m: &Measurement,
    now: DateTime<Utc>,
    started_at: DateTime<Utc>,
    state: &ExecState,
    cfg: &CompactConfig,
) -> Decision {
    let last_compact_ref = state.last_compact_sent.unwrap_or(started_at);
    let max_age = to_chrono_duration(cfg.max_age);

    let age_condition = |usage: u64| {
        now.signed_duration_since(last_compact_ref) >= max_age && usage >= cfg.age_floor_tokens
    };

    let trigger = if m.usage > cfg.token_threshold {
        Some(SendReason::Size)
    } else if age_condition(m.usage) {
        Some(SendReason::Age)
    } else {
        None
    };

    let Some(trigger) = trigger else {
        return Decision::Skip;
    };

    let Some(last_sent) = state.last_compact_sent else {
        // No prior send this execution: fire immediately on whichever
        // trigger is due, never counted as a failure (there is nothing to
        // have failed yet).
        return Decision::Send {
            reason: trigger,
            counts_failure: false,
        };
    };

    let gap = if state.escalated {
        cfg.cooldown.max(cfg.max_age)
    } else {
        cfg.cooldown
    };
    if now.signed_duration_since(last_sent) < to_chrono_duration(gap) {
        return Decision::Skip;
    }

    match trigger {
        // The age trigger is the spec's independent "at least once per
        // period" guarantee: never gated on the freshness check below, and
        // never counted as a failure — it is the scheduled compaction
        // working as designed, even when usage doesn't visibly drop.
        SendReason::Age => Decision::Send {
            reason: SendReason::Age,
            counts_failure: false,
        },
        SendReason::Size => {
            if m.usage_record_end <= state.usage_record_end_at_send {
                // The measurement is unchanged since the last send: the
                // retry is indeterminate (compaction may be queued behind a
                // running turn; mere file growth from bookkeeping records
                // must not count). Fall through to the age check rather than
                // just skipping, so a permanently stale measurement can't
                // shadow the age backstop for a quiet high-context session
                // forever.
                if age_condition(m.usage) {
                    Decision::Send {
                        reason: SendReason::Age,
                        counts_failure: false,
                    }
                } else {
                    Decision::Skip
                }
            } else {
                // A newer usage-bearing record is present: counting a
                // failure requires an *unresolved* prior size attempt, so
                // the first send of a fresh spike after a recovery is
                // attempt #0, not failure #1.
                Decision::Send {
                    reason: SendReason::Size,
                    counts_failure: state.size_attempt_open,
                }
            }
        }
    }
}

/// `chrono::Duration::from_std` is infallible in practice here because
/// `parse_bounded_interval` caps every configured duration at 365 days, well
/// under `chrono`'s signed-seconds range; the fallback below only guards a
/// `CompactConfig` built some other way (e.g. a future direct construction)
/// against a panic-free degrade instead of a panic.
fn to_chrono_duration(d: Duration) -> chrono::Duration {
    chrono::Duration::from_std(d).unwrap_or_else(|_| chrono::Duration::days(3650))
}

// ---------------------------------------------------------------------
// Service loop
// ---------------------------------------------------------------------

enum ReadOutcome<'a> {
    Absent,
    Unreadable(String),
    Content(&'a str),
}

/// Resolve the effective config for this tick from a config-file read
/// outcome. `Absent` (file doesn't exist) counts as a successful load — the
/// feature is enabled with defaults, no warning. `Unreadable` (a present but
/// unreadable file — must never be silently treated as absent) or a parse
/// error warns **once** (tracked via `warned`) and falls back to defaults;
/// the warning re-arms on any subsequent successful load (including the file
/// simply being absent again), so a deleted bad file re-arms the warning for
/// a future bad file.
fn load_config(read: ReadOutcome<'_>, warned: &mut bool) -> CompactConfig {
    match read {
        ReadOutcome::Absent => {
            *warned = false;
            CompactConfig::default()
        }
        ReadOutcome::Unreadable(err) => {
            if !*warned {
                tracing::warn!("orchestrator.toml is unreadable ({err}); using defaults");
                *warned = true;
            }
            CompactConfig::default()
        }
        ReadOutcome::Content(s) => match parse_config(s) {
            Ok(cfg) => {
                *warned = false;
                cfg
            }
            Err(e) => {
                if !*warned {
                    tracing::warn!("orchestrator.toml is invalid ({e}); using defaults");
                    *warned = true;
                }
                CompactConfig::default()
            }
        },
    }
}

/// The narrow surface `run_tick` needs from the outside world, so the
/// container never has to be faked wholesale for the decision/state-machine
/// tests below.
trait CompactorDeps {
    async fn is_live(&self) -> bool;
    async fn measure(&self) -> Option<Measurement>;
    async fn send_compact(&self) -> Result<(), ContainerError>;
}

/// Per-tick adapter wrapping a live `(&ContainerService, &ExecutionProcess)`
/// pair as `CompactorDeps`. `measure` resolves the headed-Claude handle via
/// [`ContainerService::headed_claude_handle`] — **not** `agent_progress`,
/// which additionally reconstructs the full normalized message history, work
/// this 60s watchdog doesn't need.
struct ContainerDeps<'a, C: ContainerService> {
    container: &'a C,
    process: &'a ExecutionProcess,
}

impl<C: ContainerService + Send + Sync> CompactorDeps for ContainerDeps<'_, C> {
    async fn is_live(&self) -> bool {
        self.container
            .is_interactive_session_live(self.process)
            .await
    }

    async fn measure(&self) -> Option<Measurement> {
        let handle = self.container.headed_claude_handle(self.process).await?;
        let path = handle.transcript_path?;
        read_usage(&path).await
    }

    async fn send_compact(&self) -> Result<(), ContainerError> {
        self.container
            .send_interactive_input(self.process, "/compact")
            .await
    }
}

/// One tick's worth of decision/action for a single live execution. Live
/// session and measurement resolution, the trigger decision, the send, and
/// the failure/escalation bookkeeping — everything except the DB lookups
/// that pick `deps`'s process in the first place (those stay in
/// `OrchestratorCompactor::tick_once`, which is not worth faking a whole
/// container for).
async fn run_tick(
    deps: &impl CompactorDeps,
    state: &mut ExecState,
    cfg: &CompactConfig,
    now: DateTime<Utc>,
    started_at: DateTime<Utc>,
) {
    if !deps.is_live().await {
        tracing::debug!("orchestrator session is not live; skipping compaction tick");
        return;
    }

    let Some(m) = deps.measure().await else {
        tracing::debug!("no measurement for a live orchestrator session");
        return;
    };

    // Recovery: usage back at/under threshold closes any open size episode
    // and re-arms escalation for a later, distinct failure. Not gated on "no
    // trigger fires this tick" — an age trigger due while usage sits between
    // `age_floor_tokens` and `token_threshold` would otherwise keep
    // `escalated` latched forever, disarming escalation for a later failure.
    if m.usage <= cfg.token_threshold {
        state.consecutive_failures = 0;
        state.escalated = false;
        state.size_attempt_open = false;
    }

    let Decision::Send {
        reason,
        counts_failure,
    } = decide(&m, now, started_at, state, cfg)
    else {
        return;
    };

    match deps.send_compact().await {
        Err(ContainerError::InteractiveSessionGone) => {
            tracing::info!(
                "orchestrator tmux session gone while sending /compact; will retry once it's live again"
            );
        }
        Err(e) => {
            tracing::error!("failed to send /compact to orchestrator session: {e}");
        }
        Ok(()) => {
            tracing::info!(
                "orchestrator context {} tokens (threshold {}, age {}s) → sent /compact",
                m.usage,
                cfg.token_threshold,
                cfg.max_age.as_secs(),
            );

            state.last_compact_sent = Some(now);
            state.usage_record_end_at_send = m.usage_record_end;
            if reason == SendReason::Size {
                state.size_attempt_open = true;
            }
            // A non-counting send is "do not increment", never "proof of
            // recovery": consecutive_failures is left unchanged otherwise —
            // a stale-record Age fallback mid-episode must not erase
            // accumulated strikes and indefinitely postpone escalation.
            if counts_failure {
                state.consecutive_failures += 1;
            }

            if state.consecutive_failures >= 3 && !state.escalated {
                tracing::error!(
                    "orchestrator compaction not taking effect: context {} tokens still above {} after 3 /compact attempts",
                    m.usage,
                    cfg.token_threshold
                );
                state.escalated = true;
                escalate_compaction_failure(m.usage, cfg.token_threshold);
            }
        }
    }
}

/// Best-effort, non-blocking Telegram escalation fired at most once per
/// unresolved size-compaction episode. Mirrors `escalate_startup_failure`
/// (`recurrent/spawn.rs`): `tokio::spawn` with an internal 5s timeout so a
/// Telegram outage can never slow down (or fail) the tick loop.
fn escalate_compaction_failure(usage: u64, threshold: u64) {
    let text = format!(
        "⚠️ Orchestrator compaction not taking effect: context {usage} tokens still above {threshold} after 3 /compact attempts"
    );
    tokio::spawn(async move {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            utils::telegram::Telegram::send_escalation_best_effort(&text),
        )
        .await;
    });
}

/// Polls the singleton Orchestrator's live tmux session on a fixed interval
/// and types `/compact` into it when its measured Claude context crosses a
/// size or age trigger. See the module doc for the full trigger/config
/// description.
pub struct OrchestratorCompactor<C: ContainerService> {
    container: C,
    tick: Duration,
    /// State per running execution id. A new execution id (session
    /// restarted) starts a fresh entry; old entries are dropped on sight.
    state: HashMap<Uuid, ExecState>,
    /// Set once an invalid/unreadable `orchestrator.toml` has been warned
    /// about, so the warning doesn't repeat every tick; reset on any
    /// successful load (see [`load_config`]).
    config_warned: bool,
}

impl<C: ContainerService + Send + Sync + 'static> OrchestratorCompactor<C> {
    /// `db` is accepted for call-site symmetry with `RecurrentScheduler::spawn`
    /// (and in case a future revision needs DB access independent of the
    /// container abstraction); today all DB access goes through
    /// `container.db().pool`.
    pub async fn spawn(_db: DBService, container: C) -> tokio::task::JoinHandle<()> {
        let service = Self {
            container,
            tick: TICK_INTERVAL,
            state: HashMap::new(),
            config_warned: false,
        };
        tokio::spawn(async move {
            service.start().await;
        })
    }

    async fn start(mut self) {
        tracing::info!(
            "Starting orchestrator compactor with interval {:?}",
            self.tick
        );
        let mut ticker = interval(self.tick);
        loop {
            ticker.tick().await;
            self.tick_once().await;
        }
    }

    /// One watchdog pass: load the config, find the live orchestrator
    /// execution (if any), and delegate the measure/decide/act logic to
    /// [`run_tick`].
    async fn tick_once(&mut self) {
        let contents_result = tokio::fs::read_to_string(config_path()).await;
        let read = match &contents_result {
            Ok(s) => ReadOutcome::Content(s.as_str()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadOutcome::Absent,
            Err(e) => ReadOutcome::Unreadable(e.to_string()),
        };
        let cfg = load_config(read, &mut self.config_warned);
        if !cfg.enabled {
            return;
        }

        let pool = &self.container.db().pool;

        let ws = match Workspace::find_orchestrator(pool).await {
            Ok(Some(ws)) => ws,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!(
                    "orchestrator compactor: failed to look up orchestrator workspace: {e}"
                );
                return;
            }
        };

        let proc = match ExecutionProcess::find_latest_running_coding_agent_for_workspace(
            pool, ws.id,
        )
        .await
        {
            Ok(Some(p)) => p,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!(
                    "orchestrator compactor: failed to look up the orchestrator's running execution: {e}"
                );
                return;
            }
        };

        // A new execution id starts a fresh entry; old sessions' state is
        // dropped.
        self.state.retain(|id, _| *id == proc.id);
        let state = self.state.entry(proc.id).or_default();

        let deps = ContainerDeps {
            container: &self.container,
            process: &proc,
        };
        run_tick(&deps, state, &cfg, Utc::now(), proc.started_at).await;
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    // -------------------------------------------------------------
    // Config
    // -------------------------------------------------------------

    #[test]
    fn empty_config_is_defaults_enabled() {
        let cfg = parse_config("").unwrap();
        assert_eq!(cfg, CompactConfig::default());
        assert!(cfg.enabled);
    }

    #[test]
    fn partial_table_merges_over_defaults() {
        let cfg = parse_config("[compact]\ntoken_threshold = 1000\n").unwrap();
        assert_eq!(cfg.token_threshold, 1000);
        assert_eq!(cfg.max_age, CompactConfig::default().max_age);
        assert_eq!(cfg.cooldown, CompactConfig::default().cooldown);
        assert_eq!(
            cfg.age_floor_tokens,
            CompactConfig::default().age_floor_tokens
        );
        assert!(cfg.enabled);
    }

    #[test]
    fn invalid_duration_is_err() {
        assert!(parse_config("[compact]\nmax_age = \"soon\"\n").is_err());
    }

    #[test]
    fn overflow_duration_is_err_not_panic() {
        let result = parse_config("[compact]\nmax_age = \"18446744073709551615m\"\n");
        assert!(result.is_err());
    }

    #[test]
    fn over_cap_duration_is_err() {
        let result = parse_config("[compact]\nmax_age = \"9999999d\"\n");
        assert!(result.is_err());
    }

    #[test]
    fn full_table_round_trips() {
        let toml = "[compact]\n\
                    enabled = true\n\
                    max_age = \"2h\"\n\
                    token_threshold = 123456\n\
                    age_floor_tokens = 999\n\
                    cooldown = \"5m\"\n";
        let cfg = parse_config(toml).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.max_age, Duration::from_secs(2 * 3600));
        assert_eq!(cfg.token_threshold, 123456);
        assert_eq!(cfg.age_floor_tokens, 999);
        assert_eq!(cfg.cooldown, Duration::from_secs(5 * 60));
    }

    #[test]
    fn enabled_false_is_respected() {
        let cfg = parse_config("[compact]\nenabled = false\n").unwrap();
        assert!(!cfg.enabled);
    }

    // -------------------------------------------------------------
    // Transcript usage parsing
    // -------------------------------------------------------------

    fn assistant_line(input: u64, cache_creation: u64, cache_read: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":{input},"cache_creation_input_tokens":{cache_creation},"cache_read_input_tokens":{cache_read},"output_tokens":{output}}}}}}}"#
        )
    }

    fn sidechain_assistant_line(input: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":true,"message":{{"usage":{{"input_tokens":{input}}}}}}}"#
        )
    }

    #[test]
    fn last_usage_wins_when_two_present() {
        let line1 = assistant_line(100, 0, 0, 0);
        let line2 = assistant_line(500, 10, 5, 0);
        let tail = format!("{line1}\n{line2}\n");
        let (usage, offset) = last_assistant_usage(tail.as_bytes()).unwrap();
        assert_eq!(usage, 515);
        let expected_offset = (line1.len() + 1 + line2.len()) as u64;
        assert_eq!(offset, expected_offset);
    }

    #[test]
    fn sum_formula_excludes_output_tokens() {
        let line = assistant_line(100, 50, 25, 99_999);
        let (usage, _) = last_assistant_usage(line.as_bytes()).unwrap();
        assert_eq!(usage, 175);
    }

    #[test]
    fn trailing_malformed_line_is_skipped() {
        let line = assistant_line(42, 0, 0, 0);
        let tail = format!("{line}\nnot valid json{{");
        let (usage, offset) = last_assistant_usage(tail.as_bytes()).unwrap();
        assert_eq!(usage, 42);
        assert_eq!(offset, line.len() as u64);
    }

    #[test]
    fn empty_input_returns_none() {
        assert!(last_assistant_usage(b"").is_none());
    }

    #[test]
    fn no_usage_block_returns_none() {
        let tail = br#"{"type":"assistant","message":{"content":"hi"}}"#;
        assert!(last_assistant_usage(tail).is_none());
    }

    #[test]
    fn sidechain_entry_after_main_is_skipped() {
        let line1 = assistant_line(42, 0, 0, 0);
        let line2 = sidechain_assistant_line(999_999);
        let tail = format!("{line1}\n{line2}\n");
        let (usage, offset) = last_assistant_usage(tail.as_bytes()).unwrap();
        assert_eq!(usage, 42);
        assert_eq!(offset, line1.len() as u64);
    }

    #[test]
    fn appending_non_usage_records_leaves_usage_and_offset_unchanged() {
        let line1 = assistant_line(42, 1, 1, 0);
        let bookkeeping = r#"{"type":"user","message":{"content":"ack"}}"#;

        let tail_a = format!("{line1}\n");
        let tail_b = format!("{line1}\n{bookkeeping}\n");

        assert_eq!(
            last_assistant_usage(tail_a.as_bytes()),
            last_assistant_usage(tail_b.as_bytes())
        );
    }

    #[tokio::test]
    async fn read_usage_returns_correct_absolute_offset_for_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");

        // Pad well past the 256 KiB initial tail so the read must seek into
        // the middle of the file (seek_offset > 0), exercising the
        // partial-first-line trim / base-offset math.
        let padding_line = format!("{{\"type\":\"user\",\"filler\":\"{}\"}}", "x".repeat(80));
        let mut content = String::new();
        while content.len() < 300 * 1024 {
            content.push_str(&padding_line);
            content.push('\n');
        }
        let final_line = assistant_line(12345, 100, 50, 0);
        content.push_str(&final_line);
        // Deliberately no trailing newline: record-end offset == file length.

        tokio::fs::write(&path, &content).await.unwrap();

        let measurement = read_usage(&path).await.unwrap();
        assert_eq!(measurement.usage, 12495);
        assert_eq!(measurement.usage_record_end, content.len() as u64);
    }

    #[tokio::test]
    async fn read_usage_missing_path_returns_none() {
        let path = PathBuf::from("/nonexistent/path/for/orchestrator-compactor-test.jsonl");
        assert!(read_usage(&path).await.is_none());
    }

    #[tokio::test]
    async fn read_usage_adaptive_retry_finds_a_record_larger_than_the_initial_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");

        // A single line (no trailing newline) comfortably larger than a
        // tiny initial tail, forcing at least one quadrupling retry.
        let final_line = assistant_line(777, 88, 9, 0);
        assert!(final_line.len() > 16);
        tokio::fs::write(&path, &final_line).await.unwrap();

        let small_tail = read_usage_with_tail(&path, 16).await.unwrap();
        let large_tail = read_usage_with_tail(&path, INITIAL_TAIL).await.unwrap();

        assert_eq!(small_tail, large_tail);
        assert_eq!(small_tail.usage, 874);
        assert_eq!(small_tail.usage_record_end, final_line.len() as u64);
    }

    // -------------------------------------------------------------
    // Trigger decision
    // -------------------------------------------------------------

    fn measurement(usage: u64) -> Measurement {
        Measurement {
            usage,
            usage_record_end: 1000,
        }
    }

    fn base_time() -> DateTime<Utc> {
        "2026-01-01T00:00:00Z".parse().unwrap()
    }

    #[test]
    fn size_fires_above_threshold() {
        let cfg = CompactConfig::default();
        let now = base_time();
        let state = ExecState::default();
        let decision = decide(&measurement(500_000), now, now, &state, &cfg);
        assert_eq!(
            decision,
            Decision::Send {
                reason: SendReason::Size,
                counts_failure: false
            }
        );
    }

    #[test]
    fn age_fires_only_when_period_elapsed_and_floor_met() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let state = ExecState::default();

        // Period not yet elapsed: no fire.
        let now = started_at + chrono::Duration::minutes(30);
        assert_eq!(
            decide(&measurement(60_000), now, started_at, &state, &cfg),
            Decision::Skip
        );

        // Period elapsed and usage at/above floor: fires.
        let now = started_at + chrono::Duration::hours(1) + chrono::Duration::seconds(1);
        assert_eq!(
            decide(&measurement(60_000), now, started_at, &state, &cfg),
            Decision::Send {
                reason: SendReason::Age,
                counts_failure: false
            }
        );
    }

    #[test]
    fn age_suppressed_below_floor() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let now = started_at + chrono::Duration::hours(2);
        let state = ExecState::default();
        assert_eq!(
            decide(&measurement(1_000), now, started_at, &state, &cfg),
            Decision::Skip
        );
    }

    #[test]
    fn both_triggers_suppressed_inside_cooldown() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::hours(2);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 0,
            ..Default::default()
        };
        // Just inside cooldown, well past max_age and above threshold.
        let now = sent_at + chrono::Duration::minutes(5);
        assert_eq!(
            decide(&measurement(500_000), now, started_at, &state, &cfg),
            Decision::Skip
        );
    }

    #[test]
    fn fresh_state_small_usage_is_skip() {
        let cfg = CompactConfig::default();
        let now = base_time();
        let state = ExecState::default();
        assert_eq!(
            decide(&measurement(100), now, now, &state, &cfg),
            Decision::Skip
        );
    }

    #[test]
    fn size_retry_unchanged_record_end_skips_when_age_not_due() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::minutes(5);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 1000,
            size_attempt_open: true,
            ..Default::default()
        };
        // Past cooldown, still above threshold, but usage_record_end
        // unchanged (== 1000) and age not yet due.
        let now = sent_at + chrono::Duration::minutes(11);
        assert_eq!(
            decide(&measurement(500_000), now, started_at, &state, &cfg),
            Decision::Skip
        );
    }

    #[test]
    fn size_retry_newer_record_open_episode_counts_failure() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::minutes(5);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 1000,
            size_attempt_open: true,
            ..Default::default()
        };
        let now = sent_at + chrono::Duration::minutes(11);
        let m = Measurement {
            usage: 500_000,
            usage_record_end: 2000, // newer than usage_record_end_at_send
        };
        assert_eq!(
            decide(&m, now, started_at, &state, &cfg),
            Decision::Send {
                reason: SendReason::Size,
                counts_failure: true
            }
        );
    }

    #[test]
    fn size_send_with_no_open_episode_is_not_a_failure() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::minutes(5);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 1000,
            size_attempt_open: false, // recovered, this is a fresh spike
            ..Default::default()
        };
        let now = sent_at + chrono::Duration::minutes(11);
        let m = Measurement {
            usage: 500_000,
            usage_record_end: 2000,
        };
        assert_eq!(
            decide(&m, now, started_at, &state, &cfg),
            Decision::Send {
                reason: SendReason::Size,
                counts_failure: false
            }
        );
    }

    #[test]
    fn age_resend_past_gap_fires_even_with_unchanged_record_end() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::hours(1);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 1000,
            ..Default::default()
        };
        // Past cooldown and past max_age since the send; usage below
        // threshold (so the trigger is Age, not Size) and unchanged offset.
        let now = sent_at + chrono::Duration::hours(1) + chrono::Duration::minutes(1);
        let m = Measurement {
            usage: 60_000,
            usage_record_end: 1000,
        };
        assert_eq!(
            decide(&m, now, started_at, &state, &cfg),
            Decision::Send {
                reason: SendReason::Age,
                counts_failure: false
            }
        );
    }

    #[test]
    fn high_usage_unchanged_record_end_age_due_falls_through_to_age() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::hours(1);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 1000,
            size_attempt_open: true,
            consecutive_failures: 2,
            ..Default::default()
        };
        let now = sent_at + chrono::Duration::hours(1) + chrono::Duration::minutes(1);
        let m = Measurement {
            usage: 500_000,         // above threshold: trigger is Size
            usage_record_end: 1000, // unchanged: stale
        };
        let decision = decide(&m, now, started_at, &state, &cfg);
        assert_eq!(
            decision,
            Decision::Send {
                reason: SendReason::Age,
                counts_failure: false
            }
        );
        // consecutive_failures itself is untouched by decide(); the
        // non-counting contract is enforced by run_tick, verified below.
        assert_eq!(state.consecutive_failures, 2);
    }

    #[test]
    fn escalated_state_widens_gap_to_max_of_cooldown_and_max_age() {
        let cfg = CompactConfig {
            max_age: Duration::from_secs(120), // 2m, well under the 10m cooldown
            ..CompactConfig::default()
        };
        let started_at = base_time();
        let sent_at = started_at + chrono::Duration::hours(2);
        let state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 1000,
            escalated: true,
            ..Default::default()
        };
        // Fresh (newer-than-send) measurement, so the Size trigger doesn't
        // fall through the staleness gate — isolates the gap-widening being
        // tested here from the freshness gate covered elsewhere.
        let fresh = Measurement {
            usage: 500_000,
            usage_record_end: 2000,
        };

        // Past max_age (2m) but still inside the cooldown (10m) — the
        // escalated gap must still be governed by cooldown, not max_age.
        let now = sent_at + chrono::Duration::minutes(5);
        assert_eq!(
            decide(&fresh, now, started_at, &state, &cfg),
            Decision::Skip
        );

        // Past both.
        let now = sent_at + chrono::Duration::minutes(11);
        assert_eq!(
            decide(&fresh, now, started_at, &state, &cfg),
            Decision::Send {
                reason: SendReason::Size,
                counts_failure: false
            }
        );
    }

    #[test]
    fn last_compact_ref_seeds_from_started_at() {
        let cfg = CompactConfig::default();
        let started_at = base_time();
        let now = started_at; // just started
        let state = ExecState::default();
        assert_eq!(
            decide(&measurement(60_000), now, started_at, &state, &cfg),
            Decision::Skip
        );
    }

    // -------------------------------------------------------------
    // load_config
    // -------------------------------------------------------------

    #[test]
    fn load_config_invalid_absent_invalid_warns_exactly_twice() {
        let mut warned = false;

        // 1. Invalid: warns (false -> true).
        load_config(
            ReadOutcome::Content("[compact]\nmax_age = \"soon\"\n"),
            &mut warned,
        );
        assert!(warned, "first invalid load should warn");

        // 2. Absent: resets, no new warning attributable (true -> false).
        load_config(ReadOutcome::Absent, &mut warned);
        assert!(!warned, "absent load should reset the warned flag");

        // 3. Invalid again: warns again (false -> true) — a second, distinct
        // warning, because the intervening absent load re-armed it.
        load_config(
            ReadOutcome::Content("[compact]\nmax_age = \"soon\"\n"),
            &mut warned,
        );
        assert!(warned, "second invalid load should warn again");
    }

    #[test]
    fn load_config_unreadable_warns_once_and_uses_defaults() {
        let mut warned = false;
        let cfg = load_config(
            ReadOutcome::Unreadable("permission denied".into()),
            &mut warned,
        );
        assert!(warned);
        assert_eq!(cfg, CompactConfig::default());
    }

    // -------------------------------------------------------------
    // Service-level: run_tick against a scripted fake CompactorDeps
    // -------------------------------------------------------------

    #[derive(Clone, Copy)]
    enum SendOutcome {
        Ok,
        SessionGone,
        Other,
    }

    struct FakeDeps {
        live: Cell<bool>,
        measurement: RefCell<Option<Measurement>>,
        send_outcome: Cell<SendOutcome>,
        measure_calls: Cell<u32>,
        send_calls: Cell<u32>,
    }

    impl FakeDeps {
        fn new(live: bool, measurement: Option<Measurement>) -> Self {
            Self {
                live: Cell::new(live),
                measurement: RefCell::new(measurement),
                send_outcome: Cell::new(SendOutcome::Ok),
                measure_calls: Cell::new(0),
                send_calls: Cell::new(0),
            }
        }

        fn set_measurement(&self, m: Option<Measurement>) {
            *self.measurement.borrow_mut() = m;
        }

        fn set_send_outcome(&self, outcome: SendOutcome) {
            self.send_outcome.set(outcome);
        }
    }

    impl CompactorDeps for FakeDeps {
        async fn is_live(&self) -> bool {
            self.live.get()
        }

        async fn measure(&self) -> Option<Measurement> {
            self.measure_calls.set(self.measure_calls.get() + 1);
            *self.measurement.borrow()
        }

        async fn send_compact(&self) -> Result<(), ContainerError> {
            self.send_calls.set(self.send_calls.get() + 1);
            match self.send_outcome.get() {
                SendOutcome::Ok => Ok(()),
                SendOutcome::SessionGone => Err(ContainerError::InteractiveSessionGone),
                SendOutcome::Other => Err(ContainerError::NotInteractive),
            }
        }
    }

    #[tokio::test]
    async fn live_over_threshold_sends_and_updates_state() {
        let started_at = base_time();
        let m = Measurement {
            usage: 500_000,
            usage_record_end: 100,
        };
        let deps = FakeDeps::new(true, Some(m));
        let cfg = CompactConfig::default();
        let mut state = ExecState::default();

        run_tick(&deps, &mut state, &cfg, started_at, started_at).await;

        assert_eq!(deps.send_calls.get(), 1);
        assert_eq!(state.last_compact_sent, Some(started_at));
        assert_eq!(state.usage_record_end_at_send, 100);
    }

    #[tokio::test]
    async fn dead_session_never_measures_or_sends() {
        let started_at = base_time();
        let deps = FakeDeps::new(false, None);
        let cfg = CompactConfig::default();
        let mut state = ExecState::default();

        run_tick(&deps, &mut state, &cfg, started_at, started_at).await;

        assert_eq!(deps.measure_calls.get(), 0);
        assert_eq!(deps.send_calls.get(), 0);
    }

    #[tokio::test]
    async fn session_gone_on_send_does_not_update_state() {
        let started_at = base_time();
        let m = Measurement {
            usage: 500_000,
            usage_record_end: 100,
        };
        let deps = FakeDeps::new(true, Some(m));
        deps.set_send_outcome(SendOutcome::SessionGone);
        let cfg = CompactConfig::default();
        let mut state = ExecState::default();

        run_tick(&deps, &mut state, &cfg, started_at, started_at).await;

        assert_eq!(state, ExecState::default());
    }

    #[tokio::test]
    async fn other_send_error_does_not_update_state_either() {
        let started_at = base_time();
        let m = Measurement {
            usage: 500_000,
            usage_record_end: 100,
        };
        let deps = FakeDeps::new(true, Some(m));
        deps.set_send_outcome(SendOutcome::Other);
        let cfg = CompactConfig::default();
        let mut state = ExecState::default();

        run_tick(&deps, &mut state, &cfg, started_at, started_at).await;

        // No state update ⇒ natural retry next tick.
        assert_eq!(state, ExecState::default());
    }

    #[tokio::test]
    async fn third_consecutive_counted_failure_escalates_exactly_once() {
        let started_at = base_time();
        let cfg = CompactConfig::default();
        let mut state = ExecState::default();
        let deps = FakeDeps::new(true, None);

        // Attempt #0: fresh episode, opens it, not a failure.
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 100,
        }));
        run_tick(&deps, &mut state, &cfg, started_at, started_at).await;
        assert!(!state.escalated);
        assert_eq!(state.consecutive_failures, 0);

        // Attempt #1 (past cooldown, newer record, still above threshold):
        // failure #1.
        let t1 = started_at + chrono::Duration::minutes(11);
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 200,
        }));
        run_tick(&deps, &mut state, &cfg, t1, started_at).await;
        assert_eq!(state.consecutive_failures, 1);
        assert!(!state.escalated);

        // Attempt #2: failure #2.
        let t2 = t1 + chrono::Duration::minutes(11);
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 300,
        }));
        run_tick(&deps, &mut state, &cfg, t2, started_at).await;
        assert_eq!(state.consecutive_failures, 2);
        assert!(!state.escalated);

        // Attempt #3: failure #3 -> escalates.
        let t3 = t2 + chrono::Duration::minutes(11);
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 400,
        }));
        run_tick(&deps, &mut state, &cfg, t3, started_at).await;
        assert_eq!(state.consecutive_failures, 3);
        assert!(state.escalated);

        // A further failed attempt must not escalate again (flag already
        // set) — consecutive_failures may still grow, `escalated` stays
        // true (checked implicitly: no panic/duplicate-escalation path to
        // observe here beyond the flag itself remaining true).
        let t4 = t3 + chrono::Duration::hours(1); // past the escalated max(cooldown, max_age) gap
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 500,
        }));
        run_tick(&deps, &mut state, &cfg, t4, started_at).await;
        assert!(state.escalated);
    }

    #[tokio::test]
    async fn escalated_recovery_with_age_due_sends_and_resets() {
        let started_at = base_time();
        let cfg = CompactConfig::default();
        let sent_at = started_at + chrono::Duration::hours(1);
        let mut state = ExecState {
            last_compact_sent: Some(sent_at),
            usage_record_end_at_send: 100,
            size_attempt_open: true,
            consecutive_failures: 3,
            escalated: true,
        };
        // Usage now below threshold (recovered) but age trigger due
        // relative to last_compact_sent.
        let now = sent_at + chrono::Duration::hours(1) + chrono::Duration::minutes(1);
        let deps = FakeDeps::new(
            true,
            Some(Measurement {
                usage: 60_000,
                usage_record_end: 200,
            }),
        );

        run_tick(&deps, &mut state, &cfg, now, started_at).await;

        assert_eq!(deps.send_calls.get(), 1);
        assert_eq!(state.last_compact_sent, Some(now));
        assert!(!state.escalated);
        assert_eq!(state.consecutive_failures, 0);
        assert!(!state.size_attempt_open);
    }

    #[tokio::test]
    async fn recovery_then_new_spike_first_send_is_not_a_failure() {
        let started_at = base_time();
        let cfg = CompactConfig::default();
        let mut state = ExecState::default();
        let deps = FakeDeps::new(true, None);

        // Open a size episode.
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 100,
        }));
        run_tick(&deps, &mut state, &cfg, started_at, started_at).await;
        assert!(state.size_attempt_open);

        // Recover: usage back under threshold closes the episode.
        let t1 = started_at + chrono::Duration::minutes(11);
        deps.set_measurement(Some(Measurement {
            usage: 10_000,
            usage_record_end: 200,
        }));
        run_tick(&deps, &mut state, &cfg, t1, started_at).await;
        assert!(!state.size_attempt_open);

        // Fresh spike, past cooldown, newer record: first send of the new
        // episode must not count as a failure.
        let t2 = t1 + chrono::Duration::minutes(11);
        deps.set_measurement(Some(Measurement {
            usage: 500_000,
            usage_record_end: 300,
        }));
        let failures_before = state.consecutive_failures;
        run_tick(&deps, &mut state, &cfg, t2, started_at).await;
        assert_eq!(state.consecutive_failures, failures_before);
        assert!(state.size_attempt_open);
    }
}
