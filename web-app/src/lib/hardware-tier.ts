/**
 * Hardware tiering for the onboarding recommendation.
 *
 * Onboarding advertises ONE model, picked to be the fastest first answer this
 * machine can give — not the largest model that would fit. This module owns
 * that classification and the memory arithmetic behind it, and nothing else.
 *
 * Deliberately pure and unit-free of React so the branch order below — which is
 * the whole subtlety — can be tested directly. All memory figures are **MiB**,
 * matching what `tauri-plugin-hardware` reports (`commands.rs` divides bytes by
 * 1024 twice); keeping MiB throughout avoids a conversion nobody would check.
 *
 * ## Why the tiers look like this (ATO-463)
 *
 * The previous version had exactly two tiers, `low | standard`, split at 16 GiB
 * of RAM or 8 GiB of VRAM. Two problems, both measured:
 *
 *  1. **x86 without an enumerated GPU was hardcoded to `low`.** A workstation
 *     with 128 GiB and no discrete card got the recommendation written for an
 *     8 GiB laptop.
 *  2. **The ceiling was guessed, not measured.** Across 1.1M device×model load
 *     pairs the success rate against `model size ÷ available memory` splits the
 *     two platforms cleanly:
 *
 *     | ratio | Mac loaded | PC loaded |
 *     | --    | --         | --        |
 *     | <0.85 | ~85 %      | ~89 %     |
 *     | 0.85–1.00 | **69 %** | 87 %   |
 *     | 1.00–1.25 | **56 %** | 82 %   |
 *     | 1.50–2.00 | **16 %** | 75 %   |
 *     | 2.00+ | 25 %       | **55 %**  |
 *
 *     **macOS falls off a cliff at 0.85 of unified memory** — Metal refuses the
 *     allocation. **Windows/Linux slope gently** — llama.cpp spills the
 *     overflow into system RAM, so exceeding VRAM costs speed, not the load.
 *     Hence {@link MACOS_LOAD_CEILING} is a hard gate on macOS and a warning
 *     everywhere else; see {@link judgeMemoryFit}.
 */

/**
 * Which rung of the recommendation ladder this machine sits on.
 *
 * Named by the memory pool the weights actually live in rather than by the OS:
 * a Mac and an ARM Windows laptop share one pool between CPU and GPU and are
 * budgeted the same way, while a PC with a card is budgeted on that card. The
 * numeric suffix is the **upper bound of the bucket in GiB** (`vram_8` = cards
 * from 5 to 8 GiB), so the ids sort the way the ladder reads.
 *
 * The vocabulary is a release-time contract: the manifest keys its per-tier
 * lists by these strings (see `recommended-models-registry.ts`). Which models
 * each tier offers can change without a release; the tier set cannot.
 *
 * The top of both ladders used to end at `vram_16_plus` / `unified_32_plus`;
 * they were split into the 24–64+ rungs so the larger models can be offered by
 * size. A manifest that still carries the old keys has them dropped on parse.
 */
export type HardwareTier =
  /** No accelerator enumerated at all. Inference runs on the CPU. */
  | 'cpu_only'
  /** Integrated graphics and old cards: under 2.5 GiB of VRAM. */
  | 'vram_2'
  /** 2.5–5 GiB. */
  | 'vram_4'
  /** 5–9 GiB — the single most populated bucket in the install base. */
  | 'vram_8'
  /** 9–13 GiB. */
  | 'vram_12'
  /** 13–17 GiB. */
  | 'vram_16'
  /** 17–25 GiB: the 20 and 24 GiB cards. */
  | 'vram_24'
  /** 25–33 GiB. */
  | 'vram_32'
  /** 33–49 GiB. */
  | 'vram_48'
  /** 49–65 GiB. */
  | 'vram_64'
  /** 65 GiB and up. */
  | 'vram_64_plus'
  /** Unified memory up to ~8 GiB. */
  | 'unified_8'
  /** ~9–16 GiB. */
  | 'unified_16'
  /** ~17–24 GiB: the 18 and 24 GB Macs. */
  | 'unified_24'
  /** ~25–32 GiB. */
  | 'unified_32'
  /** ~33–48 GiB: the 36 and 48 GB Macs. */
  | 'unified_48'
  /** ~49–64 GiB. */
  | 'unified_64'
  /** 65 GiB and up. */
  | 'unified_64_plus'

/** Every tier, in ladder order. Used to validate manifest keys and dev flags. */
export const HARDWARE_TIERS: readonly HardwareTier[] = [
  'cpu_only',
  'vram_2',
  'vram_4',
  'vram_8',
  'vram_12',
  'vram_16',
  'vram_24',
  'vram_32',
  'vram_48',
  'vram_64',
  'vram_64_plus',
  'unified_8',
  'unified_16',
  'unified_24',
  'unified_32',
  'unified_48',
  'unified_64',
  'unified_64_plus',
] as const

export const isHardwareTier = (value: unknown): value is HardwareTier =>
  typeof value === 'string' &&
  (HARDWARE_TIERS as readonly string[]).includes(value)

/**
 * The next rung down the ladder, within the same memory pool.
 *
 * A card steps down through the VRAM buckets to `cpu_only`; a Mac steps down
 * through the unified buckets and stops at `unified_8` — there is no lighter
 * pool to fall into, and the 8 GiB rung already offers the smallest model. Used
 * when the rung's own recommendation fails {@link judgeMemoryFit}, so the
 * first screen never leads with a model this machine cannot load.
 */
export function stepDownTier(tier: HardwareTier): HardwareTier | null {
  // Derived from the vocabulary so a new rung cannot be left off either ladder.
  const unified = HARDWARE_TIERS.filter((t) => t.startsWith('unified_'))
  const vram = HARDWARE_TIERS.filter((t) => !t.startsWith('unified_'))
  const ladder = unified.includes(tier) ? unified : vram
  const index = ladder.indexOf(tier)
  return index > 0 ? ladder[index - 1] : null
}

/**
 * Which pool the weights are budgeted against.
 *
 * `unified` — one pool shared by CPU and GPU (Apple Silicon, ARM hosts).
 * `vram`    — a discrete or integrated card was enumerated; that card is the
 *             budget, and overflow spills into system RAM at a speed cost.
 * `system`  — no accelerator; the model runs out of system RAM on the CPU.
 */
export type MemoryKind = 'unified' | 'vram' | 'system'

export type HardwareProfile = {
  tier: HardwareTier
  memoryKind: MemoryKind
  /** MiB of the pool the weights will actually occupy. */
  budgetMib: number
  /** System RAM in MiB, whether or not it is the budget. */
  systemRamMib: number
  /** Largest single accelerator in MiB; 0 when none was enumerated. */
  vramMib: number
  /**
   * True when overshooting {@link MACOS_LOAD_CEILING} fails the load outright
   * rather than merely slowing it down. macOS/Metal only — see the table above.
   */
  hardCeiling: boolean
}

export type HardwareTierInput = {
  /** 'windows' | 'macos' | 'linux' | 'unknown', per the hardware plugin. */
  os_type?: string
  cpu?: { arch?: string }
  /** System RAM in MiB. On Apple Silicon this is the unified memory pool. */
  total_memory?: number
  /** Enumerated accelerators, VRAM in MiB. Always empty on macOS — see below. */
  gpus?: Array<{ total_memory?: number }>
}

const MIB = 1024 * 1024
/** MiB in a GiB — every bound below is written in these units. */
const GIB = 1024

/**
 * Fraction of the memory pool a model may occupy and still load on macOS.
 * Measured, not chosen: below it the load-success rate is flat at ~85 %; the
 * first bucket above it drops to 69 %, and 1.5× drops to 16 %.
 */
export const MACOS_LOAD_CEILING = 0.85

/**
 * Fraction a model should occupy to leave room for the KV cache and the
 * runtime's working buffers at a 16k context. This is the *recommendation*
 * rule; {@link MACOS_LOAD_CEILING} is only the "will it load at all" line.
 */
export const COMFORTABLE_MEMORY_SHARE = 0.5

/**
 * VRAM bucket bounds, exclusive upper edge in MiB.
 *
 * The 2.5 GiB first edge is not cosmetic: 741 Windows devices in the base sit
 * below it (integrated graphics and pre-Turing cards) and 888 sit at ~4 GiB.
 * Lumping them into one "≤4 GiB" bucket gave the smaller half a model that
 * leaves no room for its own KV cache.
 */
export const VRAM_TIER_BOUNDS: ReadonlyArray<readonly [number, HardwareTier]> =
  [
    [2.5 * GIB, 'vram_2'],
    [5 * GIB, 'vram_4'],
    [9 * GIB, 'vram_8'],
    [13 * GIB, 'vram_12'],
    [17 * GIB, 'vram_16'],
    [25 * GIB, 'vram_24'],
    [33 * GIB, 'vram_32'],
    [49 * GIB, 'vram_48'],
    [65 * GIB, 'vram_64'],
  ] as const

/**
 * Unified-memory bucket bounds, exclusive upper edge in MiB.
 *
 * Set half a GiB above each nominal size so a machine that reports slightly
 * under its badge (firmware reservations, an 8 GiB Mac reporting 8100-odd)
 * still lands in the bucket its owner would name.
 */
export const UNIFIED_TIER_BOUNDS: ReadonlyArray<
  readonly [number, HardwareTier]
> = [
  [8.5 * GIB, 'unified_8'],
  [16.5 * GIB, 'unified_16'],
  [24.5 * GIB, 'unified_24'],
  [32.5 * GIB, 'unified_32'],
  [48.5 * GIB, 'unified_48'],
  [64.5 * GIB, 'unified_64'],
] as const

/** Matches `arm64`, `aarch64`. Mirrors the check in `AnalyticProvider.tsx`. */
export const isArmArch = (arch?: string): boolean => {
  const a = (arch ?? '').toLowerCase()
  return a.includes('arm') || a.includes('aarch')
}

/**
 * The largest single accelerator, not the sum.
 *
 * The question a tier answers is whether ONE accelerator can hold the model;
 * two 4 GiB cards cannot stand in for an 8 GiB one. (`getMemoryBudgetBytes` in
 * `model-card.ts` sums, which is right for "will this file load somewhere" and
 * wrong here.)
 */
const maxVramMib = (gpus: HardwareTierInput['gpus']): number =>
  (gpus ?? []).reduce((max, gpu) => Math.max(max, gpu.total_memory ?? 0), 0)

const bucket = (
  mib: number,
  bounds: ReadonlyArray<readonly [number, HardwareTier]>,
  above: HardwareTier
): HardwareTier => bounds.find(([edge]) => mib < edge)?.[1] ?? above

/**
 * Everything the recommender needs about this machine, or `null` when hardware
 * has not been enumerated yet (callers pick a conservative default rather than
 * guessing — see `useHardwareTier`).
 *
 * The branch ORDER is load-bearing:
 *
 * 1. **macOS first.** `vendor/vulkan.rs` returns an empty GPU list on macOS
 *    unconditionally (inference goes through Metal; MoltenVK's relative dlopen
 *    breaks under Hardened Runtime), and only NVML + Vulkan GPUs are merged. So
 *    `gpus` is structurally `[]` on *every* Mac, and `gpu_model` / `vram_mb`
 *    arrive as JSON `null` in telemetry. Unified RAM is the only capacity
 *    signal a Mac gives us. Reaching the VRAM branch would read 0 MiB and
 *    classify a 128 GiB M3 Max as the weakest tier. Intel Macs take this branch
 *    too — they report no GPU either.
 * 2. **An accelerator was enumerated → budget on the largest one.** This is
 *    where integrated graphics land as well, which is intended: an iGPU with
 *    2 GiB carved out is a real constraint, not a rounding error.
 * 3. **ARM without a GPU** — Windows-on-ARM and ARM Linux are unified-memory
 *    designs like Apple Silicon, so they get the same buckets. The ceiling
 *    stays soft: they are not going through Metal.
 * 4. **x86 without any GPU → `cpu_only`, regardless of how much RAM there is.**
 *    The old code called this "low spec" and picked by RAM, which is what gave
 *    a 128 GiB workstation an 8 GiB laptop's recommendation. RAM is not the
 *    binding constraint here — CPU token throughput is, and it does not improve
 *    with more of it, so the whole branch gets the lightest model on the
 *    ladder. Capacity is still reported in the profile for the fit badge.
 */
export function describeHardware(
  hw: HardwareTierInput
): HardwareProfile | null {
  const ram = hw.total_memory ?? 0
  const vram = maxVramMib(hw.gpus)

  // 1. macOS — unified memory, GPU list is always empty here.
  if (hw.os_type === 'macos') {
    if (ram <= 0) return null
    return {
      tier: bucket(ram, UNIFIED_TIER_BOUNDS, 'unified_64_plus'),
      memoryKind: 'unified',
      budgetMib: ram,
      systemRamMib: ram,
      vramMib: 0,
      hardCeiling: true,
    }
  }

  // 2. A real accelerator was enumerated (discrete or integrated).
  if (vram > 0) {
    return {
      tier: bucket(vram, VRAM_TIER_BOUNDS, 'vram_64_plus'),
      memoryKind: 'vram',
      budgetMib: vram,
      systemRamMib: ram,
      vramMib: vram,
      hardCeiling: false,
    }
  }

  // Nothing reported at all — hardware detection has not run yet.
  if (ram <= 0) return null

  // 3. ARM without a discrete GPU: unified memory, same buckets as macOS.
  if (isArmArch(hw.cpu?.arch)) {
    return {
      tier: bucket(ram, UNIFIED_TIER_BOUNDS, 'unified_64_plus'),
      memoryKind: 'unified',
      budgetMib: ram,
      systemRamMib: ram,
      vramMib: 0,
      hardCeiling: false,
    }
  }

  // 4. x86 with no accelerator at all.
  return {
    tier: 'cpu_only',
    memoryKind: 'system',
    budgetMib: ram,
    systemRamMib: ram,
    vramMib: 0,
    hardCeiling: false,
  }
}

/** Convenience wrapper for callers that only need the ladder rung. */
export function classifyHardwareTier(
  hw: HardwareTierInput
): HardwareTier | null {
  return describeHardware(hw)?.tier ?? null
}

/**
 * How a model of this size sits in this machine's memory.
 *
 * `comfortable` — under half the budget, so the KV cache and working buffers
 *                 fit alongside it at a normal context length.
 * `tight`       — it fits, but the context window is what pays for it.
 * `spills`      — larger than the budget. On a card that means llama.cpp pages
 *                 the overflow through system RAM: slower, still usable, and
 *                 measured at 55–75 % success even at 2× overshoot.
 * `wont_load`   — macOS only. Past {@link MACOS_LOAD_CEILING} Metal refuses the
 *                 allocation; a 16 GiB Mac given a 20 GiB model failed to load
 *                 on 87.5 % of device×model pairs.
 *
 * `null` when either figure is unknown — callers must not turn "we don't know"
 * into a warning.
 */
export type MemoryFit = 'comfortable' | 'tight' | 'spills' | 'wont_load'

export function judgeMemoryFit(
  sizeBytes: number | undefined,
  profile: HardwareProfile | null
): MemoryFit | null {
  if (!sizeBytes || sizeBytes <= 0) return null
  if (!profile || profile.budgetMib <= 0) return null

  const ratio = sizeBytes / (profile.budgetMib * MIB)
  if (ratio <= COMFORTABLE_MEMORY_SHARE) return 'comfortable'
  if (profile.hardCeiling) {
    return ratio <= MACOS_LOAD_CEILING ? 'tight' : 'wont_load'
  }
  return ratio <= 1 ? 'tight' : 'spills'
}

/**
 * Largest model file this machine will load at all, in bytes.
 *
 * On macOS that is a real limit. Elsewhere it is the point past which the
 * runtime starts paging through system RAM, which is a speed warning rather
 * than a wall — so the figure is the budget itself, not a fraction of it.
 */
export function memoryCeilingBytes(profile: HardwareProfile | null): number {
  if (!profile || profile.budgetMib <= 0) return 0
  const budget = profile.budgetMib * MIB
  return profile.hardCeiling ? budget * MACOS_LOAD_CEILING : budget
}
