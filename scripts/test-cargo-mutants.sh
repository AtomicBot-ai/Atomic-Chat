#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! cargo mutants --version >/dev/null 2>&1; then
  echo "cargo-mutants is required; install it with: cargo install cargo-mutants" >&2
  exit 1
fi

CONFIG="$ROOT/src-tauri/.cargo/mutants.toml"

# Launch arguments, devices and the MLX server moved to atomic-chat-core, which replays the frozen
# fixtures the Rust once produced; the plugins keep only backend selection.
cargo mutants \
  --manifest-path "$ROOT/src-tauri/plugins/tauri-plugin-llamacpp/Cargo.toml" \
  --config "$CONFIG" \
  --file src/backend.rs \
  "$@"

exec cargo mutants \
  --manifest-path "$ROOT/src-tauri/plugins/tauri-plugin-llamacpp-upstream/Cargo.toml" \
  --config "$CONFIG" \
  --file src/backend.rs \
  "$@"
