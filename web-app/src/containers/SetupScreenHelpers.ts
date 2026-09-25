/**
 * Pure helpers behind the first-run screen's model list: which file a row
 * downloads, who a row is "from", why a model fits this machine, the colour a
 * memory verdict maps onto, and the order the picks are listed in. Kept free
 * of React and of `SetupScreen` itself so they are testable without a render,
 * so the screen can import them without a cycle, and so the composer's
 * reply-model gate can list the same rows in the same order without pulling
 * the whole screen in.
 */
import { DEFAULT_MODEL_QUANTIZATIONS } from '@/constants/models'
import {
  judgeMemoryFit,
  type HardwareProfile,
  type MemoryFit,
} from '@/lib/hardware-tier'
import { findPinnedQuant } from '@/lib/model-card'
import { iconKeyLogoSrc, modelFamilyLogoSrc } from '@/lib/model-logo'
import { getPreferredMmprojModel } from '@/lib/models'
import type {
  CatalogModel,
  MMProjModel,
  ModelQuant,
} from '@/services/models/types'

/**
 * The three colours a row can wear. `ok` is green, `warn` yellow, `no` red.
 * `null` is "we don't know" — no size, or no hardware profile — and is drawn
 * as nothing at all, never as a warning.
 */
export type FitLevel = 'ok' | 'warn' | 'no'

/**
 * Four verdicts onto three colours: `tight` and `spills` both mean "it will
 * run, expect less of it", and one warning colour is enough for that — the
 * tooltip's sentence tells the two apart.
 */
export function fitLevel(fit: MemoryFit | null | undefined): FitLevel | null {
  switch (fit) {
    case 'comfortable':
      return 'ok'
    case 'tight':
    case 'spills':
      return 'warn'
    case 'wont_load':
      return 'no'
    default:
      return null
  }
}

/** Short label read out before the reason, one per colour. */
export function fitLabelKey(level: FitLevel): string {
  return {
    ok: 'setup:recommend.fitOk',
    warn: 'setup:recommend.fitWarn',
    no: 'setup:recommend.fitNo',
  }[level]
}

/** Listing order of the colour groups; the unknown group goes last. */
const FIT_LEVEL_ORDER: ReadonlyArray<FitLevel | null> = [
  'ok',
  'warn',
  'no',
  null,
]

/**
 * Lists the rows by colour — what fits, then what is tight, then what will not
 * load, then what could not be judged — and inside each group deals them with
 * `interleave` so no two neighbours share a publisher where the group allows
 * it. Each group starts from the publisher of the row before it: the last row
 * of the previous group, or `previous` for the first — the row rendered above
 * the list (the offer), which is never part of `rows`.
 *
 * The groups are never reordered to improve the interleave: a red row does
 * not move up to part two green ones. Fit is the stronger signal.
 */
export function orderRowsByFit<T>(
  rows: readonly T[],
  options: {
    levelOf: (row: T) => FitLevel | null
    keyOf: (row: T) => string
    interleave: (
      group: readonly T[],
      keyOf: (row: T) => string,
      previous?: string
    ) => T[]
    previous?: string
  }
): T[] {
  const { levelOf, keyOf, interleave, previous } = options
  const out: T[] = []
  let last = previous
  for (const level of FIT_LEVEL_ORDER) {
    const group = rows.filter((row) => levelOf(row) === level)
    if (group.length === 0) continue
    const dealt = interleave(group, keyOf, last)
    out.push(...dealt)
    last = keyOf(dealt[dealt.length - 1])
  }
  return out
}

//* Download variant: pin from the manifest, otherwise the quant priority used in Hub.
//! The pin is required for LFM2.5-VL-450M (needs Q8_0): the repo also serves Q4_K_M,
//! which matches DEFAULT_MODEL_QUANTIZATIONS — without the pin a working but wrong
//! file gets downloaded, and the error never surfaces anywhere.
export function pickPreferredVariant(
  model: CatalogModel,
  quantPin?: string
): ModelQuant | null {
  const pinned = findPinnedQuant(model.quants, quantPin)
  if (pinned) return pinned
  const preferred =
    model.quants?.find((m) =>
      DEFAULT_MODEL_QUANTIZATIONS.some((e) =>
        m.model_id.toLowerCase().includes(e)
      )
    ) ?? null
  return preferred ?? model.quants?.[0] ?? null
}

//* Projector for vision models: pin from the manifest, otherwise the regular selection.
//! getPreferredMmprojModel looks for the literal id 'mmproj-f16'. LiquidAI's id is
//! 'mmproj-LFM2_5-VL-450m-F16', so there is no match and it falls back to mmproj_models[0]
//! = BF16 (181 MB) instead of Q8_0 (98 MB).
export function pickMmprojModel(
  model: CatalogModel,
  quantPin?: string
): MMProjModel | undefined {
  return (
    findPinnedQuant(model.mmproj_models, quantPin) ??
    getPreferredMmprojModel(model)
  )
}

/**
 * Who a row is "from", for the purpose of not seating two of them together:
 * the brand mark the row wears (so `gemma`/`google` and `llama`/`meta`/`muse`
 * are one publisher each), else the repo owner. The repo owner alone would
 * not do — most picks are our own `AtomicChat/…` repacks of other people's
 * models.
 */
export function publisherKey(modelName: string, iconKey?: string): string {
  return (
    iconKeyLogoSrc(iconKey) ??
    modelFamilyLogoSrc(modelName) ??
    modelName.split('/')[0]?.toLowerCase() ??
    modelName.toLowerCase()
  )
}

/**
 * Reorders rows so no two neighbours share a publisher, and otherwise keeps
 * the order it was given: each slot takes the earliest remaining row whose
 * publisher differs from the previous slot's — starting from `previous`, the
 * publisher of whatever row sits above the list. When only one publisher is
 * left its rows follow each other, which is the best any order can do.
 * Deterministic on purpose: the list must not reshuffle between renders.
 */
export function interleaveByPublisher<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  previous?: string
): T[] {
  const remaining = [...rows]
  const out: T[] = []
  let last = previous
  while (remaining.length > 0) {
    const index = remaining.findIndex((row) => keyOf(row) !== last)
    const [next] = remaining.splice(index === -1 ? 0 : index, 1)
    out.push(next)
    last = keyOf(next)
  }
  return out
}

/// Whole-GB rendering of a MiB figure, for the "why this one" line. Rounded to
/// what the user would call their machine ("16 GB"), not to a decimal place
/// nobody reads off a spec sheet.
export function formatMemoryGb(mib?: number): string | null {
  if (!mib || mib <= 0) return null
  return `${Math.round(mib / 1024)} GB`
}

/**
 * The one line under the recommendation that says why it is this model.
 *
 * Returns the i18n key and its interpolation values rather than a string, so
 * the component stays a single `t()` call and the wording lives in the locale
 * files with the rest.
 *
 * The tiers deliberately say different things: a machine with no accelerator is
 * not memory-bound at all — it is bound by CPU throughput, and telling its owner
 * "fits your 64 GB" would explain the wrong constraint. Everything else is
 * judged by {@link judgeMemoryFit}, whose macOS ceiling is a hard one.
 */
export type RecommendationFitCopy = {
  key: string
  values: Record<string, string>
  /**
   * Name of the memory pool, as its own key so the caller resolves it before
   * interpolating. "16 GB" on a Mac and "16 GB" on a graphics card are not the
   * same 16 GB, and a line that omits which one reads as a claim about RAM.
   */
  poolKey?: string
}

export function describeRecommendationFit(args: {
  sizeLabel?: string | null
  sizeBytes?: number
  profile: HardwareProfile | null
  /**
   * Speak of the memory fit even on a CPU-only machine. The offer's badge
   * explains the *choice*, and there the CPU is what binds; the fit mark on
   * every row reports what {@link judgeMemoryFit} measured, which is memory,
   * and on such a machine that is the pool the row is judged against.
   */
  memoryOnly?: boolean
}): RecommendationFitCopy | null {
  const { sizeLabel, sizeBytes, profile, memoryOnly = false } = args
  if (!sizeLabel) return null
  const values: Record<string, string> = { size: sizeLabel }

  if (profile?.memoryKind === 'system' && !memoryOnly) {
    return { key: 'setup:recommend.whyCpuOnly', values }
  }

  const budget = formatMemoryGb(profile?.budgetMib)
  const fit = judgeMemoryFit(sizeBytes, profile)
  if (!budget || !fit || !profile) {
    return { key: 'setup:recommend.whyUnknown', values }
  }

  const key = {
    comfortable: 'setup:recommend.whyComfortable',
    tight: 'setup:recommend.whyTight',
    spills: 'setup:recommend.whySpills',
    wont_load: 'setup:recommend.whyWontLoad',
  }[fit]
  return {
    key,
    values: { ...values, budget },
    poolKey: `setup:recommend.pool.${profile.memoryKind}`,
  }
}
