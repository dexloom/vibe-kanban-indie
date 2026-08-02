use axum::{
    Router,
    extract::ws::Message,
    extract::{Path, Request, State, ws::rejection::WebSocketUpgradeRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::any,
};
use deployment::Deployment;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

use crate::{
    DeploymentImpl,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

pub(super) fn api_router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/preview/{target_port}", any(proxy_preview_request_no_tail))
        .route("/preview/{target_port}/{*tail}", any(proxy_preview_request))
}

pub fn subdomain_router(deployment: DeploymentImpl) -> Router {
    Router::new()
        .fallback(subdomain_proxy_request)
        .with_state(deployment)
}

async fn proxy_preview_request_no_tail(
    State(deployment): State<DeploymentImpl>,
    Path(target_port): Path<u16>,
    ws_upgrade: Result<SignedWsUpgrade, WebSocketUpgradeRejection>,
    request: Request,
) -> Response {
    match ws_upgrade {
        Ok(ws) => forward_preview_ws(ws, target_port, String::new(), request).await,
        Err(rejection) => {
            preview_proxy::api::proxy_api_request(
                deployment.preview_proxy(),
                target_port,
                String::new(),
                Err(rejection),
                request,
            )
            .await
        }
    }
}

async fn proxy_preview_request(
    State(deployment): State<DeploymentImpl>,
    Path((target_port, tail)): Path<(u16, String)>,
    ws_upgrade: Result<SignedWsUpgrade, WebSocketUpgradeRejection>,
    request: Request,
) -> Response {
    match ws_upgrade {
        Ok(ws) => forward_preview_ws(ws, target_port, tail, request).await,
        Err(rejection) => {
            preview_proxy::api::proxy_api_request(
                deployment.preview_proxy(),
                target_port,
                tail,
                Err(rejection),
                request,
            )
            .await
        }
    }
}

async fn forward_preview_ws(
    ws: SignedWsUpgrade,
    target_port: u16,
    tail: String,
    request: Request,
) -> Response {
    let query = request.uri().query().unwrap_or_default();
    let normalized = tail.trim_start_matches('/');
    let ws_url = if normalized.is_empty() {
        format!("ws://localhost:{target_port}/?{query}")
    } else if query.is_empty() {
        format!("ws://localhost:{target_port}/{normalized}")
    } else {
        format!("ws://localhost:{target_port}/{normalized}?{query}")
    };

    let protocols = request
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned);

    let mut ws_request = match ws_url.into_client_request() {
        Ok(r) => r,
        Err(error) => {
            tracing::warn!(?error, "Invalid preview upstream WebSocket URL");
            return (StatusCode::BAD_REQUEST, "Invalid WebSocket URL").into_response();
        }
    };

    if let Some(protocols) = protocols.as_deref().filter(|p| !p.trim().is_empty())
        && let Ok(header_value) = protocols.parse::<axum::http::HeaderValue>()
    {
        ws_request
            .headers_mut()
            .insert("sec-websocket-protocol", header_value);
    }

    let (upstream_ws, response) = match tokio_tungstenite::connect_async(ws_request).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(?error, "Failed to connect preview upstream WebSocket");
            return (StatusCode::BAD_GATEWAY, "Preview WebSocket unavailable").into_response();
        }
    };
    let selected_protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);

    let ws = if let Some(protocol) = selected_protocol {
        ws.protocols([protocol])
    } else {
        ws
    };

    ws.on_upgrade(move |client| async move {
        if let Err(error) = bridge_ws(client, upstream_ws).await {
            tracing::debug!(?error, "Preview WS bridge closed with error");
        }
    })
    .into_response()
}

async fn bridge_ws(
    client: MaybeSignedWebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Result<(), String> {
    let (mut client_sink, mut client_stream) = client.split();
    let (mut upstream_sink, mut upstream_stream) = upstream.split();

    let client_to_upstream = async {
        while let Some(msg) = client_stream.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            if let Some(outgoing) = axum_to_tungstenite(msg) {
                upstream_sink
                    .send(outgoing)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                break;
            }
        }
        let _ = upstream_sink.close().await;
        Ok::<(), String>(())
    };

    let upstream_to_client = async {
        while let Some(msg) = upstream_stream.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            if let Some(incoming) = tungstenite_to_axum(msg) {
                client_sink
                    .send(incoming)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                break;
            }
        }
        let _ = client_sink.close().await;
        Ok::<(), String>(())
    };

    tokio::select! {
        result = client_to_upstream => result,
        result = upstream_to_client => result,
    }
}

fn axum_to_tungstenite(msg: Message) -> Option<tungstenite::Message> {
    match msg {
        Message::Text(text) => Some(tungstenite::Message::Text(text.to_string().into())),
        Message::Binary(bytes) => Some(tungstenite::Message::Binary(bytes.to_vec().into())),
        Message::Ping(bytes) => Some(tungstenite::Message::Ping(bytes.to_vec().into())),
        Message::Pong(bytes) => Some(tungstenite::Message::Pong(bytes.to_vec().into())),
        Message::Close(_) => None,
    }
}

fn tungstenite_to_axum(msg: tungstenite::Message) -> Option<Message> {
    match msg {
        tungstenite::Message::Text(text) => Some(Message::Text(text.to_string().into())),
        tungstenite::Message::Binary(bytes) => Some(Message::Binary(bytes.to_vec().into())),
        tungstenite::Message::Ping(bytes) => Some(Message::Ping(bytes.to_vec().into())),
        tungstenite::Message::Pong(bytes) => Some(Message::Pong(bytes.to_vec().into())),
        tungstenite::Message::Close(_) => None,
        tungstenite::Message::Frame(_) => Some(Message::Binary(vec![].into())),
    }
}

async fn subdomain_proxy_request(
    State(deployment): State<DeploymentImpl>,
    request: Request,
) -> Response {
    let Some(server_addr) = deployment.client_info().get_server_addr() else {
        return (
            StatusCode::BAD_REQUEST,
            "Local server address is not available",
        )
            .into_response();
    };

    let Some(proxy_port) = deployment.client_info().get_preview_proxy_port() else {
        return (
            StatusCode::BAD_REQUEST,
            "Preview proxy port is not available",
        )
            .into_response();
    };

    preview_proxy::proxy_subdomain_request(
        deployment.preview_proxy(),
        server_addr,
        proxy_port,
        request,
    )
    .await
}
