//! Send-only Telegram Bot API client, shared by the server and the bridge.
//!
//! IMPORTANT: this client must NEVER call `getUpdates`. Only one process may
//! long-poll a bot token (else Telegram returns 409 Conflict), and that role
//! belongs to the sombrax-telegram listener. `sendMessage` / `createForumTopic`
//! / `closeForumTopic` do not conflict with polling, so any number of senders
//! are fine. Keeping the client send-only makes a polling call impossible by
//! construction.

use anyhow::{Context, Result};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Telegram {
    http: reqwest::Client,
    token: String,
    chat_id: String,
}

impl Telegram {
    pub fn new(token: String, chat_id: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            chat_id,
        }
    }

    /// Send a message, optionally into a specific forum topic thread.
    pub async fn send_message(&self, text: &str, thread_id: Option<i64>) -> Result<()> {
        let mut body = json!({ "chat_id": self.chat_id, "text": text });
        if let Some(thread) = thread_id {
            body["message_thread_id"] = json!(thread);
        }
        self.call("sendMessage", body).await.map(|_| ())
    }

    /// Create a forum topic and return its `message_thread_id`.
    pub async fn create_forum_topic(&self, name: &str) -> Result<i64> {
        let body = json!({ "chat_id": self.chat_id, "name": name });
        let value = self.call("createForumTopic", body).await?;
        value
            .get("result")
            .and_then(|r| r.get("message_thread_id"))
            .and_then(Value::as_i64)
            .context("createForumTopic: missing message_thread_id")
    }

    /// Close a forum topic (best-effort cleanup; topics can't be deleted).
    pub async fn close_forum_topic(&self, thread_id: i64) -> Result<()> {
        let body = json!({ "chat_id": self.chat_id, "message_thread_id": thread_id });
        self.call("closeForumTopic", body).await.map(|_| ())
    }

    /// Best-effort escalation send: resolves the bot token / chat id / general
    /// thread id from `telegram.toml` (via [`crate::telegram_config`]) and sends
    /// `text` into the configured general thread. Silently no-ops when
    /// unconfigured (no token or no chat id); logs a warning on send failure.
    /// Never returns an error — callers (e.g. the recurrent-task failure hook)
    /// must not let a Telegram outage affect their own control flow.
    pub async fn send_escalation_best_effort(text: &str) {
        let cfg = crate::telegram_config::load();
        let Some((token, _)) = crate::telegram_config::resolve_bot_token(cfg.as_ref()) else {
            return;
        };
        let Some(chat_id) = crate::telegram_config::resolve_chat_id(cfg.as_ref()) else {
            return;
        };
        let thread = crate::telegram_config::resolve_general_thread_id(cfg.as_ref())
            .and_then(|s| s.trim().parse::<i64>().ok());

        let telegram = Telegram::new(token, chat_id);
        if let Err(e) = telegram.send_message(text, thread).await {
            tracing::warn!("Failed to send Telegram escalation: {e}");
        }
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value> {
        let url = format!("https://api.telegram.org/bot{}/{method}", self.token);
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("Telegram {method} request failed"))?;
        let value: Value = resp.json().await.context("Telegram response not JSON")?;
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(value)
        } else {
            let desc = value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            anyhow::bail!("Telegram {method} error: {desc}")
        }
    }
}
