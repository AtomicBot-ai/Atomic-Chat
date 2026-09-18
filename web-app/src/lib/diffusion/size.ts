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
  /** `1:1`, `16:9`… shown after the name; empty for custom. */
  ratioLabel: string
}

/**
 * The presets, long edge first. `photo` is the classic 4:3, `landscape` the
 * 3:2 of a full-frame sensor; the two wide ones match monitors and cinema.
 */
export const ASPECT_RATIOS: readonly AspectPreset[] = [
  { id: 'square', ratio: 1, labelKey: 'images:size.aspect.square', ratioLabel: '1:1' },
  { id: 'photo', ratio: 4 / 3, labelKey: 'images:size.aspect.photo', ratioLabel: '4:3' },
  { id: 'landscape', ratio: 3 / 2, labelKey: 'images:size.aspect.landscape', ratioLabel: '3:2' },
  { id: 'widescreen', ratio: 16 / 9, labelKey: 'images:size.aspect.widescreen', ratioLabel: '16:9' },
  { id: 'ultrawide', ratio: 21 / 9, labelKey: 'images:size.aspect.ultrawide', ratioLabel: '21:9' },
  { id: 'custom', ratio: null, labelKey: 'images:size.aspect.custom', ratioLabel: '' },
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
 * Width and height after the user sets one edge by hand while a preset is
 * locked: the other edge follows the ratio. Under custom the pair is free and
 * only the edited edge changes. Both edges leave snapped.
 */
export function sizeForEdge(
  aspect: AspectId,
  portrait: boolean,
  edge: 'width' | 'height',
  value: number,
  constraints: DimConstraints,
  current: { width: number; height: number }
): { width: number; height: number } {
  const snapped = snapDim(value, constraints)
  const preset = ASPECT_RATIOS.find((entry) => entry.id === aspect)
  if (!preset || preset.ratio === null) {
    return edge === 'width'
      ? { width: snapped, height: snapDim(current.height, constraints) }
      : { width: snapDim(current.width, constraints), height: snapped }
  }
  // In landscape the width is the long edge; in portrait the height is.
  const editedIsLong = edge === 'width' ? !portrait : portrait
  const other = snapDim(
    editedIsLong ? snapped / preset.ratio : snapped * preset.ratio,
    constraints
  )
  return edge === 'width'
    ? { width: snapped, height: other }
    : { width: other, height: snapped }
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

/**
 * The sizes a locked preset offers, smallest first: one per long edge from
 * {@link dimOptions}. A long edge whose short edge would fall below the floor
 * is left out, since clamping it there would break the ratio the user picked.
 * Custom has no list; its width and height are typed.
 */
export function sizeOptions(
  aspect: AspectId,
  portrait: boolean,
  constraints: DimConstraints
): Array<{ width: number; height: number }> {
  const preset = ASPECT_RATIOS.find((entry) => entry.id === aspect)
  if (!preset || preset.ratio === null) return []
  const ratio = preset.ratio
  const floor = snapDim(constraints.minDim, constraints)
  const seen = new Set<string>()
  const sizes: Array<{ width: number; height: number }> = []
  for (const long of dimOptions(constraints)) {
    if (long / ratio < floor) continue
    const size = sizeForAspect(aspect, portrait, long, constraints)
    const key = `${size.width}x${size.height}`
    if (seen.has(key)) continue
    seen.add(key)
    sizes.push(size)
  }
  return sizes
}

/** Megapixels with one decimal, for the size readout. */
export function formatMegapixels(width: number, height: number): string {
  return ((width * height) / 1_000_000).toFixed(1)
}

/**
 * Scale `width`×`height` to fit inside `maxWidth`×`maxHeight`, keeping the
 * aspect ratio, never enlarging, and snapped to the model's grid. This is
 * how a source image maps onto the form's resolution for Transform, and how
 * an Upscale target is kept under the model's ceiling.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
  constraints: DimConstraints
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) {
    return { width: snapDim(maxWidth, constraints), height: snapDim(maxHeight, constraints) }
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return {
    width: snapDim(width * scale, constraints),
    height: snapDim(height * scale, constraints),
  }
}

/**
 * `width`×`height` scaled by `factor`, capped so the longer edge stays at or
 * under the model's ceiling. Returns the size and the factor actually used,
 * so the form can show what a 4× on a big photo really produces.
 */
export function scaleWithin(
  width: number,
  height: number,
  factor: number,
  constraints: DimConstraints
): { width: number; height: number; factor: number } {
  if (!(width > 0) || !(height > 0)) {
    const edge = snapDim(constraints.maxDim, constraints)
    return { width: edge, height: edge, factor: 1 }
  }
  const longest = Math.max(width, height)
  const used = Math.min(Math.max(factor, 1), constraints.maxDim / longest)
  return {
    width: snapDim(width * used, constraints),
    height: snapDim(height * used, constraints),
    factor: used,
  }
}
