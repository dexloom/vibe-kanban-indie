//! Background tokio service that fires due recurrent routines. Mirrors
//! `pr_monitor.rs`'s spawn/start pattern: a single long-lived task polling on
//! an interval, errors logged and never allowed to panic the loop.

use std::{collections::HashMap, time::Duration};

use chrono::{DateTime, Utc};
use db::DBService;
use tokio::time::interval;
use tracing::{error, info, warn};

use crate::services::{
    container::ContainerService,
    recurrent::{
        self, Routine,
        spawn::{SpawnOutcome, spawn_routine_run, stop_overrunning},
    },
};

const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Polls `~/.vibe-kanban/recurrent/*.toml` on a fixed interval, spawning a
/// due-and-enabled routine's session and stopping any session that has
/// overrun its `max_runtime`.
pub struct RecurrentScheduler<C: ContainerService> {
    container: C,
    tick: Duration,
    /// Next fire instant per routine id. Owned exclusively by the single
    /// loop task below (`start` takes `self` by value), so no external
    /// synchronization is needed.
    next_due: HashMap<String, DateTime<Utc>>,
}

impl<C: ContainerService + Send + Sync + 'static> RecurrentScheduler<C> {
    /// `db` is accepted for call-site symmetry with `PrMonitorService::spawn`
    /// (and in case a future revision needs DB access independent of the
    /// container abstraction); today all DB access goes through `container`
    /// (`spawn_routine_run`/`stop_overrunning` read `container.db().pool`).
    pub async fn spawn(_db: DBService, container: C) -> tokio::task::JoinHandle<()> {
        let service = Self {
            container,
            tick: TICK_INTERVAL,
            next_due: HashMap::new(),
        };
        tokio::spawn(async move {
            service.start().await;
        })
    }

    async fn start(mut self) {
        info!("Starting recurrent scheduler with interval {:?}", self.tick);
        let mut ticker = interval(self.tick);
        loop {
            ticker.tick().await;
            self.tick_once().await;
        }
    }

    /// One scheduler pass: load the current routine catalog, evaluate due
    /// state per enabled routine, and check overrun for each.
    async fn tick_once(&mut self) {
        let routines = recurrent::load_routines(&utils::path::recurrent_dir());
        let now = Utc::now();

        let enabled_ids: std::collections::HashSet<&str> = routines
            .iter()
            .filter(|r| r.enabled)
            .map(|r| r.id.as_str())
            .collect();
        // Drop next_due entries for routines no longer present/enabled, so a
        // disabled-then-re-enabled routine gets a fresh "no catch-up" seed
        // rather than firing immediately on an old stale instant.
        self.next_due
            .retain(|id, _| enabled_ids.contains(id.as_str()));

        for routine in routines.iter().filter(|r| r.enabled) {
            self.tick_routine(routine, now).await;
        }
    }

    async fn tick_routine(&mut self, routine: &Routine, now: DateTime<Utc>) {
        let schedule = match routine.schedule() {
            Ok(s) => s,
            Err(e) => {
                warn!(
                    "Recurrent routine '{}' has an invalid schedule ({}); skipping this tick",
                    routine.id, e
                );
                return;
            }
        };

        let due = match self.next_due.get(&routine.id) {
            // First sight: seed next_due without firing immediately. This is
            // the documented "no catch-up" of missed schedules across
            // restarts — a routine only ever fires from the next slot after
            // the scheduler started observing it.
            None => {
                let next = schedule.next_after(now);
                info!(
                    "Recurrent routine '{}' first seen; next due at {}",
                    routine.id, next
                );
                self.next_due.insert(routine.id.clone(), next);
                false
            }
            Some(next) => now >= *next,
        };

        if due {
            match spawn_routine_run(&self.container, routine).await {
                Ok(SpawnOutcome::Spawned(workspace, _process)) => {
                    info!(
                        "Recurrent routine '{}' due: spawned workspace {}",
                        routine.id, workspace.id
                    );
                }
                Ok(SpawnOutcome::SkippedActive) => {
                    info!(
                        "Recurrent routine '{}' due, but a previous run is still active; skipped",
                        routine.id
                    );
                }
                Err(e) => {
                    error!("Recurrent routine '{}' failed to spawn: {}", routine.id, e);
                }
            }
            // Advance on every outcome (Spawned, SkippedActive, or Err) so a
            // failing spawn does not retry every tick, and there is no
            // double-fire: the next fire is always the next scheduled slot.
            let next = schedule.next_after(now);
            self.next_due.insert(routine.id.clone(), next);
        }

        if let Err(e) = stop_overrunning(&self.container, routine).await {
            error!(
                "Recurrent routine '{}': failed to check/stop an overrunning session: {}",
                routine.id, e
            );
        }
    }
}
