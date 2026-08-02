use std::{
    io,
    marker::PhantomData,
    pin::Pin,
    task::{Context, Poll, ready},
};

use axum::{
    extract::ws::{Message as AxumWsMessage, WebSocket as AxumWebSocket},
    extract::State,
    response::IntoResponse,
};
use bytes::BytesMut;
use deployment::Deployment;
use futures::{Sink, Stream};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{DeploymentImpl, middleware::signed_ws::MaybeSignedWebSocket, middleware::signed_ws::SignedWsUpgrade};

pub(super) async fn ssh_session_ws(
    State(deployment): State<DeploymentImpl>,
    ws: SignedWsUpgrade,
) -> impl IntoResponse {
    let ssh_config = deployment.ssh_config().clone();

    ws.on_upgrade(move |socket| async move {
        let stream = axum_ws_stream_io(socket);
        if let Err(error) = embedded_ssh::run_ssh_session(stream, ssh_config).await {
            tracing::warn!(?error, "SSH session failed");
        }
    })
}

pub enum WsIoReadMessage {
    Data(Vec<u8>),
    Skip,
    Eof,
}

pub struct WsMessageStreamIo<S, M, FRead, FWrite> {
    ws: S,
    read_buf: BytesMut,
    flushing: bool,
    read_message: FRead,
    write_message: FWrite,
    _message: PhantomData<fn() -> M>,
}

impl<S, M, FRead, FWrite> WsMessageStreamIo<S, M, FRead, FWrite> {
    pub fn new(ws: S, read_message: FRead, write_message: FWrite) -> Self {
        Self {
            ws,
            read_buf: BytesMut::new(),
            flushing: false,
            read_message,
            write_message,
            _message: PhantomData,
        }
    }
}

impl<S, M, E, FRead, FWrite> AsyncRead for WsMessageStreamIo<S, M, FRead, FWrite>
where
    S: Stream<Item = Result<M, E>> + Unpin,
    E: std::fmt::Display,
    FRead: Fn(M) -> WsIoReadMessage + Unpin,
    FWrite: Fn(Vec<u8>) -> M + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let this = self.as_mut().get_mut();

            if !this.read_buf.is_empty() {
                let n = buf.remaining().min(this.read_buf.len());
                buf.put_slice(&this.read_buf.split_to(n));
                return Poll::Ready(Ok(()));
            }

            let message = match ready!(Pin::new(&mut this.ws).poll_next(cx)) {
                Some(Ok(message)) => message,
                Some(Err(error)) => return Poll::Ready(Err(io::Error::other(error.to_string()))),
                None => return Poll::Ready(Ok(())),
            };

            match (this.read_message)(message) {
                WsIoReadMessage::Data(data) => this.read_buf.extend_from_slice(&data),
                WsIoReadMessage::Skip => continue,
                WsIoReadMessage::Eof => return Poll::Ready(Ok(())),
            }
        }
    }
}

impl<S, M, E, FRead, FWrite> AsyncWrite for WsMessageStreamIo<S, M, FRead, FWrite>
where
    S: Sink<M, Error = E> + Unpin,
    E: std::fmt::Display,
    FRead: Fn(M) -> WsIoReadMessage + Unpin,
    FWrite: Fn(Vec<u8>) -> M + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }

        let this = self.as_mut().get_mut();
        if !this.flushing {
            ready!(Pin::new(&mut this.ws).poll_ready(cx))
                .map_err(|error| io::Error::other(error.to_string()))?;
            Pin::new(&mut this.ws)
                .start_send((this.write_message)(buf.to_vec()))
                .map_err(|error| io::Error::other(error.to_string()))?;
            this.flushing = true;
        }

        ready!(Pin::new(&mut this.ws).poll_flush(cx))
            .map_err(|error| io::Error::other(error.to_string()))?;
        this.flushing = false;

        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        ready!(Pin::new(&mut this.ws).poll_flush(cx))
            .map_err(|error| io::Error::other(error.to_string()))?;
        this.flushing = false;
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        ready!(Pin::new(&mut this.ws).poll_close(cx))
            .map_err(|error| io::Error::other(error.to_string()))?;
        this.flushing = false;
        Poll::Ready(Ok(()))
    }
}

pub fn axum_ws_stream_io(ws: MaybeSignedWebSocket) -> WsMessageStreamIo<
    MaybeSignedWebSocket,
    AxumWsMessage,
    fn(AxumWsMessage) -> WsIoReadMessage,
    fn(Vec<u8>) -> AxumWsMessage,
> {
    WsMessageStreamIo::new(ws, read_axum_message, write_axum_message)
}

fn read_axum_message(message: AxumWsMessage) -> WsIoReadMessage {
    match message {
        AxumWsMessage::Binary(data) => WsIoReadMessage::Data(data.to_vec()),
        AxumWsMessage::Text(text) => WsIoReadMessage::Data(text.as_bytes().to_vec()),
        AxumWsMessage::Close(_) => WsIoReadMessage::Eof,
        _ => WsIoReadMessage::Skip,
    }
}

fn write_axum_message(bytes: Vec<u8>) -> AxumWsMessage {
    AxumWsMessage::Binary(bytes.into())
}

// Touch unused symbols so the compiler keeps the helpers available for downstream
// crates that may share this surface (e.g. tests).
#[allow(dead_code)]
fn _silence_unused(_ws: AxumWebSocket) -> AxumWebSocket {
    _ws
}
