#!/usr/bin/env bash
#* Если `yarn build` упал на подписи главного бинарника (часто Desktop/iCloud → FinderInfo на .app):
#* снимаем xattr со всего .app и подписываем заново все исполняемые файлы в MacOS, затем сам бандл.
#? Использование: из корня `jan/`: APPLE_SIGNING_IDENTITY="…" bash scripts/finish-macos-codesign.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IDENTITY="${APPLE_SIGNING_IDENTITY:?Задайте APPLE_SIGNING_IDENTITY}"
ENT="$ROOT/src-tauri/Entitlements.plist"
APP=""
for d in \
  "$ROOT/src-tauri/target/universal-apple-darwin/release/bundle/macos" \
  "$ROOT/src-tauri/target/release/bundle/macos"; do
  if [[ -d "$d" ]]; then
    APP="$(find "$d" -maxdepth 1 -name "*.app" -print -quit)"
    [[ -n "$APP" ]] && break
  fi
done
[[ -n "${APP:-}" && -d "$APP" ]] || { echo "Не найден .app в bundle/macos"; exit 1; }

echo "xattr -cr $APP"
xattr -cr "$APP"

echo "Подпись Contents/MacOS/* …"
find "$APP/Contents/MacOS" -type f -perm -111 2>/dev/null | while read -r f; do
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$ENT" "$f"
done

echo "Подпись бандла $APP"
codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$ENT" "$APP"

echo "Проверка:"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|Timestamp|runtime" || true
spctl --assess --verbose --type execute "$APP" 2>&1 || true
