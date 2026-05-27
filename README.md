<p align="center">
  <a href="https://vibekanban.com">
    <picture>
      <source srcset="packages/public/vibe-kanban-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/public/vibe-kanban-logo.svg" media="(prefers-color-scheme: light)">
      <img src="packages/public/vibe-kanban-logo.svg" alt="Vibe Kanban Logo">
    </picture>
  </a>
</p>

<p align="center">Get 10X more out of Claude Code, Gemini CLI, Codex, Amp and other coding agents...</p>
<p align="center">
  <a href="https://www.npmjs.com/package/vibe-kanban-indie"><img alt="npm" src="https://img.shields.io/npm/v/vibe-kanban-indie?style=flat-square" /></a>
  <a href="https://github.com/dexloom/vibe-kanban-indie/actions/workflows/release-indie.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/dexloom/vibe-kanban-indie/release-indie.yml" /></a>
  <a href="https://deepwiki.com/BloopAI/vibe-kanban"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<h1 align="center"><strong>vibe-kanban-indie</strong></h1>
<p align="center">
  The independent, self-hosted fork of vibe-kanban. One dev, your machine, your
  agents — drive a crew of coding agents from the terminal or your phone.
</p>
<p align="center">
  Built for a <strong>single-developer process</strong>: no team, no cloud, no
  auth. Adds a <a href="#terminal-ui-tui">TUI cockpit</a> and
  <a href="#telegram-integration">Telegram channel orchestration</a> on top of
  upstream <a href="https://github.com/BloopAI/vibe-kanban">vibe-kanban</a>.
</p>

![](packages/public/vibe-kanban-screenshot-overview.png)

# Welcome to indie version of Vibe-Kanban

## Overview

In a world where software engineers spend most of their time planning and reviewing coding agents, the most impactful way to ship more is to get faster at planning and review.

`vibe-kanban-indie` is built for this — for a single developer, running entirely on your own machine. Use kanban issues to plan work, then create workspaces where coding agents can execute.

- **Plan with kanban issues** — create, prioritise, and assign issues on a kanban board
- **Run coding agents in workspaces** — each workspace gives an agent a branch, a terminal, and a dev server
- **Review diffs and leave inline comments** — send feedback directly to the agent without leaving the UI
- **Preview your app** — built-in browser with devtools, inspect mode, and device emulation
- **Switch between 10+ coding agents** — Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, Cursor, OpenCode, Droid, CCR, and Qwen Code
- **Create pull requests and merge** — open PRs with AI-generated descriptions, review on GitHub, and merge

![](packages/public/vibe-kanban-screenshot-workspace.png)

One command. Describe the work, review the diff, ship it.

```bash
npx vibe-kanban-indie
```


## Installation

Make sure you have authenticated with your favourite coding agent. A full list of supported coding agents can be found in the [docs](https://vibekanban.com/docs/supported-coding-agents). Then in your terminal run:

```bash
npx vibe-kanban-indie
```

## Terminal UI (TUI)

`vibe-tui` is a terminal cockpit for the backend — list workspaces and sessions, watch live agent transcripts, manage a kanban board for local projects, and approve/deny/answer the things agents block on, all without leaving the terminal. It's also the always-available manual override for the [Telegram automation](#telegram-integration) below.

Run it against a running backend (it discovers the backend via its port file, or set `VIBE_BACKEND_URL`):

```bash
cargo run -p tui
```

Keys (press `?` in-app for the full list):

| Context | Keys |
|---|---|
| Global | `a` approvals inbox · `?` help · `q` quit |
| List | `↑↓`/`jk` move · `⇥` switch pane · `⏎` open · `n` new task · `b` board · `r` refresh |
| Detail | `⇥`/`←→` move focus between panes (processes · git · transcript) · `↑↓`/`jk` navigate the focused pane · `n`/`p` process · `f` follow · `i` message agent · `s` stop · `esc` back |
| Git pane (in detail) | focus it with `⇥`, then `↑↓` select repo · `m` merge · `R` rebase · `P` create PR · `u` push — shows branch→target, ↑ahead/↓behind, ±diff, PR state per repo |
| Approvals inbox | `↑↓` move · `y` approve · `d` deny · `⏎` answer · `esc` back |
| Board | `←→` column · `↑↓` card · `[ ]` move card · `n` new · `e` edit · `d` delete · `w` workspace · `p` project · `⏎` detail |

## Telegram Integration

`vibe-telegram-bridge` is a **send-only** daemon that streams coding-agent escalations to a Telegram supergroup, so a blocked agent (waiting on a tool-permission prompt or a clarifying question) can be unblocked remotely — by a human replying in Telegram, or by a PM agent acting through the MCP approval tools. The bridge never reads Telegram and never polls the bot token, so it coexists with the sombrax-telegram listener without a 409 conflict.

It is configured by `~/.vibe-kanban/telegram.toml` (see `automation/telegram.toml.example`):

```toml
# ~/.vibe-kanban/telegram.toml
enabled = true
bot_token = "123456:ABC..."        # optional; falls back to $TELEGRAM_BOT_TOKEN
                                   # or ~/.claude/channels/telegram/.env
chat_id = "-1001234567890"         # your supergroup (must have Topics enabled)
general_thread_id = "1"            # optional General topic
per_worktree_topics = true         # spawn a forum topic per Claude Code worktree
# topic_executors = ["CLAUDE_CODE"]  # which executors get a topic
# topic_name_template = "vk: {name}" # {name}/{branch} substituted
```

```bash
cargo run -p telegram-bridge
```

When `enabled = false` (or no config is present), the daemon exits cleanly. With `per_worktree_topics = true`, the bridge watches the backend's `/api/events` stream and creates a dedicated forum topic for each opted-in worktree, routing that worktree's escalations into it; the `workspace_id → message_thread_id` map is persisted in `~/.vibe-kanban/telegram-topics.json` so restarts reuse existing topics.

The app surfaces a read-only **Settings → Telegram** panel (status + a "Send test message" button); it reads `telegram.toml` and the bridge's heartbeat file but does not edit the config — the TOML is hand-edited.

For the full architecture (TUI, bridge, MCP approval tools, and the PM agent), see [`automation/README.md`](automation/README.md).

## Documentation

Head to the [website](https://vibekanban.com/docs) for the latest documentation and user guides.

## Self-Hosting

Want to host your own Vibe Kanban Cloud instance? See our [self-hosting guide](https://vibekanban.com/docs/self-hosting/deploy-docker).

## Support

We use [GitHub Discussions](https://github.com/BloopAI/vibe-kanban/discussions) for feature requests. Please open a discussion to create a feature request. For bugs please open an issue on this repo.

## Contributing

We would prefer that ideas and changes are first raised with the core team via [GitHub Discussions](https://github.com/BloopAI/vibe-kanban/discussions) or [Discord](https://discord.gg/AC4nwVtJM3), where we can discuss implementation details and alignment with the existing roadmap. Please do not open PRs without first discussing your proposal with the team.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (>=20)
- [pnpm](https://pnpm.io/) (>=8)

Additional development tools:
```bash
cargo install cargo-watch
cargo install sqlx-cli
```

Install dependencies:
```bash
pnpm i
```

### Running the dev server

```bash
pnpm run dev
```

This will start the backend and web app. A blank DB will be copied from the `dev_assets_seed` folder.

### Building the web app

To build just the web app:

```bash
cd packages/local-web
pnpm run build
```

### Build from source (macOS)

1. Run `./local-build.sh`
2. Test with `cd npx-cli && node bin/cli.js`

### Environment Variables

The following environment variables can be configured at build time or runtime:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `POSTHOG_API_KEY` | Build-time | Empty | PostHog analytics API key (disables analytics if empty) |
| `POSTHOG_API_ENDPOINT` | Build-time | Empty | PostHog analytics endpoint (disables analytics if empty) |
| `PORT` | Runtime | Auto-assign | **Production**: Server port. **Dev**: Frontend port (backend uses PORT+1) |
| `BACKEND_PORT` | Runtime | `0` (auto-assign) | Backend server port (dev mode only, overrides PORT+1) |
| `FRONTEND_PORT` | Runtime | `3000` | Frontend dev server port (dev mode only, overrides PORT) |
| `HOST` | Runtime | `127.0.0.1` | Backend server host |
| `MCP_HOST` | Runtime | Value of `HOST` | MCP server connection host (use `127.0.0.1` when `HOST=0.0.0.0` on Windows) |
| `MCP_PORT` | Runtime | Value of `BACKEND_PORT` | MCP server connection port |
| `DISABLE_WORKTREE_CLEANUP` | Runtime | Not set | Disable all git worktree cleanup including orphan and expired workspace cleanup (for debugging) |
| `VK_ALLOWED_ORIGINS` | Runtime | Not set | Comma-separated list of origins that are allowed to make backend API requests (e.g., `https://my-vibekanban-frontend.com`) |
| `VK_SHARED_API_BASE` | Runtime | Not set | Base URL for the remote/cloud API used by the local desktop app |
| `VK_SHARED_RELAY_API_BASE` | Runtime | Not set | Base URL for the relay API used by tunnel-mode connections |
| `VK_TUNNEL` | Runtime | Not set | Enable relay tunnel mode when set (requires relay API base URL) |

**Build-time variables** must be set when running `pnpm run build`. **Runtime variables** are read when the application starts.

#### Self-Hosting with a Reverse Proxy or Custom Domain

When running Vibe Kanban behind a reverse proxy (e.g., nginx, Caddy, Traefik) or on a custom domain, you must set the `VK_ALLOWED_ORIGINS` environment variable. Without this, the browser's Origin header won't match the backend's expected host, and API requests will be rejected with a 403 Forbidden error.

Set it to the full origin URL(s) where your frontend is accessible:

```bash
# Single origin
VK_ALLOWED_ORIGINS=https://vk.example.com

# Multiple origins (comma-separated)
VK_ALLOWED_ORIGINS=https://vk.example.com,https://vk-staging.example.com
```

### Remote Deployment

When running Vibe Kanban on a remote server (e.g., via systemctl, Docker, or cloud hosting), you can configure your editor to open projects via SSH:

1. **Access via tunnel**: Use Cloudflare Tunnel, ngrok, or similar to expose the web UI
2. **Configure remote SSH** in Settings → Editor Integration:
   - Set **Remote SSH Host** to your server hostname or IP
   - Set **Remote SSH User** to your SSH username (optional)
3. **Prerequisites**:
   - SSH access from your local machine to the remote server
   - SSH keys configured (passwordless authentication)
   - VSCode Remote-SSH extension

When configured, the "Open in VSCode" buttons will generate URLs like `vscode://vscode-remote/ssh-remote+user@host/path` that open your local editor and connect to the remote server.

See the [documentation](https://vibekanban.com/docs/settings/general) for detailed setup instructions.
