#!/usr/bin/env bash
#* Переименование VOLNAME готового .dmg после tauri build.
#* Вклеивает версию в системный заголовок окна DMG (то, что Finder
#* показывает в шапке при монтировании образа).
#?
#? Порядок ритуала:
#?   1. hdiutil convert DMG → UDRW (rewritable)
#?   2. hdiutil attach (mount)
#?   3. diskutil rename <mount> "<NEW_VOLNAME>"
#?   4. hdiutil detach
#?   5. hdiutil convert UDRW → UDZO (финальный сжатый образ)
#?
#? Внутренний .app остаётся нотаризованным — мы не трогаем его содержимое.
#? После переименования подпись DMG-контейнера ломается и должна быть
#? восстановлена через scripts/notarize-dmg-macos.sh.
#?
#? Usage:
#?   bash scripts/rename-dmg-volume.sh path/to/App.dmg [version]
#?
#? Если version не передан — читается из src-tauri/tauri.conf.json.

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
