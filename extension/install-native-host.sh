#!/bin/bash
# Compatibility entry point; registration and identity have one implementation.
set -euo pipefail
exec node "$(dirname "$0")/../scripts/install-clipper-host.mjs" "$@"
