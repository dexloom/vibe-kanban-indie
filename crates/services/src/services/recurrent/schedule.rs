//! Schedule parsing for recurrent routines: exactly one of a cron expression
//! (parsed via `croner`) or a simple interval (`"30m"`, a tiny hand-rolled
//! `s|m|h|d` parser — no new dependency needed for that form).

use std::{str::FromStr, time::Duration};

use chrono::{DateTime, Utc};
use croner::Cron;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::RecurrentError;

/// A parsed schedule: either a cron pattern or a fixed interval.
#[derive(Debug, Clone)]
pub enum Schedule {
    Cron(Box<Cron>),
    Interval(Duration),
}

/// Stringy view of a routine's schedule, for the API / UI.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RoutineScheduleView {
    /// `"cron"` or `"interval"`.
    pub kind: String,
    /// The raw expression (`"0 9 * * *"` or `"30m"`).
    pub expr: String,
}

impl Schedule {
    /// The next instant strictly after `from` at which this schedule fires.
    /// Cron: the next matching slot after `from` (croner's `inclusive =
    /// false`). Interval: `from + duration`. Falls back to `from + 1h` (with a
    /// warning) on the (practically unreachable, since the pattern was
    /// validated at parse time) croner search failure, so the scheduler loop
    /// can never get stuck retrying the same instant forever.
    pub fn next_after(&self, from: DateTime<Utc>) -> DateTime<Utc> {
        match self {
            Schedule::Cron(cron) => match cron.find_next_occurrence(&from, false) {
                Ok(dt) => dt,
                Err(e) => {
                    tracing::warn!("croner failed to find next occurrence: {e}; retrying in 1h");
                    from + chrono::Duration::hours(1)
                }
            },
            Schedule::Interval(duration) => {
                from + chrono::Duration::from_std(*duration)
                    .unwrap_or_else(|_| chrono::Duration::minutes(1))
            }
        }
    }

    pub fn kind_str(&self) -> &'static str {
        match self {
            Schedule::Cron(_) => "cron",
            Schedule::Interval(_) => "interval",
        }
    }
}

/// Parse a routine's schedule from its raw `cron`/`every` TOML fields.
/// Exactly one of the two must be set.
pub fn parse_schedule(cron: Option<&str>, every: Option<&str>) -> Result<Schedule, RecurrentError> {
    match (
        cron.map(str::trim).filter(|s| !s.is_empty()),
        every.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(_), Some(_)) => Err(RecurrentError::Invalid(
            "exactly one of `cron`/`every` must be set (found both)".to_string(),
        )),
        (None, None) => Err(RecurrentError::Invalid(
            "exactly one of `cron`/`every` must be set (found neither)".to_string(),
        )),
        (Some(expr), None) => {
            let cron = Cron::from_str(expr)
                .map_err(|e| RecurrentError::Invalid(format!("invalid cron {expr:?}: {e}")))?;
            Ok(Schedule::Cron(Box::new(cron)))
        }
        (None, Some(expr)) => Ok(Schedule::Interval(parse_interval(expr)?)),
    }
}

/// Parse a simple interval like `"30m"` (integer + one of `s|m|h|d`). Zero is
/// rejected — a zero-length interval would busy-loop the scheduler.
pub fn parse_interval(s: &str) -> Result<Duration, RecurrentError> {
    let s = s.trim();
    if s.len() < 2 {
        return Err(RecurrentError::Invalid(format!(
            "invalid interval {s:?} (expected e.g. \"30m\")"
        )));
    }
    let (num_part, unit) = s.split_at(s.len() - 1);
    let n: u64 = num_part
        .parse()
        .map_err(|_| RecurrentError::Invalid(format!("invalid interval {s:?}: bad number")))?;
    if n == 0 {
        return Err(RecurrentError::Invalid(format!(
            "invalid interval {s:?}: must be greater than zero"
        )));
    }
    let secs = match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86400,
        other => {
            return Err(RecurrentError::Invalid(format!(
                "invalid interval unit {other:?} in {s:?} (expected one of s/m/h/d)"
            )));
        }
    };
    Ok(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_intervals() {
        assert_eq!(parse_interval("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_interval("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_interval("1d").unwrap(), Duration::from_secs(86400));
        assert_eq!(parse_interval("45s").unwrap(), Duration::from_secs(45));
    }

    #[test]
    fn rejects_invalid_intervals() {
        assert!(parse_interval("0m").is_err());
        assert!(parse_interval("m").is_err());
        assert!(parse_interval("30").is_err());
        assert!(parse_interval("30x").is_err());
        assert!(parse_interval("").is_err());
    }

    #[test]
    fn parse_schedule_requires_exactly_one() {
        assert!(matches!(
            parse_schedule(None, None),
            Err(RecurrentError::Invalid(_))
        ));
        assert!(matches!(
            parse_schedule(Some("0 9 * * *"), Some("30m")),
            Err(RecurrentError::Invalid(_))
        ));
        assert!(parse_schedule(Some("0 9 * * *"), None).is_ok());
        assert!(parse_schedule(None, Some("30m")).is_ok());
    }

    #[test]
    fn cron_next_after_finds_correct_next_slot() {
        let schedule = parse_schedule(Some("0 9 * * *"), None).unwrap();
        // 2026-07-02T10:00:00Z is after today's 09:00 slot, so the next
        // occurrence should be tomorrow at 09:00.
        let from: DateTime<Utc> = "2026-07-02T10:00:00Z".parse().unwrap();
        let next = schedule.next_after(from);
        let expected: DateTime<Utc> = "2026-07-03T09:00:00Z".parse().unwrap();
        assert_eq!(next, expected);
    }

    #[test]
    fn interval_next_after_is_from_plus_every() {
        let schedule = parse_schedule(None, Some("30m")).unwrap();
        let from: DateTime<Utc> = "2026-07-02T10:00:00Z".parse().unwrap();
        let next = schedule.next_after(from);
        let expected: DateTime<Utc> = "2026-07-02T10:30:00Z".parse().unwrap();
        assert_eq!(next, expected);
    }
}
