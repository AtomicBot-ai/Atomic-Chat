#!/usr/bin/env bash
#
# Hotfix: bundle non-system dylibs (OpenSSL etc.) alongside llamacpp binaries
# and rewrite load paths via install_name_tool so that the signed app bundle
# doesn't fail with "different Team IDs" at runtime.
#
# Run AFTER downloading/extracting the llamacpp backend, BEFORE code-signing.
# Compatible with macOS default bash 3.2 (no associative arrays).
#
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${1:-$HERE/resources/llamacpp-backend/build/bin}"

[[ -d "$BIN_DIR" ]] || { echo "fix-dylibs: $BIN_DIR not found, skipping"; exit 0; }

# Collect non-system, non-rpath dylib paths from a Mach-O binary (one per line).
collect_brew_deps() {
  otool -L "$1" 2>/dev/null | awk '
    NR > 1 {
      gsub(/^[[:space:]]+/, "", $1)
      if ($1 == "") next
      if ($1 ~ /^@/) next
      if ($1 ~ /^\/usr\/lib\//) next
      if ($1 ~ /^\/System\//) next
      print $1
    }
  '
}

echo "fix-dylibs: scanning $BIN_DIR for non-system dylib dependencies..."

# --- Pass 1: collect every unique external dep path across all binaries ---
DEP_LIST=$(mktemp /tmp/fix-dylibs-deps-XXXXXX)
trap "rm -f '$DEP_LIST'" EXIT

for f in "$BIN_DIR"/*; do
  [[ -f "$f" && -x "$f" ]] || continue
  file "$f" | grep -q 'Mach-O' || continue
  collect_brew_deps "$f"
done | sort -u > "$DEP_LIST"

if [[ ! -s "$DEP_LIST" ]]; then
  echo "fix-dylibs: no external dylib dependencies found — nothing to do."
  exit 0
fi

echo "fix-dylibs: found external deps:"
sed 's/^/  /' "$DEP_LIST"

# --- Pass 2: copy needed dylibs into BIN_DIR, handle transitive deps ---
BUNDLED_COUNT=0
BUNDLED_NAMES=""

copy_if_needed() {
  local dep_path="$1"
  local lib_name
  lib_name="$(basename "$dep_path")"
  local dest="$BIN_DIR/$lib_name"

  # Skip if already processed
  echo "$BUNDLED_NAMES" | grep -qxF "$lib_name" && return 0

  if [[ ! -f "$dep_path" ]]; then
    echo "fix-dylibs: ERROR — $dep_path not found on this machine!"
    return 1
  fi

  echo "fix-dylibs: bundling $dep_path → $BIN_DIR/"
  cp -f "$dep_path" "$dest"
  chmod 755 "$dest"
  BUNDLED_COUNT=$((BUNDLED_COUNT + 1))
  BUNDLED_NAMES="${BUNDLED_NAMES}${lib_name}
"

  install_name_tool -id "@loader_path/$lib_name" "$dest"

  # Check the copied lib for its own transitive deps
  local transitive
  transitive="$(collect_brew_deps "$dest")"
  if [[ -n "$transitive" ]]; then
    while IFS= read -r tdep; do
      [[ -z "$tdep" ]] && continue
      # Add to global dep list if not already there
      if ! grep -qxF "$tdep" "$DEP_LIST"; then
        echo "$tdep" >> "$DEP_LIST"
      fi
      copy_if_needed "$tdep"
    done <<< "$transitive"
  fi
}

while IFS= read -r dep_path; do
  [[ -z "$dep_path" ]] && continue
  copy_if_needed "$dep_path"
done < "$DEP_LIST"

# --- Pass 3: rewrite ALL references in ALL Mach-O binaries ---
for f in "$BIN_DIR"/*; do
  [[ -f "$f" && -x "$f" ]] || continue
  file "$f" | grep -q 'Mach-O' || continue

  while IFS= read -r dep_path; do
    [[ -z "$dep_path" ]] && continue
    lib_name="$(basename "$dep_path")"
    install_name_tool -change "$dep_path" "@loader_path/$lib_name" "$f" 2>/dev/null || true
  done < "$DEP_LIST"
done

echo "fix-dylibs: done. Bundled $BUNDLED_COUNT external dylib(s)."

# --- Verification: fail the build if any non-system absolute paths remain ---
ERRORS=0
for f in "$BIN_DIR"/*; do
  [[ -f "$f" && -x "$f" ]] || continue
  file "$f" | grep -q 'Mach-O' || continue
  remaining="$(collect_brew_deps "$f")"
  if [[ -n "$remaining" ]]; then
    echo "fix-dylibs: ERROR — $(basename "$f") still has non-system dylib dependencies:"
    echo "$remaining" | sed 's/^/  /'
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ $ERRORS -gt 0 ]]; then
  echo "fix-dylibs: FATAL — $ERRORS binary(ies) have unfixed external dylib references. Build cannot continue."
  exit 1
fi

echo "fix-dylibs: verification passed — all Mach-O binaries use only system or @loader_path libs."
