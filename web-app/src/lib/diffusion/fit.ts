/**
 * Will this checkpoint fit, and how should it be offloaded?
 *
 * Resident memory while sampling is roughly the transformer plus the VAE plus
 * the text encoder (unless it is pinned to the CPU, as it always is under
 * Metal) plus the activations, which scale with the output area — about
 * 1.5 GiB at one megapixel for the families we ship.
 *
 * The budget is the same pool `hardware-tier.ts` budgets chat models on, in
 * **MiB** (what the hardware plugin reports); everything here converts to
 * bytes once, up front. On macOS the measured {@link MACOS_LOAD_CEILING} is a
 * hard gate — Metal refuses the allocation past it — so the budget is scaled
 * down by it before the thresholds apply.
 *
 * On unified memory that gate is not the only one. A text encoder pinned to
 * the CPU is outside Metal's allocation but inside the same RAM, next to the
 * OS and the app: an 8 GB Mac passed Z-Image Q3_K_M as "might fit" on the
 * GPU side while the whole model needed ~6.5 GB of its RAM, and the render
 * swapped until the engine stopped (QA 2026-10-23). So the verdict is also
 * checked against RAM less {@link UNIFIED_RESERVE_BYTES}, text encoder
 * included, and the worse of the two is shown; the offload policy stays the
 * GPU side's, since offloading on unified memory saves no RAM.
 */

import type {
  DiffusionCatalogFamily,
  DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import type { DiffusionOffloadPolicy } from '@/services/diffusion/types'
import { MACOS_LOAD_CEILING, type HardwareProfile } from '@/lib/hardware-tier'

export type DiffusionFit = 'ok' | 'maybe' | 'no'

export type DiffusionFitInput = {
  transformerBytes: number
  vaeBytes: number
  teBytes: number
  /** True when the text encoder runs on the CPU (always under Metal). */
  teOnCpu: boolean
  width: number
  height: number
}

export type DiffusionFitEstimate = {
  fit: DiffusionFit
  policy: DiffusionOffloadPolicy
  /** English, for logs and the tooltip fallback; the UI keys its own copy on `fit`. */
  reason: string
  residentBytes: number
  /** Effective budget in bytes; null when hardware is not known yet. */
  budgetBytes: number | null
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Activation working set at one megapixel; scales linearly with area. */
export const ACTIVATION_BYTES_PER_MEGAPIXEL = 1.5 * GIB
const MEGAPIXEL = 1024 * 1024

/** Up to this share of the budget the model runs fully resident. */
export const FIT_OK_SHARE = 0.7
/** Up to this share it runs with group offload; past it, model offload. */
export const FIT_MAYBE_SHARE = 0.9

/**
 * RAM a unified-memory machine keeps for the OS and the app: the reserve the
 * core budgets every local model with (`RESERVE_BYTES`, ≈ 2.1 GiB).
 */
export const UNIFIED_RESERVE_BYTES = 2_288_490_189

const gb = (bytes: number): string => (bytes / GIB).toFixed(1)

export function estimateResidentBytes(input: DiffusionFitInput): number {
  const activations =
    ACTIVATION_BYTES_PER_MEGAPIXEL * ((input.width * input.height) / MEGAPIXEL)
  return (
    input.transformerBytes +
    input.vaeBytes +
    (input.teOnCpu ? 0 : input.teBytes) +
    activations
  )
}

/** Every byte the checkpoint holds while sampling, the text encoder included wherever it runs. */
export function estimateFootprintBytes(input: DiffusionFitInput): number {
  return estimateResidentBytes({ ...input, teOnCpu: false })
}

const FIT_RANK: Record<DiffusionFit, number> = { ok: 0, maybe: 1, no: 2 }

const fitOfShare = (share: number): DiffusionFit =>
  share <= FIT_OK_SHARE ? 'ok' : share <= FIT_MAYBE_SHARE ? 'maybe' : 'no'

export function estimateDiffusionFit(
  input: DiffusionFitInput,
  profile: HardwareProfile | null
): DiffusionFitEstimate {
  const gpu = estimateGpuFit(input, profile)
  if (!profile || profile.memoryKind !== 'unified' || !input.teOnCpu) return gpu
  // The CPU-side text encoder shares this RAM with everything else.
  const ramBytes = profile.systemRamMib * MIB
  if (ramBytes <= 0) return gpu
  const budgetBytes = Math.max(0, ramBytes - UNIFIED_RESERVE_BYTES)
  const footprint = estimateFootprintBytes(input)
  const fit = budgetBytes > 0 ? fitOfShare(footprint / budgetBytes) : 'no'
  if (FIT_RANK[fit] <= FIT_RANK[gpu.fit]) return gpu
  return {
    fit,
    policy: gpu.policy,
    reason:
      fit === 'no'
        ? `Needs about ${gb(footprint)} GB of memory with its text encoder, but only ${gb(budgetBytes)} GB is free for it; expect heavy swapping and a very slow image.`
        : `Needs about ${gb(footprint)} GB of memory with its text encoder, of ${gb(budgetBytes)} GB free for it.`,
    residentBytes: footprint,
    budgetBytes,
  }
}

/** The verdict against the pool the GPU allocates from: Metal's ceiling, VRAM, or RAM. */
function estimateGpuFit(
  input: DiffusionFitInput,
  profile: HardwareProfile | null
): DiffusionFitEstimate {
  const residentBytes = estimateResidentBytes(input)
  if (!profile || profile.budgetMib <= 0) {
    return {
      fit: 'maybe',
      policy: 'group',
      reason: `Needs about ${gb(residentBytes)} GB; this computer's memory is not known yet.`,
      residentBytes,
      budgetBytes: null,
    }
  }
  const poolBytes = profile.budgetMib * MIB
  const budgetBytes = profile.hardCeiling
    ? poolBytes * MACOS_LOAD_CEILING
    : poolBytes
  const share = residentBytes / budgetBytes
  if (share <= FIT_OK_SHARE) {
    return {
      fit: 'ok',
      policy: 'none',
      reason: `Needs about ${gb(residentBytes)} GB of ${gb(budgetBytes)} GB available.`,
      residentBytes,
      budgetBytes,
    }
  }
  if (share <= FIT_MAYBE_SHARE) {
    return {
      fit: 'maybe',
      policy: 'group',
      reason: `Needs about ${gb(residentBytes)} GB of ${gb(budgetBytes)} GB available; weights will be offloaded in groups.`,
      residentBytes,
      budgetBytes,
    }
  }
  return {
    fit: 'no',
    policy: 'model',
    reason: `Needs about ${gb(residentBytes)} GB but only ${gb(budgetBytes)} GB is available; expect slow, CPU-offloaded generation.`,
    residentBytes,
    budgetBytes,
  }
}

export type AutoOffload = {
  offload: DiffusionOffloadPolicy
  /** Where the core moves the model if `offload` runs out of memory. */
  offloadFallback?: DiffusionOffloadPolicy
}

/**
 * What the "Auto" memory setting asks the core for.
 *
 * With a GPU of its own the model starts on it, whatever the estimate says:
 * the estimate counts every part as resident at once and keeps a wide margin,
 * so on a 12 GB card it offloaded models that run there in a fraction of the
 * time. Offloading is left to the core, which takes the estimate's policy only
 * when the GPU actually runs out — or `group` when the estimate saw no need,
 * since it prices the family's default size and a larger image can still run
 * out.
 *
 * Unified memory and CPU-only machines keep the estimate's policy: Metal has
 * a hard ceiling that fails loudly (see `MACOS_LOAD_CEILING`), and there is no
 * GPU to keep anything on.
 */
export function autoOffload(
  fit: DiffusionFitEstimate,
  profile: HardwareProfile | null,
  opts: { macos: boolean; familyId: string }
): AutoOffload {
  if (opts.macos) {
    // Qwen-Image's Wan VAE needs a large temporary decode buffer on Metal.
    // Keeping the VAE on the GPU can produce a command-buffer page fault even
    // when the static weights fit; the fault corrupts the first image and
    // poisons the backend for every later request. Full model offload keeps
    // the VAE on CPU while Metal still runs the denoiser.
    return { offload: opts.familyId === 'qwen-image' ? 'model' : fit.policy }
  }
  if (profile?.memoryKind === 'vram') {
    return {
      offload: 'none',
      offloadFallback: fit.policy === 'none' ? 'group' : fit.policy,
    }
  }
  return { offload: fit.policy }
}

const textEncoderBytes = (family: DiffusionCatalogFamily): number =>
  family.text_encoders.reduce((sum, encoder) => sum + encoder.bytes, 0)

/**
 * The fit of one quant at the family's default size, or at the size a
 * request asks for (what Generate checks before it starts).
 */
export function fitForQuant(
  family: DiffusionCatalogFamily,
  quant: DiffusionCatalogQuant,
  profile: HardwareProfile | null,
  opts: { teOnCpu: boolean; width?: number; height?: number }
): DiffusionFitEstimate {
  return estimateDiffusionFit(
    {
      transformerBytes: quant.bytes,
      vaeBytes: (family.vae?.bytes ?? 0) + (family.audio_vae?.bytes ?? 0),
      teBytes: textEncoderBytes(family),
      teOnCpu: opts.teOnCpu,
      width: opts.width ?? family.defaults.width,
      height: opts.height ?? family.defaults.height,
    },
    profile
  )
}

const largest = (quants: DiffusionCatalogQuant[]): DiffusionCatalogQuant | undefined =>
  quants.reduce<DiffusionCatalogQuant | undefined>(
    (best, quant) => (!best || quant.bytes > best.bytes ? quant : best),
    undefined
  )

const smallest = (quants: DiffusionCatalogQuant[]): DiffusionCatalogQuant =>
  quants.reduce((best, quant) => (quant.bytes < best.bytes ? quant : best))

const defaultTeOnCpu = (): boolean =>
  typeof IS_MACOS !== 'undefined' && Boolean(IS_MACOS)

/**
 * The quant to recommend on this machine, regardless of what is on disk:
 *
 *   1. the catalog's `recommended` quant, if it is not a `no`,
 *   2. the largest `ok`,
 *   3. the largest `maybe`,
 *   4. none — recommending a checkpoint that will not fit helps nobody.
 *
 * The catalog flag is the curator's pick for a typical machine; this is what
 * the "Recommended" badge shows, so a small machine is steered to a quant it
 * can run instead of the one the catalog chose.
 */
export function recommendedQuant(
  family: DiffusionCatalogFamily,
  profile: HardwareProfile | null,
  opts: { teOnCpu?: boolean } = {}
): DiffusionCatalogQuant | null {
  const teOnCpu = opts.teOnCpu ?? defaultTeOnCpu()
  const quants = family.transformer.quants
  const fitOf = (quant: DiffusionCatalogQuant): DiffusionFit =>
    fitForQuant(family, quant, profile, { teOnCpu }).fit

  const curated = quants.find((quant) => quant.recommended)
  if (curated && fitOf(curated) !== 'no') return curated

  return (
    largest(quants.filter((quant) => fitOf(quant) === 'ok')) ??
    largest(quants.filter((quant) => fitOf(quant) === 'maybe')) ??
    null
  )
}

/**
 * The quant the selector opens on:
 *
 *   1. the largest installed quant that is not a `no`,
 *   2. the {@link recommendedQuant},
 *   3. the smallest quant, and let the badge say so.
 *
 * `installedIds` are artifact ids (`<family>:<quant>`) or bare quant ids;
 * both are accepted so callers need not reformat.
 */
export function pickDefaultQuant(
  family: DiffusionCatalogFamily,
  profile: HardwareProfile | null,
  installedIds: string[],
  opts: { teOnCpu?: boolean } = {}
): DiffusionCatalogQuant {
  const teOnCpu = opts.teOnCpu ?? defaultTeOnCpu()
  const quants = family.transformer.quants
  const installedSet = new Set(installedIds)
  const isInstalled = (quant: DiffusionCatalogQuant): boolean =>
    installedSet.has(`${family.id}:${quant.id}`) || installedSet.has(quant.id)

  const installedUsable = largest(
    quants.filter(
      (quant) =>
        isInstalled(quant) &&
        fitForQuant(family, quant, profile, { teOnCpu }).fit !== 'no'
    )
  )
  return (
    installedUsable ??
    recommendedQuant(family, profile, { teOnCpu }) ??
    smallest(quants)
  )
}
