//! HTTP routes for the file-based recurrent task catalog
//! (`~/.vibe-kanban/recurrent/*.toml`) and its run-now action. Parsing/
//! validation/spawn logic lives in `services::services::recurrent`; these
//! handlers map results to the standard `ApiResponse` envelope, mirroring
//! `routes::pipelines`.

use axum::{
    Json, Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, post},
};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    workspace::Workspace,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use services::services::recurrent::{
    self as rec, RecurrentError, Routine, RoutineLastRun,
    spawn::{SpawnOutcome, spawn_routine_run},
};
use sqlx::SqlitePool;
use ts_rs::TS;
use utils::{path::recurrent_dir, response::ApiResponse};
use uuid::Uuid;

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/recurrent", get(list_routines))
        .route(
            "/recurrent/{id}/raw",
            get(get_routine_raw).put(put_routine_raw),
        )
        .route("/recurrent/{id}/enable", post(enable_routine))
        .route("/recurrent/{id}/disable", post(disable_routine))
        .route("/recurrent/{id}/run", post(run_routine))
        .route("/recurrent/{id}", axum::routing::delete(delete_routine))
}

/// Raw-TOML body for `PUT /recurrent/{id}/raw`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct RecurrentRawBody {
    pub content: String,
}

/// Structured TOML error surfaced to the Settings editor: the write was
/// rejected (parse/validation failure) and the prior file on disk is
/// untouched.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct RecurrentTomlError {
    pub message: String,
}

/// Response for `POST /recurrent/{id}/run`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct RunRoutineResponse {
    /// `false` when a previous run was still active and nothing new was
    /// spawned (`SpawnOutcome::SkippedActive`).
    pub spawned: bool,
    pub workspace_id: Option<Uuid>,
}

fn toml_err(e: RecurrentError) -> RecurrentTomlError {
    RecurrentTomlError {
        message: e.to_string(),
    }
}

/// Map an execution process status to the routine's `last_run.status`
/// string (lowercase, matching the DB/serde representation).
fn status_str(status: &ExecutionProcessStatus) -> String {
    match status {
        ExecutionProcessStatus::Running => "running",
        ExecutionProcessStatus::Completed => "completed",
        ExecutionProcessStatus::Failed => "failed",
        ExecutionProcessStatus::Killed => "killed",
    }
    .to_string()
}

/// Enrich a routine with `last_run`, sourced from the DB rather than the
/// TOML: the routine's persistent workspace (if any) and its most recent
/// coding-agent execution process.
async fn enrich_last_run(pool: &SqlitePool, routine: Routine) -> Routine {
    let Ok(Some(workspace)) = Workspace::find_recurrent_by_name(pool, &routine.id).await else {
        return routine;
    };
    let Ok(Some(process)) = ExecutionProcess::find_latest_by_workspace_and_run_reason(
        pool,
        workspace.id,
        &ExecutionProcessRunReason::CodingAgent,
    )
    .await
    else {
        return routine;
    };
    let at = process.completed_at.unwrap_or(process.started_at);
    Routine {
        last_run: Some(RoutineLastRun {
            status: status_str(&process.status),
            at,
            workspace_id: workspace.id,
        }),
        ..routine
    }
}

async fn list_routines(
    State(deployment): State<DeploymentImpl>,
) -> ResponseJson<ApiResponse<Vec<Routine>>> {
    let routines = rec::load_routines(&recurrent_dir());
    let pool = &deployment.db().pool;
    let mut enriched = Vec::with_capacity(routines.len());
    for routine in routines {
        enriched.push(enrich_last_run(pool, routine).await);
    }
    ResponseJson(ApiResponse::success(enriched))
}

async fn get_routine_raw(Path(id): Path<String>) -> ResponseJson<ApiResponse<String>> {
    match rec::read_raw(&recurrent_dir(), &id) {
        Ok(content) => ResponseJson(ApiResponse::success(content)),
        Err(e) => ResponseJson(ApiResponse::error(&e.to_string())),
    }
}

async fn put_routine_raw(
    Path(id): Path<String>,
    Json(body): Json<RecurrentRawBody>,
) -> ResponseJson<ApiResponse<Routine, RecurrentTomlError>> {
    match rec::write_raw(&recurrent_dir(), &id, &body.content) {
        Ok(routine) => ResponseJson(ApiResponse::success(routine)),
        Err(e) => ResponseJson(ApiResponse::error_with_data(toml_err(e))),
    }
}

async fn enable_routine(Path(id): Path<String>) -> ResponseJson<ApiResponse<Routine>> {
    match rec::set_enabled(&recurrent_dir(), &id, true) {
        Ok(routine) => ResponseJson(ApiResponse::success(routine)),
        Err(e) => ResponseJson(ApiResponse::error(&e.to_string())),
    }
}

async fn disable_routine(Path(id): Path<String>) -> ResponseJson<ApiResponse<Routine>> {
    match rec::set_enabled(&recurrent_dir(), &id, false) {
        Ok(routine) => ResponseJson(ApiResponse::success(routine)),
        Err(e) => ResponseJson(ApiResponse::error(&e.to_string())),
    }
}

async fn run_routine(
    State(deployment): State<DeploymentImpl>,
    Path(id): Path<String>,
) -> ResponseJson<ApiResponse<RunRoutineResponse>> {
    let dir = recurrent_dir();
    let routine = match rec::read_raw(&dir, &id).and_then(|raw| rec::parse_routine(&id, &raw)) {
        Ok(routine) => routine,
        Err(e) => return ResponseJson(ApiResponse::error(&e.to_string())),
    };

    match spawn_routine_run(deployment.container(), &routine).await {
        Ok(SpawnOutcome::Spawned(workspace, _process)) => {
            ResponseJson(ApiResponse::success(RunRoutineResponse {
                spawned: true,
                workspace_id: Some(workspace.id),
            }))
        }
        Ok(SpawnOutcome::SkippedActive) => ResponseJson(ApiResponse::success(RunRoutineResponse {
            spawned: false,
            workspace_id: None,
        })),
        Err(e) => ResponseJson(ApiResponse::error(&e.to_string())),
    }
}

async fn delete_routine(Path(id): Path<String>) -> ResponseJson<ApiResponse<()>> {
    match rec::delete_routine(&recurrent_dir(), &id) {
        Ok(()) => ResponseJson(ApiResponse::success(())),
        Err(e) => ResponseJson(ApiResponse::error(&e.to_string())),
    }
}
