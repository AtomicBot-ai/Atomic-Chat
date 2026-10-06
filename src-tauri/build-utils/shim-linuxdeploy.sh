#!/usr/bin/env bash
set -euo pipefail

# wrapper script to pin linuxdeploy version and inject environment variables into the 
# build process. While yarn supports injecting environment vairables via env files,
# this applies to all yarn scripts. Using a wrapper allows granular control over
# when environment variables are injected, and avoids tainting the system .cache

# avoid redownloading corepack if possible
export COREPACK_HOME=${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}
# move cache home to <project root>/.cache
export XDG_CACHE_HOME=${PWD}/.cache

LINUXDEPLOY_VER="1-alpha-20250213-2"
# x86_64 or aarch64: the name tauri-bundler looks for and linuxdeploy publishes.
ARCH="$(uname -m)"
LINUXDEPLOY="$XDG_CACHE_HOME/tauri/linuxdeploy-$LINUXDEPLOY_VER-$ARCH.AppImage"
SYMLINK="$XDG_CACHE_HOME/tauri/linuxdeploy-$ARCH.AppImage"

mkdir -p "$XDG_CACHE_HOME/tauri"

if [ ! -f "$LINUXDEPLOY" ]; then
  GLOB_PATTERN="$XDG_CACHE_HOME/tauri/linuxdeploy-*-$ARCH.AppImage"
  rm -f $GLOB_PATTERN
  wget "https://github.com/linuxdeploy/linuxdeploy/releases/download/$LINUXDEPLOY_VER/linuxdeploy-$ARCH.AppImage" -O "$LINUXDEPLOY"
  chmod a+x "$LINUXDEPLOY"
fi

rm -f "$SYMLINK"
ln -s "$LINUXDEPLOY" "$SYMLINK"

"$@"