//! HTTP routes for the file-based card pipelines
//! (`~/.vibe-kanban/pipelines/*.toml`). These feed the New Issue pipeline
//! picker and the Settings → Pipeline editor. Parsing/validation lives in
//! `services::services::pipelines`; these handlers just map results to the
//! standard `ApiResponse` envelope (matching `config.rs`).

use axum::{
    Json, Router,
    extract::Path,
    response::Json as ResponseJson,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use services::services::pipelines::{self as pl, Pipeline, PipelineError};
use ts_rs::TS;
use utils::{path::pipelines_dir, response::ApiResponse};

use crate::DeploymentImpl;

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/pipelines", get(list_pipelines))
        .route("/pipelines/reset-defaults", post(reset_defaults))
        .route(
            "/pipelines/{id}/raw",
            get(get_pipeline_raw).put(put_pipeline_raw),
        )
        .route("/pipelines/{id}/reset", post(reset_pipeline))
        .route("/pipelines/{id}", axum::routing::delete(delete_pipeline))
}

/// Raw-TOML body for `PUT /pipelines/{id}/raw`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct PipelineRawBody {
    pub content: String,
}

/// Human-readable message for a pipeline error (surfaced to Settings Save, etc.).
fn err_message(e: &PipelineError) -> String {
    e.to_string()
}

async fn list_pipelines() -> ResponseJson<ApiResponse<Vec<Pipeline>>> {
    ResponseJson(ApiResponse::success(pl::load_pipelines(&pipelines_dir())))
}

async fn get_pipeline_raw(Path(id): Path<String>) -> ResponseJson<ApiResponse<String>> {
    match pl::read_raw(&pipelines_dir(), &id) {
        Ok(content) => ResponseJson(ApiResponse::success(content)),
        Err(e) => ResponseJson(ApiResponse::error(&err_message(&e))),
    }
}

async fn put_pipeline_raw(
    Path(id): Path<String>,
    Json(body): Json<PipelineRawBody>,
) -> ResponseJson<ApiResponse<Pipeline>> {
    match pl::write_raw(&pipelines_dir(), &id, &body.content) {
        Ok(pipeline) => ResponseJson(ApiResponse::success(pipeline)),
        Err(e) => ResponseJson(ApiResponse::error(&err_message(&e))),
    }
}

async fn reset_pipeline(Path(id): Path<String>) -> ResponseJson<ApiResponse<Pipeline>> {
    match pl::reset_one(&pipelines_dir(), &id) {
        Ok(pipeline) => ResponseJson(ApiResponse::success(pipeline)),
        Err(e) => ResponseJson(ApiResponse::error(&err_message(&e))),
    }
}

async fn reset_defaults() -> ResponseJson<ApiResponse<Vec<Pipeline>>> {
    match pl::reset_all(&pipelines_dir()) {
        Ok(pipelines) => ResponseJson(ApiResponse::success(pipelines)),
        Err(e) => ResponseJson(ApiResponse::error(&err_message(&e))),
    }
}

async fn delete_pipeline(Path(id): Path<String>) -> ResponseJson<ApiResponse<()>> {
    match pl::delete_pipeline(&pipelines_dir(), &id) {
        Ok(()) => ResponseJson(ApiResponse::success(())),
        Err(e) => ResponseJson(ApiResponse::error(&err_message(&e))),
    }
}
