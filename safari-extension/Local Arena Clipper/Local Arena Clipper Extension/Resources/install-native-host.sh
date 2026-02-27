#!/bin/bash
# Install the Local Arena native messaging host for Chrome.
#
# This script:
# 1. Builds the native-host binary (release mode)
# 2. Copies it to ~/Library/Application Support/LocalArena/
# 3. Creates the Chrome native messaging manifest
#
# Usage: ./install-native-host.sh [extension-id]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Extension ID (will be known after loading in Chrome)
EXT_ID="${1:-EXTENSION_ID_PLACEHOLDER}"

HOST_NAME="com.localarena.clipper"
HOST_DIR="$HOME/Library/Application Support/LocalArena"
HOST_PATH="$HOST_DIR/native-host"

CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$CHROME_NM_DIR/$HOST_NAME.json"

echo "Building native-host (release)..."
cd "$PROJECT_DIR/src-tauri"
cargo build --release --bin native-host

echo "Installing native-host binary..."
mkdir -p "$HOST_DIR"
cp "target/release/native-host" "$HOST_PATH"
chmod +x "$HOST_PATH"

echo "Creating Chrome native messaging manifest..."
mkdir -p "$CHROME_NM_DIR"
cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "Local Arena Web Clipper native messaging host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo ""
echo "Done!"
echo "  Binary: $HOST_PATH"
echo "  Manifest: $MANIFEST_PATH"
echo ""
if [ "$EXT_ID" = "EXTENSION_ID_PLACEHOLDER" ]; then
  echo "NOTE: Update the extension ID in $MANIFEST_PATH"
  echo "  1. Load the extension in Chrome (chrome://extensions)"
  echo "  2. Copy the extension ID"
  echo "  3. Run: ./install-native-host.sh <extension-id>"
fi
