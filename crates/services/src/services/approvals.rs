pub mod executor_approvals;

use std::{collections::HashSet, sync::Arc, time::Duration as StdDuration};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures::{
    StreamExt,
    future::{BoxFuture, FutureExt, Shared},
};
use json_patch::Patch;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{broadcast, oneshot};
use tokio_stream::wrappers::BroadcastStream;
use ts_rs::TS;
use utils::approvals::{ApprovalOutcome, ApprovalRequest, ApprovalResponse};
use uuid::Uuid;

#[derive(Debug)]
struct PendingApproval {
    execution_process_id: Uuid,
    tool_name: String,
    is_question: bool,
    created_at: DateTime<Utc>,
    timeout_at: DateTime<Utc>,
    response_tx: oneshot::Sender<ApprovalOutcome>,
}

pub(crate) type ApprovalWaiter = Shared<BoxFuture<'static, ApprovalOutcome>>;

#[derive(Debug)]
pub struct ToolContext {
    pub tool_name: String,
    pub execution_process_id: Uuid,
}

/// Info about a currently pending approval, sent to the frontend via WebSocket.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct ApprovalInfo {
    pub approval_id: String,
    pub tool_name: String,
    pub execution_process_id: Uuid,
    pub is_question: bool,
    pub created_at: DateTime<Utc>,
    pub timeout_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct Approvals {
    pending: Arc<DashMap<String, PendingApproval>>,
    completed: Arc<DashMap<String, ApprovalOutcome>>,
    patches_tx: broadcast::Sender<Patch>,
}

#[derive(Debug, Error)]
pub enum ApprovalError {
    #[error("approval request not found")]
    NotFound,
    #[error("approval request already completed")]
    AlreadyCompleted,
    #[error("no executor session found for session_id: {0}")]
    NoExecutorSession(String),
    #[error("invalid approval status for this tool type")]
    InvalidStatus,
    #[error(transparent)]
    Custom(#[from] anyhow::Error),
}

impl Default for Approvals {
    fn default() -> Self {
        Self::new()
    }
}

impl Approvals {
    pub fn new() -> Self {
        let (patches_tx, _) = broadcast::channel(64);
        Self {
            pending: Arc::new(DashMap::new()),
            completed: Arc::new(DashMap::new()),
            patches_tx,
        }
    }

    pub(crate) async fn create_with_waiter(
        &self,
        request: ApprovalRequest,
        is_question: bool,
    ) -> Result<(ApprovalRequest, ApprovalWaiter), ApprovalError> {
        let (tx, rx) = oneshot::channel();
        let default_timeout = ApprovalOutcome::TimedOut;
        let waiter: ApprovalWaiter = rx
            .map(move |result| result.unwrap_or(default_timeout))
            .boxed()
            .shared();
        let req_id = request.id.clone();

        let info = ApprovalInfo {
            approval_id: req_id.clone(),
            tool_name: request.tool_name.clone(),
            execution_process_id: request.execution_process_id,
            is_question,
            created_at: request.created_at,
            timeout_at: request.timeout_at,
        };

        let pending_approval = PendingApproval {
            execution_process_id: request.execution_process_id,
            tool_name: request.tool_name.clone(),
            is_question,
            created_at: request.created_at,
            timeout_at: request.timeout_at,
            response_tx: tx,
        };

        self.pending.insert(req_id.clone(), pending_approval);

        let _ = self
            .patches_tx
            .send(crate::services::events::patches::approvals_patch::created(
                &info,
            ));

        self.spawn_timeout_watcher(req_id.clone(), request.timeout_at, waiter.clone());
        Ok((request, waiter))
    }

    /// Create an approval and block until it is resolved, returning the outcome.
    ///
    /// Resolves when any of these happen (all converge on the shared waiter):
    /// - the operator responds via [`Self::respond`] (Approved/Denied/Answered),
    /// - the timeout watcher fires (`TimedOut`), or
    /// - [`Self::cancel`] removes the pending entry (dropping the sender, which
    ///   the waiter maps to `TimedOut`).
    ///
    /// Used by the headed (interactive tmux) approval bridge, where a Claude
    /// `PreToolUse` command hook parks an HTTP request here until the operator
    /// decides in the web UI — reusing the exact same store, WS stream, and
    /// `respond` path as the headless control-protocol flow.
    pub async fn create_and_wait(
        &self,
        request: ApprovalRequest,
        is_question: bool,
    ) -> Result<ApprovalOutcome, ApprovalError> {
        let (_, waiter) = self.create_with_waiter(request, is_question).await?;
        Ok(waiter.await)
    }

    fn validate_approval_response(
        outcome: &ApprovalOutcome,
        is_question: bool,
    ) -> Result<(), ApprovalError> {
        match outcome {
            ApprovalOutcome::Approved | ApprovalOutcome::Denied { .. } if is_question => {
                Err(ApprovalError::InvalidStatus)
            }
            ApprovalOutcome::Answered { .. } if !is_question => Err(ApprovalError::InvalidStatus),
            _ => Ok(()),
        }
    }

    #[tracing::instrument(skip(self, id, req))]
    pub async fn respond(
        &self,
        id: &str,
        req: ApprovalResponse,
    ) -> Result<(ApprovalOutcome, ToolContext), ApprovalError> {
        if let Some((_, p)) = self.pending.remove(id) {
            if let Err(e) = Self::validate_approval_response(&req.status, p.is_question) {
                self.pending.insert(id.to_string(), p);
                return Err(e);
            }

            let outcome = req.status.clone();
            self.completed.insert(id.to_string(), outcome.clone());
            let _ = p.response_tx.send(outcome.clone());

            let _ =
                self.patches_tx
                    .send(crate::services::events::patches::approvals_patch::resolved(
                        id,
                    ));

            let tool_ctx = ToolContext {
                tool_name: p.tool_name,
                execution_process_id: p.execution_process_id,
            };

            Ok((outcome, tool_ctx))
        } else if self.completed.contains_key(id) {
            Err(ApprovalError::AlreadyCompleted)
        } else {
            Err(ApprovalError::NotFound)
        }
    }

    #[tracing::instrument(skip(self, id, timeout_at, waiter))]
    fn spawn_timeout_watcher(
        &self,
        id: String,
        timeout_at: chrono::DateTime<chrono::Utc>,
        waiter: ApprovalWaiter,
    ) {
        let pending = self.pending.clone();
        let completed = self.completed.clone();
        let patches_tx = self.patches_tx.clone();

        let timeout_outcome = ApprovalOutcome::TimedOut;

        let now = chrono::Utc::now();
        let to_wait = (timeout_at - now)
            .to_std()
            .unwrap_or_else(|_| StdDuration::from_secs(0));
        let deadline = tokio::time::Instant::now() + to_wait;

        tokio::spawn(async move {
            let outcome = tokio::select! {
                biased;

                resolved = waiter.clone() => resolved,
                _ = tokio::time::sleep_until(deadline) => timeout_outcome,
            };

            let is_timeout = matches!(&outcome, ApprovalOutcome::TimedOut);
            completed.insert(id.clone(), outcome.clone());

            if is_timeout && let Some((_, pending_approval)) = pending.remove(&id) {
                let _ = patches_tx.send(
                    crate::services::events::patches::approvals_patch::resolved(&id),
                );
                if pending_approval.response_tx.send(outcome).is_err() {
                    tracing::debug!("approval '{}' timeout notification receiver dropped", id);
                }
            }
        });
    }

    /// Cancel every pending approval belonging to `execution_process_id`,
    /// resolving each waiter as `Denied`. Used when an execution ends (e.g. a
    /// headed tmux session exits) so any parked `create_and_wait` returns
    /// promptly instead of waiting out the timeout.
    pub fn cancel_for_execution_process(&self, execution_process_id: Uuid) {
        let ids: Vec<String> = self
            .pending
            .iter()
            .filter(|entry| entry.value().execution_process_id == execution_process_id)
            .map(|entry| entry.key().clone())
            .collect();

        for id in ids {
            if let Some((_, pending_approval)) = self.pending.remove(&id) {
                let outcome = ApprovalOutcome::Denied {
                    reason: Some("Execution ended".to_string()),
                };
                self.completed.insert(id.clone(), outcome.clone());
                let _ = pending_approval.response_tx.send(outcome);
                let _ = self.patches_tx.send(
                    crate::services::events::patches::approvals_patch::resolved(&id),
                );
                tracing::debug!(
                    "Cancelled approval '{}' (execution {} ended)",
                    id,
                    execution_process_id
                );
            }
        }
    }

    pub(crate) async fn cancel(&self, id: &str) {
        if let Some((_, _pending_approval)) = self.pending.remove(id) {
            let outcome = ApprovalOutcome::Denied {
                reason: Some("Cancelled".to_string()),
            };
            self.completed.insert(id.to_string(), outcome);
            let _ =
                self.patches_tx
                    .send(crate::services::events::patches::approvals_patch::resolved(
                        id,
                    ));
            tracing::debug!("Cancelled approval '{}'", id);
        }
    }

    pub fn patch_stream(&self) -> futures::stream::BoxStream<'static, Patch> {
        let approvals = self.clone();
        let snapshot =
            crate::services::events::patches::approvals_patch::snapshot(&approvals.pending_infos());

        let live = BroadcastStream::new(self.patches_tx.subscribe()).filter_map(move |result| {
            let approvals = approvals.clone();
            async move {
                match result {
                    Ok(patch) => Some(patch),
                    Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => {
                        Some(crate::services::events::patches::approvals_patch::snapshot(
                            &approvals.pending_infos(),
                        ))
                    }
                }
            }
        });

        futures::stream::iter([snapshot]).chain(live).boxed()
    }

    /// Check which execution processes have pending approvals.
    /// Returns a set of execution_process_ids that have at least one pending approval.
    pub fn get_pending_execution_process_ids(
        &self,
        execution_process_ids: &[Uuid],
    ) -> HashSet<Uuid> {
        let id_set: HashSet<_> = execution_process_ids.iter().collect();
        self.pending
            .iter()
            .filter_map(|entry| {
                let ep_id = entry.value().execution_process_id;
                if id_set.contains(&ep_id) {
                    Some(ep_id)
                } else {
                    None
                }
            })
            .collect()
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending.len()
    }

    fn pending_infos(&self) -> Vec<ApprovalInfo> {
        self.pending
            .iter()
            .map(|entry| {
                let p = entry.value();
                ApprovalInfo {
                    approval_id: entry.key().clone(),
                    tool_name: p.tool_name.clone(),
                    execution_process_id: p.execution_process_id,
                    is_question: p.is_question,
                    created_at: p.created_at,
                    timeout_at: p.timeout_at,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Spin until the create_and_wait task has registered its pending entry, so
    /// the test resolves it deterministically (no fixed-sleep flakiness).
    async fn wait_until_pending(approvals: &Approvals) {
        for _ in 0..200 {
            if approvals.pending_count() > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("approval never registered as pending");
    }

    #[tokio::test]
    async fn create_and_wait_resolves_on_respond() {
        let approvals = Approvals::new();
        let exec = Uuid::new_v4();
        let request = ApprovalRequest::new("Bash".to_string(), exec);
        let id = request.id.clone();

        let task = {
            let approvals = approvals.clone();
            tokio::spawn(async move { approvals.create_and_wait(request, false).await })
        };

        wait_until_pending(&approvals).await;
        approvals
            .respond(
                &id,
                ApprovalResponse {
                    execution_process_id: exec,
                    status: ApprovalOutcome::Approved,
                },
            )
            .await
            .unwrap();

        let outcome = task.await.unwrap().unwrap();
        assert!(matches!(outcome, ApprovalOutcome::Approved));
    }

    #[tokio::test]
    async fn cancel_for_execution_process_resolves_waiter_as_denied() {
        let approvals = Approvals::new();
        let exec = Uuid::new_v4();
        let request = ApprovalRequest::new("Bash".to_string(), exec);

        let task = {
            let approvals = approvals.clone();
            tokio::spawn(async move { approvals.create_and_wait(request, false).await })
        };

        wait_until_pending(&approvals).await;
        approvals.cancel_for_execution_process(exec);

        let outcome = task.await.unwrap().unwrap();
        assert!(matches!(outcome, ApprovalOutcome::Denied { .. }));
        assert_eq!(approvals.pending_count(), 0);
    }
}
