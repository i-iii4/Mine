#!/bin/bash
# Install the Local Arena native messaging host for Chrome.
#
# This script:
# 1. Builds the native-host binary (release mode)
# 2. Copies it to ~/Library/Application Support/LocalArena/
# 3. Creates the Chrome native messaging manifest
# 4. Optionally sets the vault path (for standalone mode without desktop app)
#
# Usage: ./install-native-host.sh [extension-id] [vault-path]
#
# Examples:
#   ./install-native-host.sh                           # placeholder ID, default vault
#   ./install-native-host.sh abcdef123456               # with extension ID
#   ./install-native-host.sh abcdef123456 ~/MyVault     # with extension ID and custom vault

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Extension ID (will be known after loading in Chrome)
EXT_ID="${1:-EXTENSION_ID_PLACEHOLDER}"
VAULT_PATH="${2:-}"

HOST_NAME="com.localarena.clipper"
HOST_DIR="$HOME/Library/Application Support/LocalArena"
HOST_PATH="$HOST_DIR/native-host"

CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$CHROME_NM_DIR/$HOST_NAME.json"

APP_CONFIG_DIR="$HOME/Library/Application Support/com.localarena.app"

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

# Set vault path if provided (standalone mode)
if [ -n "$VAULT_PATH" ]; then
  # Expand ~ and resolve to absolute path
  VAULT_PATH="$(cd "$VAULT_PATH" 2>/dev/null && pwd || echo "$VAULT_PATH")"
  mkdir -p "$VAULT_PATH"
  mkdir -p "$APP_CONFIG_DIR"
  cat > "$APP_CONFIG_DIR/config.json" << EOF
{
  "vault_path": "$VAULT_PATH"
}
EOF
  echo "Vault path set: $VAULT_PATH"
fi

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
if [ -z "$VAULT_PATH" ]; then
  echo ""
  echo "Vault: using ~/LocalArena/ by default (standalone mode)"
  echo "  To use a custom folder: ./install-native-host.sh <extension-id> /path/to/vault"
fi
