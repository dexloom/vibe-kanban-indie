# Automated supervision: TUI + Telegram + PM agent

This directory ties together the automation layer built on top of the
vibe-kanban backend. The goal: a solo developer can run more, longer tasks
without babysitting — when a coding agent would otherwise **stop mid-loop**
waiting for attention (a tool-permission prompt or a clarifying question), it is
surfaced to Telegram and answered there, either by a human or by the PM agent,
unblocking the agent automatically.

See the design plan: `~/.claude/plans/ethereal-crafting-lemon.md`.

## The pieces

| Component | What it is | Where |
|---|---|---|
| **TUI** (`vibe-tui`) | Terminal cockpit: list workspaces/sessions, watch live agent transcripts, and an **approvals inbox** to approve/deny/answer locally. Also the always-available manual override. | `crates/tui` |
| **Bridge** (`vibe-telegram-bridge`) | Send-only daemon: backend approvals stream → Telegram escalation messages (with a machine-readable footer). Optionally spawns a **per-worktree forum topic** for each Claude Code worktree and routes that worktree's escalations there. Never reads Telegram, never polls the bot token. | `crates/telegram-bridge` |
| **MCP approval tools** | `respond_to_approval` + `stop_execution` added to `vibe-kanban-mcp` (global mode) so the PM agent can unblock/stop agents. | `crates/mcp` |
| **PM agent** | A Claude Code session on the sombrax-telegram channel that reads escalations, decides within guardrails, and acts via the MCP tools. | `automation/pm-agent` |

### Flow

```
worker agent blocks ──approval──▶ backend /api/approvals/stream/ws
                                          │
                                          ▼
                              vibe-telegram-bridge (send-only)
                                          │ escalation + ‹vk …› footer
                                          ▼
                                    Telegram channel
                                    ╱            ╲
                              human reply     PM agent (sombrax-telegram
                              (or TUI)         channel session)
                                                   │ respond_to_approval (MCP)
                                                   ▼
                                       backend unblocks the worker
```

The human can always override via the **TUI** (direct to the backend) or by
messaging in Telegram while the PM agent is up.

## Running it

1. **Backend** (the orchestration engine):
   ```bash
   BACKEND_PORT=8910 cargo run --bin server
   ```

2. **TUI** (local cockpit / manual override), in another terminal:
   ```bash
   cargo run -p tui            # discovers the backend via its port file
   ```
   Keys: `a` approvals inbox · `n` new task · `i` message an agent · `?` help.

3. **Telegram bridge** — configured by `~/.vibe-kanban/telegram.toml` (the bot
   token still falls back to `$TELEGRAM_BOT_TOKEN` or
   `~/.claude/channels/telegram/.env`, the same file the sombrax-telegram
   listener uses):
   ```toml
   # ~/.vibe-kanban/telegram.toml
   enabled = true
   bot_token = "123456:ABC..."        # optional; falls back to env / .env file
   chat_id = "-1001234567890"         # your supergroup (must have Topics enabled)
   general_thread_id = "1"            # optional General topic
   per_worktree_topics = true         # spawn a forum topic per Claude Code worktree
   # topic_executors = ["CLAUDE_CODE"]  # optional; which executors get a topic
   # topic_name_template = "vk: {name}" # optional; {name}/{branch} substituted
   ```
   ```bash
   cargo run -p telegram-bridge
   ```
   When `enabled = false` (or no config and no `VK_TG_CHAT_ID`) the daemon exits
   cleanly. Legacy env vars (`VK_TG_CHAT_ID`, `VK_TG_GENERAL_THREAD_ID`) still
   work as a fallback when the TOML is absent.

   With `per_worktree_topics = true`, the bridge watches the backend's
   `/api/events` stream and, when a Claude Code worktree starts, creates a forum
   topic named from `topic_name_template` and routes that worktree's escalations
   into it (everything else goes to the General area). The
   `workspace_id → message_thread_id` map is persisted in
   `~/.vibe-kanban/telegram-topics.json` so restarts reuse existing topics.

   The app surfaces a **Settings → Telegram** panel (status + a "Send test
   message" button); it reads `telegram.toml` and the bridge's heartbeat file
   but does not edit the config — the TOML is hand-edited.

4. **PM agent** — a long-lived Claude Code session on the sombrax-telegram
   channel, with the vibe-kanban MCP in **global** mode and the PM prompt/policy:
   - Configure `vibe-kanban-mcp --mode global` as an MCP server, with
     `VIBE_BACKEND_URL=http://127.0.0.1:8910` so it targets the same backend.
   - Launch a Claude Code session on the sombrax-telegram channel for the
     supergroup, appending `pm-agent/SYSTEM_PROMPT.md` and keeping
     `pm-agent/PM_POLICY.md` in its working directory.
   - The sombrax-telegram listener must be running (it owns the single bot
     poller); the PM agent is its listener client. The bridge is **send-only**,
     so it coexists without a 409 conflict.

## Verification

- TUI: `cargo test -p tui` (unit + render) and, against a running backend,
  `VIBE_BACKEND_URL=http://127.0.0.1:8910 cargo test -p tui -- --ignored`.
- Bridge: `cargo test -p telegram-bridge` (patch parsing + message formatting).
- MCP: `cargo test -p mcp` (the global-mode tool set includes the approval tools).
- End-to-end: trigger a real approval (e.g. an agent task that runs a
  permission-gated command), confirm the escalation appears in Telegram and that
  approving it (via the PM agent, the TUI, or a human) unblocks the worker.
