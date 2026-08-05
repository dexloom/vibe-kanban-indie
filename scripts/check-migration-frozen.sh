#!/usr/bin/env bash
# F-2 / ADR-013 migration freeze guard.
#
# The migration file `crates/db/migrations/20260805000001_add_project_parent_id.sql`
# is FROZEN. sqlx records its SHA-384 in `_sqlx_migrations` on first run;
# any byte change (even whitespace or a comment) makes the checksum drift
# and the server refuses to start on macOS/Linux (VersionMismatch in
# crates/db/src/lib.rs). This script enforces that:
#   - the working-tree version is byte-identical to the committed version
#     (catches "I just added a comment" before it leaves your laptop)
#   - if the file isn't tracked in git yet (e.g. fresh checkout, brand-new
#     repo state) the check is a no-op so CI doesn't false-positive
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_REL="crates/db/migrations/20260805000001_add_project_parent_id.sql"
MIGRATION_PATH="$REPO_ROOT/$MIGRATION_REL"

if [ ! -f "$MIGRATION_PATH" ]; then
  echo "check-migration-frozen: migration file not present at $MIGRATION_PATH — skipping"
  exit 0
fi

# Need to be inside a git repo to query the index. If `git rev-parse` fails
# (e.g. tarball extract) treat as no-op rather than hard-fail.
if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "check-migration-frozen: not a git checkout — skipping"
  exit 0
fi

# Has the file been committed (anywhere in history) yet? If not, this is a
# fresh-add scenario (the migration has never been released) — no drift to
# check against, so exit 0.
if ! git -C "$REPO_ROOT" cat-file -e "HEAD:$MIGRATION_REL" 2>/dev/null; then
  echo "check-migration-frozen: $MIGRATION_REL not yet committed — skipping (no drift baseline)"
  exit 0
fi

# Working-tree vs committed HEAD. `git diff --no-index --exit-code` exits
# non-zero on any diff (byte-level), so this catches even whitespace-only
# edits that would still change the SHA-384.
if git -C "$REPO_ROOT" diff --no-index --exit-code -- "$MIGRATION_PATH" <(git -C "$REPO_ROOT" show "HEAD:$MIGRATION_REL") >/dev/null 2>&1; then
  echo "check-migration-frozen: $MIGRATION_REL matches HEAD (frozen, OK)"
  exit 0
fi

echo "check-migration-frozen: $MIGRATION_REL DIFFERS from HEAD" >&2
echo "" >&2
echo "  This file is FROZEN (ADR-013 §Migration / F-2). Any byte change" >&2
echo "  (even a comment) alters its SHA-384 checksum and bricks macOS/Linux" >&2
echo "  installs on next start (VersionMismatch in crates/db/src/lib.rs)." >&2
echo "" >&2
echo "  If you actually need to evolve the schema, add a NEW migration file" >&2
echo "  (e.g. 20260806000001_<topic>.sql) — never edit this one." >&2
echo "" >&2
git -C "$REPO_ROOT" diff --no-index -- "$MIGRATION_PATH" <(git -C "$REPO_ROOT" show "HEAD:$MIGRATION_REL") >&2 || true
exit 1
