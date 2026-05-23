//! WebSocket frame decoding shared by all backend streams.
//!
//! Every backend WS frame is a serialized `utils::log_msg::LogMsg`, except two
//! sentinels the server emits in a bespoke JSON form:
//! `{"Ready":true}` (initial snapshot delivered) and `{"finished":true}`
//! (stream complete). Everything else is `LogMsg::JsonPatch` carrying an
//! RFC6902 patch.

use std::time::Duration;

use futures_util::StreamExt;
use json_patch::Patch;
use tokio::{sync::mpsc::UnboundedSender, task::JoinHandle};
use tokio_tungstenite::tungstenite::Message;
use utils::log_msg::LogMsg;

use crate::state::conversation::{Conversation, QuestionItem};

/// A decoded WS text frame.
#[derive(Debug)]
pub enum Decoded {
    Ready,
    Finished,
    Patch(Patch),
    /// A frame we don't act on (e.g. SessionId/MessageId metadata, or stdout on
    /// a stream we treat as patch-only).
    Other,
}

/// What a stream task reports back to the app.
#[derive(Debug)]
pub enum StreamEvent {
    Frame(Decoded),
    /// The stream ended (finished, closed, or connect failed).
    Closed,
}

/// Connect to a backend WS, decode each frame, and forward it via `map` into the
/// app's event channel. Ends when the socket finishes/closes; emits a final
/// `StreamEvent::Closed`. Reconnect/backoff is deferred to T-M5.
pub fn spawn_stream<T: Send + 'static>(
    ws_url: String,
    tx: UnboundedSender<T>,
    map: impl Fn(StreamEvent) -> T + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        match tokio_tungstenite::connect_async(ws_url.as_str()).await {
            Ok((mut socket, _resp)) => {
                while let Some(Ok(msg)) = socket.next().await {
                    match msg {
                        Message::Text(t) => {
                            let decoded = decode_frame(t.as_str());
                            let finished = matches!(decoded, Decoded::Finished);
                            if tx.send(map(StreamEvent::Frame(decoded))).is_err() {
                                return;
                            }
                            if finished {
                                break;
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
            Err(e) => tracing::warn!("ws connect failed for {ws_url}: {e}"),
        }
        let _ = tx.send(map(StreamEvent::Closed));
    })
}

/// Open a short-lived normalized-log stream and scan for the `AskUserQuestion`
/// options matching `approval_id`. Returns the questions once found, or an empty
/// vec on timeout / stream end. Used to populate the answer picker on demand.
pub async fn scan_question_options(ws_url: &str, approval_id: &str) -> Vec<QuestionItem> {
    let mut conv = Conversation::new();
    let connect = tokio_tungstenite::connect_async(ws_url);
    let Ok(Ok((mut socket, _))) = tokio::time::timeout(Duration::from_secs(5), connect).await
    else {
        return Vec::new();
    };

    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            msg = socket.next() => match msg {
                Some(Ok(Message::Text(t))) => match decode_frame(t.as_str()) {
                    Decoded::Patch(p) => {
                        let _ = conv.apply(&p);
                        if let Some(qs) = conv.find_questions(approval_id) {
                            return qs;
                        }
                    }
                    Decoded::Finished => break,
                    _ => {}
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {}
            }
        }
    }
    conv.find_questions(approval_id).unwrap_or_default()
}

/// Decode a single WS text frame.
pub fn decode_frame(text: &str) -> Decoded {
    match text.trim() {
        r#"{"Ready":true}"# => return Decoded::Ready,
        r#"{"finished":true}"# => return Decoded::Finished,
        _ => {}
    }
    match serde_json::from_str::<LogMsg>(text) {
        Ok(LogMsg::JsonPatch(p)) => Decoded::Patch(p),
        Ok(LogMsg::Ready) => Decoded::Ready,
        Ok(LogMsg::Finished) => Decoded::Finished,
        Ok(_) => Decoded::Other,
        Err(_) => Decoded::Other,
    }
}
