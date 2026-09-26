#!/bin/bash
# Developer entrypoint. User-path publication belongs to the shared Rust owner.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
exec node "$PROJECT_DIR/scripts/install-cli.mjs" "$@"
