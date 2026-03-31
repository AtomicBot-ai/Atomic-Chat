#!/usr/bin/env bash
#* Full macOS build: Developer ID signing + Apple notarization (Tauri CLI).
#? Run from the repo root: bash scripts/macos-build-signed-notarized.sh
#? Export the required environment variables before running (see below).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "Error: APPLE_SIGNING_IDENTITY is not set."
  echo "  security find-identity -v -p codesigning"
  exit 1
fi

NOTARIZE_OK=0
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARIZE_OK=1
elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -f "${APPLE_API_KEY_PATH:-}" ]]; then
  NOTARIZE_OK=1
fi

if [[ "$NOTARIZE_OK" -ne 1 ]]; then
  echo "Error: notarization requires one of the following sets of variables:"
  echo ""
  echo "  Option A (Apple ID + app-specific password):"
  echo "    export APPLE_ID=\"you@email.com\""
  echo "    export APPLE_PASSWORD=\"xxxx-xxxx-xxxx-xxxx\"  # app-specific password, appleid.apple.com"
  echo "    export APPLE_TEAM_ID=\"UT6WGPGTGR\"             # 10 chars, Developer portal"
  echo ""
  echo "  Option B (App Store Connect API key):"
  echo "    export APPLE_API_KEY=\"XXXXXXXXXX\""
  echo "    export APPLE_API_ISSUER=\"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\""
  echo "    export APPLE_API_KEY_PATH=\"\$HOME/AuthKey_XXXXXXXXXX.p8\""
  echo ""
  echo "Additionally, always set:"
  echo "    export APPLE_SIGNING_IDENTITY=\"Developer ID Application: ...\""
  exit 1
fi

echo "Building with signing and notarization (CI=false)..."
cp -f src-tauri/resources/pre-install/*.tgz pre-install/ 2>/dev/null || true

export CI=false
exec yarn build
