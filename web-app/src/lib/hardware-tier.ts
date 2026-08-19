/**
 * Hardware tiering for the onboarding recommendations.
 *
 * Onboarding advertises a different pair of models on weak machines, so the
 * first model a new user downloads is one their hardware can actually run.
 * This module owns that classification and nothing else.
 *
 * Deliberately pure and unit-free of React so the branch order below — which is
 * the whole subtlety — can be tested directly. All memory figures are **MiB**,
 * matching what `tauri-plugin-hardware` reports (`commands.rs` divides bytes by
 * 1024 twice); keeping MiB throughout avoids a conversion nobody would check.
 */

export type HardwareTier = 'low' | 'standard'

export type HardwareTierInput = {
  /** 'windows' | 'macos' | 'linux' | 'unknown', per the hardware plugin. */
  os_type?: string
  cpu?: { arch?: string }
  /** System RAM in MiB. On Apple Silicon this is the unified memory pool. */
  total_memory?: number
  /** Enumerated accelerators, VRAM in MiB. Always empty on macOS — see below. */
  gpus?: Array<{ total_memory?: number }>
}

/** Apple Silicon shares one pool between CPU and GPU, so RAM is the budget. */
export const LOW_SPEC_UNIFIED_MEMORY_MIB = 16 * 1024

/** Below this, a discrete GPU cannot hold a useful quant plus its context. */
export const LOW_SPEC_VRAM_MIB = 8 * 1024

/** Matches `arm64`, `aarch64`. Mirrors the check in `AnalyticProvider.tsx`. */
export const isArmArch = (arch?: string): boolean => {
  const a = (arch ?? '').toLowerCase()
  return a.includes('arm') || a.includes('aarch')
}

const maxVramMib = (gpus: HardwareTierInput['gpus']): number =>
  (gpus ?? []).reduce((max, gpu) => Math.max(max, gpu.total_memory ?? 0), 0)

/**
 * Which tier this machine belongs to, or `null` when hardware has not been
 * enumerated yet (callers default to `'standard'` rather than downgrading a
 * fast machine for being slow to report).
 *
 * The branch ORDER is load-bearing:
 *
 * 1. **macOS first.** `vendor/vulkan.rs` returns an empty GPU list on macOS
 *    unconditionally (inference goes through Metal; MoltenVK's relative dlopen
 *    breaks under Hardened Runtime), and only NVML + Vulkan GPUs are merged. So
 *    `gpus` is structurally `[]` on *every* Mac. Reaching the VRAM branch would
 *    read 0 MiB and classify a 128 GB M3 Max as low-spec. Intel Macs take this
 *    branch too — they report no GPU either, so RAM is the only signal there.
 * 2. **Enumerated GPU → max VRAM, not the sum.** The question is whether one
 *    accelerator can hold the model; two 4 GB cards cannot stand in for an 8 GB
 *    one. (`getMemoryBudgetBytes` in `model-card.ts` sums, which is right for
 *    "will this file load" and wrong here.)
 * 3. **ARM without a GPU** — Windows-on-ARM and ARM Linux are unified-memory
 *    designs like Apple Silicon, so they get the same RAM rule.
 * 4. **x86 without a GPU** — integrated graphics only. Reads as low-spec by the
 *    literal rule (0 < 8 GiB), which is also the right answer in practice.
 */
export function classifyHardwareTier(
  hw: HardwareTierInput
): HardwareTier | null {
  const ram = hw.total_memory ?? 0
  const gpus = hw.gpus ?? []

  // 1. macOS — unified memory, GPU list is always empty here.
  if (hw.os_type === 'macos') {
    if (ram <= 0) return null
    return ram < LOW_SPEC_UNIFIED_MEMORY_MIB ? 'low' : 'standard'
  }

  // 2. A real accelerator was enumerated.
  if (gpus.length > 0) {
    return maxVramMib(gpus) < LOW_SPEC_VRAM_MIB ? 'low' : 'standard'
  }

  // Nothing reported at all — hardware detection has not run yet.
  if (ram <= 0) return null

  // 3. ARM without a discrete GPU: unified memory, same rule as macOS.
  if (isArmArch(hw.cpu?.arch)) {
    return ram < LOW_SPEC_UNIFIED_MEMORY_MIB ? 'low' : 'standard'
  }

  // 4. x86 with integrated graphics only.
  return 'low'
}
