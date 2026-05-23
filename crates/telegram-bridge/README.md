# vibe-telegram-bridge

A **send-only** daemon that streams vibe-kanban coding-agent escalations to a
Telegram supergroup, so blocked agents can be unblocked remotely (by a human or
the PM agent). Part of the automation layer — see `../../automation/README.md`.

## What it does
- Subscribes to the backend's `/api/approvals/stream/ws`.
- When an agent blocks waiting for a decision, posts an escalation message that
  ends with a machine-readable footer:
  `‹vk approval_id=… exec=… kind=approval|question›`.
- Posts `✅ resolved · <id>` when an approval is answered (by anyone).
- Reconnects with backoff; a `seen` set prevents re-posting on reconnect.

## What it deliberately does NOT do
- It never reads Telegram and never calls `getUpdates`. Only one process may
  long-poll a bot token (else 409 Conflict); that role belongs to the
  sombrax-telegram listener. `sendMessage`/`createForumTopic` don't conflict, so
  the bridge sends freely. Control/inbound flows through the PM agent.

## Configuration (env)
| Var | Meaning | Required |
|---|---|---|
| `VK_TG_CHAT_ID` | Target supergroup chat id | yes |
| `VK_TG_GENERAL_THREAD_ID` | Forum topic to post into (the "General" topic) | no |
| `TELEGRAM_BOT_TOKEN` | Bot token (else read from `~/.claude/channels/telegram/.env`) | no* |
| `VIBE_BACKEND_URL` / `BACKEND_PORT` / `PORT` | Backend address (else the port file) | no |

\* the token must be available either via env or the `.env` file.

## Run
```bash
export VK_TG_CHAT_ID="-1001234567890"
cargo run -p telegram-bridge
```

## Future milestones (structured for, not yet wired)
- Per-task **forum topics** (`createForumTopic` / `send_to_thread` are present)
  with a General mirror.
- A **lifecycle/progress feed** (task started / completed / failed) from the
  workspace + execution-process streams.
