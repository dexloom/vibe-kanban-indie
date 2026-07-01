#!/usr/bin/env bash
# Build the Rust `server` binary (release) and stage it for bundling into the
# macOS app. After running this, `xcodebuild`/Xcode copies it into the app at
# Contents/Resources/Backend/server (see the postCompileScript in project.yml),
# and the app's managed backend will prefer the bundled binary.
#
# Usage:  apps/macos/scripts/build-backend.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"

echo "Building server (release) in $REPO_ROOT …"
( cd "$REPO_ROOT" && cargo build --release --bin server )

SRC="$REPO_ROOT/target/release/server"
DEST_DIR="$MACOS_DIR/Backend"
mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST_DIR/server"
chmod +x "$DEST_DIR/server"
echo "Staged backend binary at $DEST_DIR/server"
echo "Now build the app (xcodegen generate && xcodebuild …) to bundle it."
