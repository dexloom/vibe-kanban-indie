#!/usr/bin/env bash
# Launch the PM *intake* agent: a Claude Code session bound to the Telegram
# channel, with the vibe-kanban MCP scoped to THIS session only (never global).
#
#   ./launch.sh                 # uses defaults below
#   VIBE_BACKEND_URL=http://127.0.0.1:9001 ./launch.sh
#
# Prereqs:
#   - backend running:   BACKEND_PORT=8910 cargo run --bin server
#   - mcp binary built:  cargo build --release --bin vibe-kanban-mcp
#   - sombrax-telegram listener configured (token in
#     ~/.claude/channels/telegram/.env)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Backend the MCP server targets. Must match where the server is listening.
export VIBE_BACKEND_URL="${VIBE_BACKEND_URL:-http://127.0.0.1:8910}"

cd "$HERE"

exec claude \
  --channels plugin:telegram@claude-plugins-official \
  --mcp-config "$HERE/mcp.json" \
  --append-system-prompt "$(cat "$HERE/INTAKE_SYSTEM_PROMPT.md")" \
  "$@"
