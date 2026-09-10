#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! cargo mutants --version >/dev/null 2>&1; then
  echo "cargo-mutants is required; install it with: cargo install cargo-mutants" >&2
  exit 1
fi

CONFIG="$ROOT/src-tauri/.cargo/mutants.toml"

cargo mutants \
  --manifest-path "$ROOT/src-tauri/plugins/tauri-plugin-llamacpp/Cargo.toml" \
  --config "$CONFIG" \
  --file src/args.rs \
  --file src/backend.rs \
  --file src/device.rs \
  "$@"

cargo mutants \
  --manifest-path "$ROOT/src-tauri/plugins/tauri-plugin-llamacpp-upstream/Cargo.toml" \
  --config "$CONFIG" \
  --file src/args.rs \
  --file src/backend.rs \
  --file src/device.rs \
  "$@"

exec cargo mutants \
  --manifest-path "$ROOT/src-tauri/plugins/tauri-plugin-mlx/Cargo.toml" \
  --config "$CONFIG" \
  --file src/commands.rs \
  "$@"
