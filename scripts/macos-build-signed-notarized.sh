#!/usr/bin/env bash
#* Полная macOS-сборка: подпись Developer ID + нотаризация Apple (Tauri CLI).
#? Запуск из корня репозитория: bash scripts/macos-build-signed-notarized.sh
#? Перед запуском экспортируйте переменные (см. ниже).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "Ошибка: не задан APPLE_SIGNING_IDENTITY."
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
  echo "Ошибка: для нотаризации нужен один из наборов переменных:"
  echo ""
  echo "  Вариант A (Apple ID + пароль приложения):"
  echo "    export APPLE_ID=\"you@email.com\""
  echo "    export APPLE_PASSWORD=\"xxxx-xxxx-xxxx-xxxx\"  # пароль приложения, appleid.apple.com"
  echo "    export APPLE_TEAM_ID=\"UT6WGPGTGR\"             # 10 символов, Developer"
  echo ""
  echo "  Вариант B (ключ App Store Connect API):"
  echo "    export APPLE_API_KEY=\"XXXXXXXXXX\""
  echo "    export APPLE_API_ISSUER=\"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\""
  echo "    export APPLE_API_KEY_PATH=\"\$HOME/AuthKey_XXXXXXXXXX.p8\""
  echo ""
  echo "Плюс всегда:"
  echo "    export APPLE_SIGNING_IDENTITY=\"Developer ID Application: …\""
  exit 1
fi

echo "Сборка с подписью и нотаризацией (CI=false)…"
cp -f src-tauri/resources/pre-install/*.tgz pre-install/ 2>/dev/null || true

export CI=false
exec yarn build
