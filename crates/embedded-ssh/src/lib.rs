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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use rand::rngs::OsRng;
    use russh::{ChannelMsg, client};
    use russh_keys::{PrivateKey, ssh_key::Algorithm};
    use tokio::io::{AsyncRead, AsyncWrite};

    use super::*;
    use crate::config::build_config;

    #[derive(Clone)]
    struct TestClient {}

    #[async_trait]
    impl client::Handler for TestClient {
        type Error = anyhow::Error;

        async fn check_server_key(
            &mut self,
            _server_public_key: &ssh_key::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    async fn run_echo_over_tunnel(
        client_side: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
        server_side: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    ) -> String {
        let dir = tempfile::tempdir().expect("tempdir");
        let server_config = build_config(&dir.path().join("host_key"));

        tokio::spawn(async move {
            let _ = run_ssh_session(server_side, server_config).await;
        });

        let client_config = Arc::new(client::Config::default());
        let mut session = client::connect_stream(client_config, client_side, TestClient {})
            .await
            .expect("ssh client connects");

        let client_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).expect("random key");
        let authenticated = session
            .authenticate_publickey("local", Arc::new(client_key))
            .await
            .expect("authenticate");
        assert!(authenticated, "server must accept any Ed25519 key");

        let mut channel = session.channel_open_session().await.expect("open channel");
        channel
            .exec(true, "printf 'tunnel-ok\\n'")
            .await
            .expect("exec");

        let mut output = String::new();
        let mut exit_code = None;
        loop {
            let msg = channel.wait().await.expect("channel message");
            match msg {
                ChannelMsg::Data { data } => output.push_str(&String::from_utf8_lossy(&data)),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
            if exit_code.is_some() {
                break;
            }
        }

        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
        output
    }

    #[tokio::test]
    async fn exec_runs_over_ssh_tunnel() {
        let (client_side, server_side) = tokio::io::duplex(65536);
        let output = run_echo_over_tunnel(client_side, server_side).await;
        assert!(
            output.contains("tunnel-ok"),
            "expected exec output over tunnel, got: {output:?}"
        );
    }
}
