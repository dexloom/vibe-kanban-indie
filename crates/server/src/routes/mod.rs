//! Route boundary rule (ADR-016 follow-up).
//!
//! MCP-facing routes live under `/api/*` and return the `ApiResponse`
//! envelope (`{ success, data, message }`). The MCP client deserializes
//! every response into `ApiResponseEnvelope<T>` and rejects anything
//! missing the `success` field — a `/api/*` route returning a bare shape
//! silently breaks the MCP tool at runtime (the original P0 bug; the
//! orchestrator-prompt endpoints shipped this way for one cycle before
//! being moved here).
//!
//! Frontend-fallback routes live under `/v1/*` and return bare shapes
//! (`{ "<table>": [...] }` for reads) or `MutationResponse<T>`
//! (`{ data, txid }`) for writes. The frontend's fallback transport
//! reads these directly via `makeRequest` without an envelope check.
//!
//! **Rule**: a route needed by BOTH consumers (MCP tool AND frontend
//! fallback) MUST be defined on `/api/*` (envelope-wrapped) and consumed
//! by the frontend through `handleApiResponse` (which expects the
//! envelope). Defining it on `/v1/*` would be a wire-format regression
//! for the MCP consumer. The orchestrator-prompt endpoints are the
//! canonical example.

use axum::{
    Router,
    routing::{IntoMakeService, get},
};
use tower_http::{compression::CompressionLayer, validate_request::ValidateRequestHeaderLayer};

use crate::{DeploymentImpl, middleware};

pub mod approvals;
pub mod attachments;
pub mod config;
pub mod events;
pub mod execution_processes;
pub mod filesystem;
pub mod frontend;
pub mod health;
pub mod kanban;
pub mod local_kanban;
pub mod pipelines;
pub mod preview;
pub mod recurrent;
pub mod repo;
pub mod scratch;
pub mod search;
pub mod sessions;
pub mod spec_intake;
pub mod speckit;
pub mod tags;
pub mod telegram;
pub mod terminal;
pub mod workspaces;

pub fn router(deployment: DeploymentImpl) -> IntoMakeService<Router> {
    let api_routes = Router::new()
        .route("/health", get(health::health_check))
        .merge(config::router())
        .merge(pipelines::router())
        .merge(recurrent::router())
        .merge(kanban::router(&deployment))
        .merge(workspaces::router(&deployment))
        .merge(execution_processes::router(&deployment))
        .merge(tags::router(&deployment))
        .merge(telegram::router())
        .merge(filesystem::router())
        .merge(repo::router())
        .merge(events::router(&deployment))
        .merge(approvals::router())
        .merge(scratch::router(&deployment))
        .merge(search::router(&deployment))
        .merge(preview::api_router())
        .merge(sessions::router(&deployment))
        .merge(spec_intake::router(&deployment))
        .merge(speckit::router(&deployment))
        .merge(terminal::router())
        .nest("/attachments", attachments::routes())
        .layer(ValidateRequestHeaderLayer::custom(
            middleware::validate_origin,
        ))
        .layer(axum::middleware::from_fn(middleware::log_server_errors))
        .with_state(deployment.clone());

    // Local kanban API. Served at the root (`/v1/*`) because the frontend's
    // fallback transport hits absolute `/v1/...` paths, not `/api/...`.
    let v1_routes = local_kanban::router()
        .layer(ValidateRequestHeaderLayer::custom(
            middleware::validate_origin,
        ))
        .layer(axum::middleware::from_fn(middleware::log_server_errors))
        .with_state(deployment);

    Router::new()
        .route("/", get(frontend::serve_frontend_root))
        .route("/{*path}", get(frontend::serve_frontend))
        .nest("/api", api_routes)
        .merge(v1_routes)
        .layer(CompressionLayer::new())
        // Outermost layer, and deliberately so: the Host guard has to see
        // every request before anything else does — `/api/*`, `/v1/*`,
        // WebSocket upgrades and the embedded frontend's static files alike.
        // Adding it per-sub-router (as the Origin check is) would leave the
        // static routes uncovered. A reverse proxy cannot stand in for this:
        // the rebound request comes from a browser inside the perimeter and
        // goes straight to this port, never traversing the edge. See
        // `middleware::origin`.
        .layer(ValidateRequestHeaderLayer::custom(
            middleware::validate_host,
        ))
        .into_make_service()
}
