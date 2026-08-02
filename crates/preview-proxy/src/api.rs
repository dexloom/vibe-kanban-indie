use axum::{
    body::{Body, to_bytes},
    extract::{
        Request,
        ws::{WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use utils::http_headers::is_hop_by_hop_header;

use crate::{
    PreviewProxyService,
    proxy_common::{build_local_upstream_url, extract_ws_protocols, should_forward_request_header},
};

type MaybeWsUpgrade = Result<WebSocketUpgrade, WebSocketUpgradeRejection>;

pub async fn proxy_api_request(
    service: &PreviewProxyService,
    target_port: u16,
    tail: String,
    ws_upgrade: MaybeWsUpgrade,
    request: Request,
) -> Response {
    match ws_upgrade {
        Ok(ws_upgrade) => forward_ws(target_port, tail, request, ws_upgrade).await,
        Err(_) => forward_http(service, target_port, tail, request).await,
    }
}

async fn forward_http(
    service: &PreviewProxyService,
    target_port: u16,
    tail: String,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let method = parts.method;
    let headers = parts.headers;
    let query = parts.uri.query().unwrap_or_default();
    let target_url = build_local_upstream_url("http", target_port, &tail, query);

    let client = service.http_client();
    let mut req_builder = client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &target_url,
    );

    for (name, value) in &headers {
        if should_forward_request_header(name.as_str())
            && let Ok(v) = value.to_str()
        {
            req_builder = req_builder.header(name.as_str(), v);
        }
    }

    req_builder = req_builder.header("Accept-Encoding", "identity");

    let body_bytes = match to_bytes(body, 50 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(?error, "Failed to read preview route request body");
            return (StatusCode::BAD_REQUEST, "Invalid request body").into_response();
        }
    };

    if !body_bytes.is_empty() {
        req_builder = req_builder.body(body_bytes.to_vec());
    }

    let response = match req_builder.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!(?error, %target_url, "Failed to call preview upstream");
            return (StatusCode::BAD_GATEWAY, "Preview upstream unavailable").into_response();
        }
    };

    relay_http_response(response)
}

async fn forward_ws(
    target_port: u16,
    tail: String,
    request: Request,
    ws_upgrade: WebSocketUpgrade,
) -> Response {
    let query = request.uri().query().unwrap_or_default();
    let ws_url = build_local_upstream_url("ws", target_port, &tail, query);
    let protocols = extract_ws_protocols(request.headers());

    let mut ws_request = match ws_url.into_client_request() {
        Ok(r) => r,
        Err(error) => {
            tracing::debug!(?error, "Failed to build preview upstream WebSocket request");
            return (StatusCode::BAD_REQUEST, "Invalid WebSocket URL").into_response();
        }
    };
    if let Some(protocols) = protocols.as_deref().filter(|p| !p.trim().is_empty())
        && let Ok(header_value) = protocols.parse()
    {
        ws_request
            .headers_mut()
            .insert("sec-websocket-protocol", header_value);
    }

    let (upstream_ws, response) = match tokio_tungstenite::connect_async(ws_request).await {
        Ok(value) => value,
        Err(error) => {
            tracing::debug!(?error, "Failed to connect preview upstream WebSocket");
            return (StatusCode::BAD_GATEWAY, "Preview WebSocket unavailable").into_response();
        }
    };
    let selected_protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);

    let mut ws = ws_upgrade;
    if let Some(protocol) = &selected_protocol {
        ws = ws.protocols([protocol.clone()]);
    }

    ws.on_upgrade(move |client_socket| async move {
        if let Err(error) = bridge_ws(client_socket, upstream_ws).await {
            tracing::debug!(?error, "Preview upstream WS bridge closed with error");
        }
    })
    .into_response()
}

type UpstreamWs = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn bridge_ws(
    client: axum::extract::ws::WebSocket,
    upstream: UpstreamWs,
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
                client_sink.send(incoming).await.map_err(|e| e.to_string())?;
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

fn axum_to_tungstenite(msg: axum::extract::ws::Message) -> Option<tungstenite::Message> {
    match msg {
        axum::extract::ws::Message::Text(text) => Some(tungstenite::Message::Text(text.to_string().into())),
        axum::extract::ws::Message::Binary(bytes) => Some(tungstenite::Message::Binary(bytes.to_vec().into())),
        axum::extract::ws::Message::Ping(bytes) => Some(tungstenite::Message::Ping(bytes.to_vec().into())),
        axum::extract::ws::Message::Pong(bytes) => Some(tungstenite::Message::Pong(bytes.to_vec().into())),
        axum::extract::ws::Message::Close(_) => None,
    }
}

fn tungstenite_to_axum(msg: tungstenite::Message) -> Option<axum::extract::ws::Message> {
    match msg {
        tungstenite::Message::Text(text) => Some(axum::extract::ws::Message::Text(text.to_string().into())),
        tungstenite::Message::Binary(bytes) => Some(axum::extract::ws::Message::Binary(bytes.to_vec().into())),
        tungstenite::Message::Ping(bytes) => Some(axum::extract::ws::Message::Ping(bytes.to_vec().into())),
        tungstenite::Message::Pong(bytes) => Some(axum::extract::ws::Message::Pong(bytes.to_vec().into())),
        tungstenite::Message::Close(_) => None,
        tungstenite::Message::Frame(_) => Some(axum::extract::ws::Message::Binary(vec![].into())),
    }
}

fn relay_http_response(response: reqwest::Response) -> Response {
    let status = response.status();
    let response_headers = response.headers().clone();
    let body = Body::from_stream(response.bytes_stream());

    let mut builder = Response::builder().status(status);
    for (name, value) in &response_headers {
        if !is_hop_by_hop_header(name.as_str()) {
            builder = builder.header(name, value);
        }
    }

    builder.body(body).unwrap_or_else(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to build preview route response",
        )
            .into_response()
    })
}
