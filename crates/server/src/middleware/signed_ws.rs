use std::{
    borrow::Cow,
    pin::Pin,
    task::{Context, Poll},
};

use axum::{
    extract::{
        FromRef, FromRequestParts,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::request::Parts,
    response::IntoResponse,
};
use deployment::Deployment;
use futures_util::{Sink, SinkExt, Stream, StreamExt};

use crate::DeploymentImpl;

pub struct SignedWsUpgrade {
    ws: WebSocketUpgrade,
}

impl<S> FromRequestParts<S> for SignedWsUpgrade
where
    S: Send + Sync,
    DeploymentImpl: FromRef<S>,
{
    type Rejection = axum::extract::ws::rejection::WebSocketUpgradeRejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let ws = WebSocketUpgrade::from_request_parts(parts, state).await?;
        Ok(Self { ws })
    }
}

impl SignedWsUpgrade {
    pub fn protocols<I>(mut self, protocols: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<Cow<'static, str>>,
    {
        self.ws = self.ws.protocols(protocols);
        self
    }

    pub fn on_upgrade<F, Fut>(self, callback: F) -> impl IntoResponse
    where
        F: FnOnce(MaybeSignedWebSocket) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.ws.on_upgrade(move |socket| async move {
            callback(MaybeSignedWebSocket {
                inner: WebSocketInner::Plain(Box::new(socket)),
            })
            .await;
        })
    }
}

enum WebSocketInner {
    Plain(Box<WebSocket>),
}

pub struct MaybeSignedWebSocket {
    inner: WebSocketInner,
}

impl MaybeSignedWebSocket {
    pub async fn send(&mut self, message: Message) -> anyhow::Result<()> {
        match &mut self.inner {
            WebSocketInner::Plain(ws) => SinkExt::send(ws, message)
                .await
                .map_err(anyhow::Error::from),
        }
    }

    pub async fn recv(&mut self) -> anyhow::Result<Option<Message>> {
        match &mut self.inner {
            WebSocketInner::Plain(ws) => match ws.next().await {
                Some(Ok(msg)) => Ok(Some(msg)),
                Some(Err(e)) => Err(anyhow::Error::from(e)),
                None => Ok(None),
            },
        }
    }

    pub async fn close(&mut self) -> anyhow::Result<()> {
        match &mut self.inner {
            WebSocketInner::Plain(ws) => SinkExt::close(ws).await.map_err(anyhow::Error::from),
        }
    }
}

impl Stream for MaybeSignedWebSocket {
    type Item = Result<Message, anyhow::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match &mut this.inner {
            WebSocketInner::Plain(ws) => Pin::new(ws)
                .poll_next(cx)
                .map(|opt| opt.map(|r| r.map_err(anyhow::Error::from))),
        }
    }
}

impl Sink<Message> for MaybeSignedWebSocket {
    type Error = anyhow::Error;

    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let this = self.get_mut();
        match &mut this.inner {
            WebSocketInner::Plain(ws) => Pin::new(ws).poll_ready(cx).map_err(anyhow::Error::from),
        }
    }

    fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        let this = self.get_mut();
        match &mut this.inner {
            WebSocketInner::Plain(ws) => {
                Pin::new(ws).start_send(item).map_err(anyhow::Error::from)
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let this = self.get_mut();
        match &mut this.inner {
            WebSocketInner::Plain(ws) => Pin::new(ws).poll_flush(cx).map_err(anyhow::Error::from),
        }
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let this = self.get_mut();
        match &mut this.inner {
            WebSocketInner::Plain(ws) => Pin::new(ws).poll_close(cx).map_err(anyhow::Error::from),
        }
    }
}
