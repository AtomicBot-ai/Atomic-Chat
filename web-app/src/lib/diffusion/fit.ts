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

export function estimateDiffusionFit(
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

const textEncoderBytes = (family: DiffusionCatalogFamily): number =>
  family.text_encoders.reduce((sum, encoder) => sum + encoder.bytes, 0)

/** The fit of one quant at the family's default size. */
export function fitForQuant(
  family: DiffusionCatalogFamily,
  quant: DiffusionCatalogQuant,
  profile: HardwareProfile | null,
  opts: { teOnCpu: boolean }
): DiffusionFitEstimate {
  return estimateDiffusionFit(
    {
      transformerBytes: quant.bytes,
      vaeBytes: family.vae?.bytes ?? 0,
      teBytes: textEncoderBytes(family),
      teOnCpu: opts.teOnCpu,
      width: family.defaults.width,
      height: family.defaults.height,
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

/**
 * The quant the selector opens on:
 *
 *   1. the largest installed quant that is not a `no`,
 *   2. the catalog's `recommended` quant, if it is not a `no`,
 *   3. the largest `ok`,
 *   4. the largest `maybe`,
 *   5. the smallest quant, and let the badge say so.
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
  const teOnCpu =
    opts.teOnCpu ?? (typeof IS_MACOS !== 'undefined' && Boolean(IS_MACOS))
  const quants = family.transformer.quants
  const fitOf = (quant: DiffusionCatalogQuant): DiffusionFit =>
    fitForQuant(family, quant, profile, { teOnCpu }).fit
  const installedSet = new Set(installedIds)
  const isInstalled = (quant: DiffusionCatalogQuant): boolean =>
    installedSet.has(`${family.id}:${quant.id}`) || installedSet.has(quant.id)

  const installedUsable = largest(
    quants.filter((quant) => isInstalled(quant) && fitOf(quant) !== 'no')
  )
  if (installedUsable) return installedUsable

  const recommended = quants.find((quant) => quant.recommended)
  if (recommended && fitOf(recommended) !== 'no') return recommended

  const ok = largest(quants.filter((quant) => fitOf(quant) === 'ok'))
  if (ok) return ok

  const maybe = largest(quants.filter((quant) => fitOf(quant) === 'maybe'))
  if (maybe) return maybe

  return smallest(quants)
}
