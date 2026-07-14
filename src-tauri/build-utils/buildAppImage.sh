#!/bin/bash
set -euo pipefail

# Post-process the AppImage produced by `tauri build` so the bundled
# `bun` binary (and any other engine resources) are available inside the
# AppImage runtime. `tauri build` produces a barebones AppImage that
# does not know about resources we inject outside `tauri.linux.conf.json`,
# so we unpack the AppDir, drop the extras in, and repackage with
# upstream `appimagetool`.
#
# Product name is "Atomic Chat" (with a space) — preserve quoting
# everywhere or the spaces will silently break the build.

RUNTIME="./.cache/build-tools/type2-runtime-x86_64"
RELEASE_CHANNEL=${RELEASE_CHANNEL:-"stable"}
PRODUCT_NAME="Atomic Chat"

# We assemble the AppImage ourselves (runtime + squashfs concatenation)
# instead of using appimagetool: the "continuous" appimagetool bundles a
# zstd-only mksquashfs, and zstd squashfs cannot be mounted by
# AppImageLauncher's squashfuse — integration and launch break for
# AppImageLauncher users (GH #164). System mksquashfs supports gzip.
command -v mksquashfs >/dev/null \
  || { echo "mksquashfs not found; install squashfs-tools."; exit 1; }

mkdir -p ./.cache/build-tools
if [ ! -f "${RUNTIME}" ]; then
  wget https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64 -O "${RUNTIME}" \
    || { echo "Failed to download AppImage type2 runtime."; exit 1; }
fi

if [ "${RELEASE_CHANNEL}" != "stable" ]; then
  APP_DIR="./src-tauri/target/release/bundle/appimage/${PRODUCT_NAME}-${RELEASE_CHANNEL}.AppDir"
  LIB_DIR="${APP_DIR}/usr/lib/${PRODUCT_NAME}-${RELEASE_CHANNEL}/binaries"
else
  APP_DIR="./src-tauri/target/release/bundle/appimage/${PRODUCT_NAME}.AppDir"
  LIB_DIR="${APP_DIR}/usr/lib/${PRODUCT_NAME}/binaries"
fi

if [ ! -d "${APP_DIR}" ]; then
  echo "AppDir not found at: ${APP_DIR}"
  echo "Contents of bundle/appimage/:"
  ls -la ./src-tauri/target/release/bundle/appimage/ || true
  exit 1
fi

# Bundle additional resources in the AppDir without pulling in their
# dependencies (linuxdeploy would otherwise drag in libc / libstdc++
# copies we do not want).
cp ./src-tauri/resources/bin/bun "${APP_DIR}/usr/bin/bun"
mkdir -p "${LIB_DIR}/engines"

# Remove the AppImage produced by `tauri build` — we are about to
# repackage from the unpacked AppDir.
APP_IMAGE_FILE=$(ls ./src-tauri/target/release/bundle/appimage/ | grep -E '\.AppImage$' | head -1 || true)
if [ -n "${APP_IMAGE_FILE}" ]; then
  APP_IMAGE="./src-tauri/target/release/bundle/appimage/${APP_IMAGE_FILE}"
  echo "Removing tauri-produced AppImage: ${APP_IMAGE}"
  rm -f "${APP_IMAGE}"
else
  echo "No existing AppImage from tauri build; will create from scratch"
  APP_IMAGE="./src-tauri/target/release/bundle/appimage/${PRODUCT_NAME}.AppImage"
fi

# Repackage AppImage with our additional resources baked in: an AppImage
# is the type2 runtime binary with a squashfs of the AppDir appended.
# gzip compression is required for AppImageLauncher compatibility (see
# header comment).
SQUASHFS="${APP_IMAGE}.squashfs"
rm -f "${SQUASHFS}"
mksquashfs "${APP_DIR}" "${SQUASHFS}" -comp gzip -root-owned -noappend -quiet
cat "${RUNTIME}" "${SQUASHFS}" > "${APP_IMAGE}"
rm -f "${SQUASHFS}"
chmod +x "${APP_IMAGE}"
echo "AppImage created: ${APP_IMAGE}"
