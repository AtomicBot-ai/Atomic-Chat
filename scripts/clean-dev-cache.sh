#!/usr/bin/env bash
#* Локальная очистка кэшей перед yarn dev (Vite + артефакты Rust).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Removing Vite cache and web dist..."
rm -rf web-app/node_modules/.vite web-app/dist

echo "cargo clean (src-tauri)..."
(cd src-tauri && cargo clean)

echo "Removing src-tauri/target (full)..."
rm -rf src-tauri/target

echo "Done. Run: yarn dev"
