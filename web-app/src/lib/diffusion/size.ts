/**
 * Image size arithmetic for the Images page.
 *
 * Pure: everything here is a function of the numbers the loaded model reports
 * (`ImageCapabilities.minDim/maxDim/dimMultiple`) and the user's choices. The
 * engine rejects dimensions that are not a multiple of `dimMultiple`, so every
 * width and height the form produces goes through {@link snapDim} first — the
 * user picks a shape and a size, never a number the model cannot take.
 */

export type AspectId =
  | 'square'
  | 'photo'
  | 'landscape'
  | 'widescreen'
  | 'ultrawide'
  | 'custom'

export type AspectPreset = {
  id: AspectId
  /** Long edge over short edge; `null` for custom, which is free-form. */
  ratio: number | null
  /** `images:size.aspect.<id>` label key. */
  labelKey: string
}

/**
 * The presets, long edge first. `photo` is the classic 4:3, `landscape` the
 * 3:2 of a full-frame sensor; the two wide ones match monitors and cinema.
 */
export const ASPECT_RATIOS: readonly AspectPreset[] = [
  { id: 'square', ratio: 1, labelKey: 'images:size.aspect.square' },
  { id: 'photo', ratio: 4 / 3, labelKey: 'images:size.aspect.photo' },
  { id: 'landscape', ratio: 3 / 2, labelKey: 'images:size.aspect.landscape' },
  { id: 'widescreen', ratio: 16 / 9, labelKey: 'images:size.aspect.widescreen' },
  { id: 'ultrawide', ratio: 21 / 9, labelKey: 'images:size.aspect.ultrawide' },
  { id: 'custom', ratio: null, labelKey: 'images:size.aspect.custom' },
] as const

export type DimConstraints = {
  minDim: number
  maxDim: number
  dimMultiple: number
}

/** Tolerance when deciding whether `w/h` "is" one of the presets. */
const ASPECT_TOLERANCE = 0.02

/**
 * Round `value` to the nearest multiple of `dimMultiple` inside
 * `[minDim, maxDim]`. The bounds themselves are snapped too, so a model whose
 * `minDim` is not itself a multiple never yields an unusable value.
 */
export function snapDim(value: number, constraints: DimConstraints): number {
  const multiple = Math.max(1, Math.floor(constraints.dimMultiple) || 1)
  const lo = Math.ceil(constraints.minDim / multiple) * multiple
  const hi = Math.floor(constraints.maxDim / multiple) * multiple
  if (!Number.isFinite(value)) return lo
  const snapped = Math.round(value / multiple) * multiple
  return Math.min(Math.max(snapped, lo), Math.max(hi, lo))
}

/**
 * Which preset (if any) a width/height pair corresponds to, in either
 * orientation. Falls back to `custom`, which is also what a hand-typed size
 * should display as.
 */
export function matchAspect(width: number, height: number): AspectId {
  if (!(width > 0) || !(height > 0)) return 'custom'
  const ratio = Math.max(width, height) / Math.min(width, height)
  for (const preset of ASPECT_RATIOS) {
    if (preset.ratio === null) continue
    if (Math.abs(ratio - preset.ratio) / preset.ratio <= ASPECT_TOLERANCE) {
      return preset.id
    }
  }
  return 'custom'
}

/**
 * Width and height for a preset at a given long edge. `portrait` flips the
 * pair. Custom keeps whatever the caller had — the free-form inputs own it.
 */
export function sizeForAspect(
  aspect: AspectId,
  portrait: boolean,
  longEdge: number,
  constraints: DimConstraints,
  current?: { width: number; height: number }
): { width: number; height: number } {
  const preset = ASPECT_RATIOS.find((entry) => entry.id === aspect)
  if (!preset || preset.ratio === null) {
    const width = snapDim(current?.width ?? longEdge, constraints)
    const height = snapDim(current?.height ?? longEdge, constraints)
    return { width, height }
  }
  const long = snapDim(longEdge, constraints)
  const short = snapDim(long / preset.ratio, constraints)
  return portrait ? { width: short, height: long } : { width: long, height: short }
}

/**
 * Candidate long-edge sizes for the size picker: every `step` between the
 * snapped bounds, always including both bounds. `step` defaults to 128 so a
 * 256–2048 model offers 15 choices rather than 113.
 */
export function dimOptions(constraints: DimConstraints, step = 128): number[] {
  const lo = snapDim(constraints.minDim, constraints)
  const hi = snapDim(constraints.maxDim, constraints)
  const options = new Set<number>([lo])
  const stride = Math.max(step, constraints.dimMultiple)
  for (let value = Math.ceil(lo / stride) * stride; value < hi; value += stride) {
    const snapped = snapDim(value, constraints)
    if (snapped > lo && snapped < hi) options.add(snapped)
  }
  options.add(hi)
  return [...options].sort((a, b) => a - b)
}

/** Megapixels with one decimal, for the size readout. */
export function formatMegapixels(width: number, height: number): string {
  return ((width * height) / 1_000_000).toFixed(1)
}
