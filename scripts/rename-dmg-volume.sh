#!/usr/bin/env bash
#* Renames the VOLNAME of a finished .dmg after tauri build.
#* Embeds the version into the DMG window's system title (what Finder
#* shows in the title bar when the image is mounted).
#?
#? Procedure:
#?   1. hdiutil convert DMG → UDRW (rewritable)
#?   2. hdiutil attach (mount)
#?   3. diskutil rename <mount> "<NEW_VOLNAME>"
#?   4. hdiutil detach
#?   5. hdiutil convert UDRW → UDZO (final compressed image)
#?
#? The inner .app stays notarized — we do not touch its contents.
#? After the rename the DMG container signature is broken and must be
#? restored via scripts/notarize-dmg-macos.sh.
#?
#? Usage:
#?   bash scripts/rename-dmg-volume.sh path/to/App.dmg [version]
#?
#? If version is not passed, it is read from src-tauri/tauri.conf.json.

set -euo pipefail

DMG="${1:-}"
VERSION="${2:-}"

if [[ -z "$DMG" ]]; then
  echo "Usage: $0 <path/to/App.dmg> [version]" >&2
  exit 1
fi

if [[ ! -f "$DMG" ]]; then
  echo "Error: DMG not found: $DMG" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF="$REPO_ROOT/src-tauri/tauri.conf.json"

if [[ -z "$VERSION" ]]; then
  if [[ ! -f "$CONF" ]]; then
    echo "Error: cannot read version — $CONF not found" >&2
    exit 1
  fi
  if command -v jq >/dev/null 2>&1; then
    VERSION="$(jq -r '.version' "$CONF")"
  else
    VERSION="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$CONF")"
  fi
fi

if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
  echo "Error: could not determine version" >&2
  exit 1
fi

PRODUCT_NAME="Atomic Chat"
NEW_VOLNAME="${PRODUCT_NAME} v${VERSION}"

echo "=== DMG volume rename ==="
echo "DMG:        $DMG"
echo "New VOLNAME: $NEW_VOLNAME"

WORKDIR="$(mktemp -d -t dmg-rename-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

RW_DMG="$WORKDIR/rw.dmg"
FINAL_DMG="$WORKDIR/final.dmg"
MOUNT_POINT="$WORKDIR/mnt"
mkdir -p "$MOUNT_POINT"

echo "-> Converting to UDRW (rewritable)..."
hdiutil convert "$DMG" -format UDRW -o "$RW_DMG" -ov -quiet

echo "-> Attaching..."
hdiutil attach "$RW_DMG" \
  -mountpoint "$MOUNT_POINT" \
  -nobrowse \
  -readwrite \
  -noautoopen \
  -quiet

echo "-> Renaming volume to: $NEW_VOLNAME"
diskutil rename "$MOUNT_POINT" "$NEW_VOLNAME"

echo "-> Detaching..."
hdiutil detach "$MOUNT_POINT" -force -quiet

echo "-> Converting back to UDZO (compressed)..."
hdiutil convert "$RW_DMG" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -o "$FINAL_DMG" \
  -ov \
  -quiet

echo "-> Replacing original DMG..."
mv -f "$FINAL_DMG" "$DMG"

echo "=== Done: $DMG (VOLNAME = '$NEW_VOLNAME') ==="
