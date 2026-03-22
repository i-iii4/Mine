#!/bin/bash
# Build Local Arena Rust core for iOS and generate Swift bindings.
#
# Prerequisites:
#   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
#
# Usage:
#   ./scripts/build-ios.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "Building for iOS device (arm64)..."
cargo build -p local-arena-ffi --release --target aarch64-apple-ios

echo "Building for iOS simulator (arm64)..."
cargo build -p local-arena-ffi --release --target aarch64-apple-ios-sim

echo "Generating Swift bindings..."
mkdir -p ios/Generated
cargo run -p local-arena-ffi --bin uniffi-bindgen generate \
  --library target/aarch64-apple-ios/release/liblocal_arena_ffi.dylib \
  --language swift \
  --out-dir ios/Generated

echo ""
echo "Done!"
echo "  Swift bindings: ios/Generated/"
echo "  iOS library: target/aarch64-apple-ios/release/liblocal_arena_ffi.a"
echo "  Simulator library: target/aarch64-apple-ios-sim/release/liblocal_arena_ffi.a"
