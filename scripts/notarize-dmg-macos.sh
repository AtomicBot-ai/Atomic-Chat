#!/usr/bin/env bash
#* DMG после Tauri: подпись DMG → notarytool → staple → spctl (как у коллеги).
#? Секреты только из окружения; не коммить пароли.
set -euo pipefail

DMG="${1:-}"
if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "Usage: APPLE_ID=... APPLE_PASSWORD=... APPLE_TEAM_ID=... $0 path/to/App_x.x.x_aarch64.dmg" >&2
  exit 1
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1 | sed -n 's/.*"\(.*\)".*/\1/p')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "No Developer ID Application identity; set APPLE_SIGNING_IDENTITY or install cert." >&2
  exit 1
fi

APPLE_ID="${APPLE_ID:-}"
APPLE_PASSWORD="${APPLE_PASSWORD:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"

echo "Signing DMG (timestamp only; не --deep и не runtime на сам DMG — как в чек-листе Apple для образов)..."
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [[ -n "$APPLE_ID" && -n "$APPLE_PASSWORD" && -n "$APPLE_TEAM_ID" ]]; then
  echo "Submitting to Apple Notary Service..."
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  echo "Stapling..."
  xcrun stapler staple "$DMG"
else
  echo "Skip notarization: set APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID" >&2
fi

echo "Gatekeeper check (DMG):"
spctl --assess --verbose --type open --context context:primary-signature "$DMG" && echo "spctl: OK"
