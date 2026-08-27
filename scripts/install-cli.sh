#!/bin/bash
# Install the `mine` CLI into ~/.local/bin.
#
# Builds the release binary and copies it as `mine`. ~/.local/bin is expected
# to be in PATH (it is created if missing).
#
# Usage: ./scripts/install-cli.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$HOME/.local/bin"
DEST="$DEST_DIR/mine"

cargo build --manifest-path "$PROJECT_DIR/src-tauri/Cargo.toml" --release --bin mine-cli

mkdir -p "$DEST_DIR"
install -m 755 "$PROJECT_DIR/target/release/mine-cli" "$DEST"

echo "installed: $DEST"
"$DEST" --help >/dev/null 2>&1 || true
case ":$PATH:" in
  *":$DEST_DIR:"*) ;;
  *) echo "note: $DEST_DIR is not in PATH" ;;
esac
