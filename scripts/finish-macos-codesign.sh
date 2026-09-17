#!/usr/bin/env bash
#* If `yarn build` failed while signing the main binary (often Desktop/iCloud → FinderInfo on the .app):
#* strip xattrs from the whole .app and re-sign every executable in MacOS, then the bundle itself.
#? Usage: from the `jan/` root: APPLE_SIGNING_IDENTITY="…" bash scripts/finish-macos-codesign.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IDENTITY="${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY}"
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
[[ -n "${APP:-}" && -d "$APP" ]] || { echo "No .app found in bundle/macos"; exit 1; }

echo "xattr -cr $APP"
xattr -cr "$APP"

echo "Signing Contents/MacOS/* …"
find "$APP/Contents/MacOS" -type f -perm -111 2>/dev/null | while read -r f; do
  codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$ENT" "$f"
done

echo "Signing bundle $APP"
codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$ENT" "$APP"

echo "Verifying:"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|Timestamp|runtime" || true
spctl --assess --verbose --type execute "$APP" 2>&1 || true
