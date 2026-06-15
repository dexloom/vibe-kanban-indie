#!/usr/bin/env bash
#
# kill-dev-servers.sh — stop all locally-running vibe-kanban dev servers.
#
# Kills the frontend (Vite) and backend (`cargo run --bin server`) dev processes
# spawned by `pnpm run dev` / `backend:dev:watch` / `local-web:dev`, plus any
# server binaries left listening on the dev port range (3000-3015).
#
# Does NOT touch:
#   - the installed production app  (~/.vibe-kanban/bin/.../vibe-kanban)
#   - vibe-kanban-mcp stdio connectors attached to live Claude Code sessions
#   - running Claude Code / orchestrator agents and their tmux sessions
#
# Always clears the cached .dev-ports.json after killing, so the next
# `pnpm run dev` re-scans from 3000. Pass --keep-ports to preserve the cache.
#
# Usage:
#   scripts/kill-dev-servers.sh              # kill dev servers + reset port cache
#   scripts/kill-dev-servers.sh --dry-run    # show what would be killed/cleared
#   scripts/kill-dev-servers.sh --keep-ports # kill but leave .dev-ports.json alone
#
set -uo pipefail

DRY_RUN=0
RESET_PORTS=1
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n)     DRY_RUN=1 ;;
    --keep-ports|-k)  RESET_PORTS=0 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Patterns matching the dev-server process trees (concurrently -> pnpm -> node/cargo).
PATTERNS=(
  'pnpm run dev'
  'backend:dev:watch'
  'local-web:dev'
  'concurrently.*backend:dev:watch'
  'cargo run --bin server'
  'target/debug/server'
  'vite/bin/vite'
  'setup-dev-environment.js'
)

# Collect candidate PIDs, excluding this script and the running shell.
SELF=$$
declare -a PIDS=()

collect() {
  local pat="$1" pid cmd
  while IFS= read -r line; do
    pid="${line%% *}"
    cmd="${line#* }"
    [[ -z "$pid" || "$pid" == "$SELF" ]] && continue
    # never target an interactive claude session or this script itself
    [[ "$cmd" == *"kill-dev-servers.sh"* ]] && continue
    PIDS+=("$pid")
  done < <(pgrep -fl "$pat" 2>/dev/null)
}

for pat in "${PATTERNS[@]}"; do
  collect "$pat"
done

# Add anything listening on the dev port range 3000-3015.
for port in $(seq 3000 3015); do
  while IFS= read -r pid; do
    [[ -n "$pid" && "$pid" != "$SELF" ]] && PIDS+=("$pid")
  done < <(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)
done

# De-duplicate.
UNIQUE=$(printf '%s\n' "${PIDS[@]:-}" | grep -E '^[0-9]+$' | sort -un)

# Clear the cached port allocation so the next `pnpm run dev` re-scans from 3000.
reset_ports() {
  [[ "$RESET_PORTS" == "1" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "(dry run — would clear $REPO_ROOT/.dev-ports.json)"
    return 0
  fi
  node "$REPO_ROOT/scripts/setup-dev-environment.js" clear
}

if [[ -z "$UNIQUE" ]]; then
  echo "No vibe-kanban dev servers running."
  reset_ports
  exit 0
fi

echo "Targeting these processes:"
for pid in $UNIQUE; do
  ps -o pid=,command= -p "$pid" 2>/dev/null | sed 's/^/  /'
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo "(dry run — nothing killed)"
  reset_ports
  exit 0
fi

# Graceful TERM, then escalate to KILL for survivors.
echo "$UNIQUE" | xargs kill 2>/dev/null
sleep 2

SURVIVORS=""
for pid in $UNIQUE; do
  kill -0 "$pid" 2>/dev/null && SURVIVORS="$SURVIVORS $pid"
done

if [[ -n "${SURVIVORS// }" ]]; then
  echo "Force-killing survivors:$SURVIVORS"
  echo "$SURVIVORS" | xargs kill -9 2>/dev/null
fi

reset_ports

echo "Done. Listeners remaining on 3000-3015:"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(300[0-9]|301[0-5])\b' || echo "  (none)"
