#!/usr/bin/env bash
# Print the TurboQuant backend id this host would run at runtime.
#
# Mirrors the probe the app performs in
# src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs (`get_supported_features`
# + `determine_supported_backends`): CUDA 13.3 > CUDA 12.4 > ROCm > Vulkan, with
# the same driver floors and the same ROCm gfx allow-list. Keep the two in sync;
# this script exists so the dev loop can bundle what the app would download,
# instead of always the offline Vulkan fallback.
set -euo pipefail

# Linux driver floors, from get_supported_features().
MIN_CUDA12_DRIVER='525.60.13'
MIN_CUDA13_DRIVER='580'
# amdkfd gfx_target_version values the fork's linux-x64-rocm archive is built
# for (RDNA2-RDNA4). Older GCN cards must use Vulkan.
ROCM_GFX_TARGETS='100300 110000 110100 110200 115100 120000 120100'

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

newest_nvidia_driver() {
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null |
    tr -d ' \r' | grep -E '^[0-9]' | sort -V | tail -n 1
}

# A non-zero gfx_target_version in amdkfd is itself the AMD-device signal.
has_supported_amd_gpu() {
  local properties version
  for properties in /sys/class/kfd/kfd/topology/nodes/*/properties; do
    [ -r "$properties" ] || continue
    while read -r version; do
      case " $ROCM_GFX_TARGETS " in
        *" $version "*) return 0 ;;
      esac
    done < <(awk '/^gfx_target_version /{print $2}' "$properties")
  done
  return 1
}

# The archive links against libamdhip64.so, so its presence is the cheapest
# honest signal that a ROCm build can start here.
has_rocm_runtime() {
  local dir
  for dir in /opt/rocm/lib /opt/rocm/lib64 /usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib; do
    [ -e "$dir/libamdhip64.so" ] && return 0
  done
  for dir in /opt/rocm-*; do
    [ -e "$dir/lib/libamdhip64.so" ] && return 0
    [ -e "$dir/lib64/libamdhip64.so" ] && return 0
  done
  return 1
}

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    if [ "$arch" != "arm64" ]; then
      echo "Error: no verified macOS x64 TurboQuant release exists." >&2
      exit 1
    fi
    echo "macos-arm64"
    ;;
  Linux)
    if [ "$arch" != "x86_64" ]; then
      echo "Error: the fork publishes no Linux ${arch} build." >&2
      exit 1
    fi
    driver="$(newest_nvidia_driver || true)"
    if [ -n "$driver" ] && version_ge "$driver" "$MIN_CUDA13_DRIVER"; then
      echo "NVIDIA driver $driver clears the CUDA 13 floor ($MIN_CUDA13_DRIVER)" >&2
      echo "linux-x64-cuda-13.3"
    elif [ -n "$driver" ] && version_ge "$driver" "$MIN_CUDA12_DRIVER"; then
      echo "NVIDIA driver $driver clears the CUDA 12 floor ($MIN_CUDA12_DRIVER)" >&2
      echo "linux-x64-cuda-12.4"
    elif has_supported_amd_gpu && has_rocm_runtime; then
      echo "Supported AMD device and a ROCm runtime found" >&2
      echo "linux-x64-rocm"
    else
      echo "No CUDA/ROCm tier applies; Vulkan also carries the CPU path" >&2
      echo "linux-x64-vulkan"
    fi
    ;;
  *)
    echo "Error: unsupported platform '$os'." >&2
    exit 1
    ;;
esac
