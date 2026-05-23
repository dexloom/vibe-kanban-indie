//! Send-only Telegram Bot API client.
//!
//! IMPORTANT: this client must NEVER call `getUpdates`. Only one process may
//! long-poll a bot token (else Telegram returns 409 Conflict), and that role
//! belongs to the sombrax-telegram listener. `sendMessage`/`createForumTopic`
//! do not conflict with polling, so the bridge can send freely. Keeping the
//! client send-only makes a polling call impossible by construction.

use anyhow::{Context, Result};
use serde_json::json;

#[derive(Clone)]
pub struct Telegram {
    http: reqwest::Client,
    token: String,
    chat_id: String,
    general_thread_id: Option<String>,
}

impl Telegram {
    pub fn new(token: String, chat_id: String, general_thread_id: Option<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            chat_id,
            general_thread_id,
        }
    }

    /// Send a message to the General/main area (or a configured General topic).
    pub async fn send(&self, text: &str) -> Result<()> {
        let mut body = json!({ "chat_id": self.chat_id, "text": text });
        if let Some(thread) = &self.general_thread_id
            && let Ok(n) = thread.parse::<i64>()
        {
            body["message_thread_id"] = json!(n);
        }
        self.call("sendMessage", body).await
    }

    /// Send a message to a specific forum topic thread.
    /// (Reserved for per-task forum topics — wired in a later milestone.)
    #[allow(dead_code)]
    pub async fn send_to_thread(&self, thread_id: i64, text: &str) -> Result<()> {
        let body = json!({
            "chat_id": self.chat_id,
            "message_thread_id": thread_id,
            "text": text,
        });
        self.call("sendMessage", body).await
    }

    /// Create a forum topic and return its `message_thread_id`.
    /// (Reserved for per-task forum topics — wired in a later milestone.)
    #[allow(dead_code)]
    pub async fn create_forum_topic(&self, name: &str) -> Result<i64> {
        let body = json!({ "chat_id": self.chat_id, "name": name });
        let value = self.call_value("createForumTopic", body).await?;
        value
            .get("result")
            .and_then(|r| r.get("message_thread_id"))
            .and_then(serde_json::Value::as_i64)
            .context("createForumTopic: missing message_thread_id")
    }

    async fn call(&self, method: &str, body: serde_json::Value) -> Result<()> {
        self.call_value(method, body).await.map(|_| ())
    }

    async fn call_value(&self, method: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let url = format!("https://api.telegram.org/bot{}/{method}", self.token);
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("Telegram {method} request failed"))?;
        let value: serde_json::Value = resp.json().await.context("Telegram response not JSON")?;
        if value.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            Ok(value)
        } else {
            let desc = value
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown error");
            anyhow::bail!("Telegram {method} error: {desc}")
        }
    }
}
