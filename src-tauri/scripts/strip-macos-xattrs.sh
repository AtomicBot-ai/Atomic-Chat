#!/usr/bin/env bash
#* Before bundling: strip xattrs from artifacts and clear the bundle/macos directory (otherwise the .app
#* carries FinderInfo / iCloud attributes over from the previous run — codesign fails on the main binary).
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for dir in \
  "$HERE/target/universal-apple-darwin/release" \
  "$HERE/target/release"; do
  if [[ -d "$dir" ]]; then
    xattr -cr "$dir" 2>/dev/null || true
  fi
done
if [[ -d "$HERE/resources/bin" ]]; then
  xattr -cr "$HERE/resources/bin" 2>/dev/null || true
fi
for bd in \
  "$HERE/target/universal-apple-darwin/release/bundle/macos" \
  "$HERE/target/release/bundle/macos"; do
  if [[ -d "$bd" ]]; then
    rm -rf "${bd:?}/"*
    mkdir -p "$bd"
    xattr -cr "$bd" 2>/dev/null || true
  fi
done
