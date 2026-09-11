/**
 * Which stable-diffusion.cpp prebuilt this host should run.
 *
 * Pure: the caller gathers the OS, arch, the feature probe from
 * `plugin:llamacpp-upstream|get_supported_features` and the GPU list, and
 * hands over the backend ids the manifest actually lists. The ladder mirrors
 * the llama.cpp providers' policy in AGENTS.md §3 — a backend is a property of
 * the pinned release, so an id the manifest does not carry is skipped rather
 * than guessed at.
 *
 * Linux has no CUDA prebuilt from leejet (nor from ggml-org), so NVIDIA hosts
 * there run Vulkan until the diffusers sidecar (phase 1b) lands. Windows ROCm
 * is not in every tag; when absent the host falls through to Vulkan.
 */

import type { DiffusionBackend } from './types'

/**
 * Smallest Vulkan device worth moving a Linux host off the CPU build for.
 * Mirrors `LINUX_VULKAN_MIN_VRAM_MIB` in
 * `extensions/llamacpp-upstream-extension/src/index.ts` (the web app cannot
 * import extension source); keep the two in step.
 */
export const LINUX_VULKAN_MIN_VRAM_MIB = 2 * 1024

export type DiffusionHostOs = 'macos' | 'windows' | 'linux'
export type DiffusionHostArch = 'arm64' | 'x64'

export type DiffusionBackendSelectionInput = {
  os: DiffusionHostOs
  arch: DiffusionHostArch
  features: {
    cuda12?: boolean
    cuda13?: boolean
    vulkan?: boolean
    rocm?: boolean
  }
  gpus: { vendor?: string; totalMemoryMib?: number }[]
  /** Backend ids the manifest lists (companions included or not; they never match). */
  available: string[]
}

/** Windows CUDA 12 build; a CUDA 13-only driver still runs it. */
const WIN_CUDA12 = 'win-cuda12-x64'
const WIN_ROCM_RE = /^win-rocm-(\d+(?:\.\d+)*)-x64$/
const WIN_VULKAN = 'win-vulkan-x64'
const WIN_CPU = 'win-cpu-x64'
const LINUX_VULKAN = 'linux-vulkan-x64'
const LINUX_CPU = 'linux-cpu-x64'
const MACOS_ARM64 = 'macos-arm64'
const WIN_CUDART_CU12 = 'win-cudart-cu12'

const versionKey = (version: string): number[] =>
  version.split('.').map((part) => Number(part))

const compareVersions = (a: number[], b: number[]): number => {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The highest-versioned id matching `pattern`, or null when the tag ships none. */
const pickVersioned = (available: string[], pattern: RegExp): string | null => {
  let best: { id: string; key: number[] } | null = null
  for (const id of available) {
    const match = pattern.exec(id)
    if (!match) continue
    const key = versionKey(match[1])
    if (!best || compareVersions(key, best.key) > 0) best = { id, key }
  }
  return best?.id ?? null
}

const firstAvailable = (
  available: string[],
  candidates: (string | null)[]
): string | null =>
  candidates.find((id): id is string => id !== null && available.includes(id)) ??
  null

/**
 * The backend id to install, or `null` when this host cannot run any build
 * the manifest ships (Intel Macs, ARM Windows/Linux, an empty manifest).
 */
export function selectDiffusionBackend(
  input: DiffusionBackendSelectionInput
): string | null {
  const { os, arch, features, gpus, available } = input

  if (os === 'macos') {
    return arch === 'arm64' ? firstAvailable(available, [MACOS_ARM64]) : null
  }
  if (arch !== 'x64') return null

  if (os === 'windows') {
    const cuda = features.cuda12 || features.cuda13 ? WIN_CUDA12 : null
    const rocm = features.rocm ? pickVersioned(available, WIN_ROCM_RE) : null
    const vulkan = features.vulkan ? WIN_VULKAN : null
    return firstAvailable(available, [cuda, rocm, vulkan, WIN_CPU])
  }

  // Linux: Vulkan is the only accelerated prebuilt, and only when the loader
  // enumerated a device big enough to hold a checkpoint beside its activations.
  const anyVulkanDevice = gpus.some(
    (gpu) => (gpu.totalMemoryMib ?? 0) >= LINUX_VULKAN_MIN_VRAM_MIB
  )
  const vulkan = features.vulkan && anyVulkanDevice ? LINUX_VULKAN : null
  return firstAvailable(available, [vulkan, LINUX_CPU])
}

/** The companion archive a backend needs unpacked beside it, if any. */
export function companionFor(backendId: string): 'win-cudart-cu12' | null {
  return backendId === WIN_CUDA12 ? WIN_CUDART_CU12 : null
}

/** The compute backend a manifest id was built for, for the install record. */
export function backendKindOf(backendId: string): DiffusionBackend {
  if (backendId.startsWith('macos-')) return 'metal'
  if (backendId.includes('-cuda')) return 'cuda'
  if (backendId.includes('-rocm')) return 'rocm'
  if (backendId.includes('-vulkan')) return 'vulkan'
  return 'cpu'
}
