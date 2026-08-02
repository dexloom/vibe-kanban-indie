pub mod config;
pub mod handler;
pub mod sftp;

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

/// Run an SSH server session over the given stream.
///
/// The stream is typically an axum WebSocket wrapped in `AxumWsStreamIo`.
pub async fn run_ssh_session(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    config: Arc<russh::server::Config>,
) -> anyhow::Result<()> {
    let handler = handler::SshSessionHandler::new();
    let session = russh::server::run_stream(config, stream, handler).await?;
    session.await?;
    Ok(())
}
