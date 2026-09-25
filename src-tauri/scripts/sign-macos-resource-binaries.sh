#!/usr/bin/env bash
#* Sign Mach-O binaries in resources/bin before bundling: otherwise the copy in Contents/Resources/… is unsigned
#* and notarytool rejects the archive ("The binary is not signed" for jan-cli, etc.).
#? If APPLE_SIGNING_IDENTITY is not set, exit (local unsigned builds).
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  exit 0
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENT="$HERE/Entitlements.plist"
SIDE_ENT="$HERE/Entitlements.sidecar.plist"
BIN="$HERE/resources/bin"
[[ -d "$BIN" ]] || exit 0
[[ -f "$ENT" ]] || { echo "sign-macos-resource-binaries: missing $ENT"; exit 1; }
[[ -f "$SIDE_ENT" ]] || { echo "sign-macos-resource-binaries: missing $SIDE_ENT"; exit 1; }

#? Sign only executable Mach-O files (not .bundle, not arbitrary files).
sign_if_macho() {
  local f="$1"
  [[ -f "$f" && -x "$f" ]] || return 0
  if file "$f" | grep -q 'Mach-O'; then
    echo "codesign (resources): $f"
    local entitlements="$ENT"
    case "$(basename "$f")" in
      jan-cli|atomic-chat-core) entitlements="$SIDE_ENT" ;;
    esac
    codesign --force --sign "$IDENTITY" --options runtime --timestamp --entitlements "$entitlements" "$f"
  fi
}

for name in jan-cli atomic-chat-core mlx-server foundation-models-server; do
  sign_if_macho "$BIN/$name"
done

#? llamacpp-backend Mach-O binaries (turboquant fork + upstream ggml-org)
for sub in llamacpp-backend llamacpp-backend-upstream; do
  LLAMA_BIN="$HERE/resources/$sub/build/bin"
  if [[ -d "$LLAMA_BIN" ]]; then
    for f in "$LLAMA_BIN"/*; do
      sign_if_macho "$f"
    done
  fi
done

#? sqlite-vec etc. — if notary errors appear, add them here or extend the loop.
