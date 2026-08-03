use axum::{
    body::Body,
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use reqwest::{StatusCode, header};
use rust_embed::RustEmbed;
use std::path::Path;

#[derive(RustEmbed)]
#[folder = "../../packages/local-web/dist"]
struct Assets;

pub(super) async fn serve_frontend(uri: axum::extract::Path<String>) -> impl IntoResponse {
    let path = uri.trim_start_matches('/');
    serve_file(path).await
}

pub(super) async fn serve_frontend_root() -> impl IntoResponse {
    serve_file("index.html").await
}

/// When `VK_FRONTEND_DIR` is set, the built web UI is served from that
/// directory on disk instead of the copy compiled into the binary. The dev
/// loop can then tweak the UI and rebuild only the frontend
/// (`npm run build` in packages/local-web) without recompiling the heavy
/// backend. Unset (default) keeps the embedded assets.
fn frontend_dir() -> Option<std::path::PathBuf> {
    std::env::var("VK_FRONTEND_DIR")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .map(std::path::PathBuf::from)
}

async fn serve_file_from_disk(dir: &Path, path: &str) -> Option<Response> {
    // Resolve the candidate against the canonicalized frontend dir and refuse
    // anything that escapes it — this blocks `..`, absolute paths, and symlink
    // traversal, not just a literal `..` segment.
    let canonical_dir = dir.canonicalize().ok()?;
    let candidate = dir.join(path.trim_start_matches('/'));
    let file_path = if candidate.is_file() {
        candidate
    } else {
        // SPA fallback: unknown routes serve index.html.
        let index = dir.join("index.html");
        if !index.is_file() {
            return None;
        }
        index
    };

    let canonical = file_path.canonicalize().ok()?;
    if !canonical.starts_with(&canonical_dir) {
        return None;
    }

    let bytes = tokio::fs::read(&canonical).await.ok()?;
    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_str(mime.as_ref()).unwrap(),
            )
            .body(Body::from(bytes))
            .unwrap(),
    )
}

async fn serve_file(path: &str) -> impl IntoResponse + use<> {
    if let Some(dir) = frontend_dir()
        && let Some(response) = serve_file_from_disk(&dir, path).await
    {
        return response;
    }

    let file = Assets::get(path);

    match file {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();

            Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref()).unwrap(),
                )
                .body(Body::from(content.data.into_owned()))
                .unwrap()
        }
        None => {
            // For SPA routing, serve index.html for unknown routes
            if let Some(index) = Assets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))
                    .body(Body::from(index.data.into_owned()))
                    .unwrap()
            } else {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("404 Not Found"))
                    .unwrap()
            }
        }
    }
}
