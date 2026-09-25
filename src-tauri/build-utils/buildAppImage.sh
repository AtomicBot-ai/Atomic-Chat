#!/bin/bash
set -euo pipefail

# Post-process the AppImage produced by `tauri build` so the bundled
# `bun` binary (and any other engine resources) are available inside the
# AppImage runtime. `tauri build` produces a barebones AppImage that
# does not know about resources we inject outside `tauri.linux.conf.json`,
# so we add the extras to its AppDir and repackage it below.
#
# Product name is "Atomic Chat" (with a space) — preserve quoting
# everywhere or the spaces will silently break the build.

RUNTIME="./.cache/build-tools/type2-runtime-x86_64"
RELEASE_CHANNEL=${RELEASE_CHANNEL:-"stable"}
PRODUCT_NAME="Atomic Chat"

command -v mksquashfs >/dev/null \
  || { echo "mksquashfs not found; install squashfs-tools."; exit 1; }

mkdir -p ./.cache/build-tools
if [ ! -f "${RUNTIME}" ]; then
  wget https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64 -O "${RUNTIME}" \
    || { echo "Failed to download AppImage type2 runtime."; exit 1; }
fi

if [ "${RELEASE_CHANNEL}" != "stable" ]; then
  APP_DIR="./src-tauri/target/release/bundle/appimage/${PRODUCT_NAME}-${RELEASE_CHANNEL}.AppDir"
  PKG_DIR="${APP_DIR}/usr/lib/${PRODUCT_NAME}-${RELEASE_CHANNEL}"
else
  APP_DIR="./src-tauri/target/release/bundle/appimage/${PRODUCT_NAME}.AppDir"
  PKG_DIR="${APP_DIR}/usr/lib/${PRODUCT_NAME}"
fi
LIB_DIR="${PKG_DIR}/binaries"
# Where `tauri build` installs `bundle.resources` (tauri-bundler puts them in
# usr/lib/<product name>/), and so where the app's resource_dir() resolves.
RES_BIN_DIR="${PKG_DIR}/resources/bin"

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

# The atomic-chat-core pair (and jan-cli, a copy of the core) are `bun
# --compile` binaries: the payload is ~5MB appended after the ELF sections.
# linuxdeploy walks every ELF under usr/lib, runs ldd on it and rewrites its
# rpath with patchelf — and patchelf drops that trailing payload, which is why
# these are kept out of `bundle.resources` in tauri.linux.conf.json and copied
# in here instead, after linuxdeploy has run. Same reason as `bun` above.
mkdir -p "${RES_BIN_DIR}"
for core_binary in atomic-chat-core atomic-chat-app-core jan-cli; do
  src="./src-tauri/resources/bin/${core_binary}"
  if [ ! -f "${src}" ]; then
    echo "Missing ${src}; run \`yarn download:core\` and \`yarn build:cli\` before this script."
    exit 1
  fi
  cp "${src}" "${RES_BIN_DIR}/${core_binary}"
  chmod +x "${RES_BIN_DIR}/${core_binary}"
done
# An intact payload still runs; a patchelf'd or truncated one does not.
"${RES_BIN_DIR}/atomic-chat-core" --version >/dev/null \
  || { echo "The bundled atomic-chat-core does not run — its bun payload is damaged."; exit 1; }

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

# AppImageLauncher's squashfuse cannot mount the zstd image produced by
# appimagetool continuous. Assemble a type-2 AppImage with gzip instead.
SQUASHFS="${APP_IMAGE}.squashfs"
rm -f "${SQUASHFS}"
mksquashfs "${APP_DIR}" "${SQUASHFS}" -comp gzip -root-owned -noappend -quiet
cat "${RUNTIME}" "${SQUASHFS}" > "${APP_IMAGE}"
rm -f "${SQUASHFS}"
chmod +x "${APP_IMAGE}"
echo "AppImage created: ${APP_IMAGE}"
