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
| **Bridge** (`vibe-telegram-bridge`) | Send-only daemon: backend approvals stream → Telegram escalation messages (with a machine-readable footer). Never reads Telegram, never polls the bot token. | `crates/telegram-bridge` |
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

3. **Telegram bridge** — requires a bot token (same file the sombrax-telegram
   listener uses) and the target supergroup:
   ```bash
   export VK_TG_CHAT_ID="-1001234567890"          # your supergroup
   export VK_TG_GENERAL_THREAD_ID="1"             # optional General topic
   # token read from $TELEGRAM_BOT_TOKEN or ~/.claude/channels/telegram/.env
   cargo run -p telegram-bridge
   ```

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
