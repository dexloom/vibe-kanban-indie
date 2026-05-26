//! Per-worktree Telegram "channels" for spawned Claude Code agents.
//!
//! vibe-kanban holds no bot token and makes no Telegram calls. It only decides
//! whether per-worktree channels are on and names the channel (the git branch),
//! injected as `TELEGRAM_TOPIC`, plus `TELEGRAM_DEV=1` marking the session as
//! that channel's dev agent (kind=dev, role=owner) in sombrax-telegram's role
//! model — without it the agent would register as a passive observer and never
//! own its channel. The sombrax-telegram listener (which holds the token)
//! resolves/creates the forum topic from the name and resolves the chat itself
//! — so VK passes neither a token nor a chat id. Both vars are injected in
//! `local-deployment`'s `container.rs`, gated on [`per_worktree_enabled`].

/// True when per-worktree channels are enabled: the `per_worktree_topics` config
/// flag in `telegram.toml`, or the `TELEGRAM_DEV` env override.
///
/// When true, a Claude Code workspace's channel name is its git branch.
pub fn per_worktree_enabled() -> bool {
    if let Ok(v) = std::env::var("TELEGRAM_DEV")
        && (v == "1" || v.eq_ignore_ascii_case("true"))
    {
        return true;
    }
    crate::telegram_config::load()
        .map(|c| c.per_worktree_topics)
        .unwrap_or(false)
}
