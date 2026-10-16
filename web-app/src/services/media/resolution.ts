/**
 * Pure helpers for the resolution picker's custom size and its rough memory
 * estimate.
 *
 * The *rules* (native size, size multiple, limits, pixel budget, memory per
 * megapixel) and every preset size come from the Rust catalog
 * (`src-tauri/src/core/media/resolution.rs`) through `media_engine_status`;
 * nothing here holds a size table. These functions only apply those rules to
 * a size the user typed, and mirror the Rust functions of the same name so
 * the custom-size preview agrees with what Rust computes (both are tested
 * against the same vectors).
 */

/** Serialized `ResolutionRules` from the Rust catalog. */
export type MediaSizeRules = {
  native: [number, number]
  multiple: number
  min_side: number
  max_side: number
  pixel_budget: number
  comfortable_min_pixels: number
  comfortable_max_pixels: number
  vram_mb_per_megapixel: number
  extra_sizes?: Array<[number, number]>
}

export type SizeCheck = {
  width: number
  height: number
  adjusted: boolean
  warnings: string[]
}

export function snap(value: number, multiple: number): number {
  const m = Math.max(1, multiple)
  // Rust's f64::round rounds half away from zero; sizes are positive.
  return Math.max(m, Math.round(value / m) * m)
}

function snapSide(value: number, rules: MediaSizeRules): number {
  const m = Math.max(1, rules.multiple)
  const lo = Math.ceil(rules.min_side / m) * m
  const hi = Math.max(lo, Math.floor(rules.max_side / m) * m)
  return Math.min(hi, Math.max(lo, snap(value, m)))
}

/** Mirrors `resolution::check_size`. */
export function checkSize(rules: MediaSizeRules, width: number, height: number): SizeCheck {
  const w = snapSide(width, rules)
  const h = snapSide(height, rules)
  const adjusted = w !== width || h !== height
  const warnings: string[] = []
  if (adjusted) {
    warnings.push(
      `Adjusted to ${w} × ${h}: sides must be multiples of ${rules.multiple} between ${rules.min_side} and ${rules.max_side}.`
    )
  }
  const pixels = w * h
  if (pixels > rules.comfortable_max_pixels) {
    warnings.push(
      'Larger than this model is comfortable with: expect repeated subjects, slow renders and high memory use. Render smaller and upscale instead.'
    )
  } else if (pixels < rules.comfortable_min_pixels) {
    warnings.push('Smaller than this model is comfortable with: expect soft, muddled detail.')
  }
  return { width: w, height: h, adjusted, warnings }
}

/** Mirrors `resolution::estimate_vram_mb`. */
export function estimateVramMb(
  rules: MediaSizeRules,
  baseMb: number,
  width: number,
  height: number,
  frames?: number
): number {
  const megapixels = (width * height) / 1_000_000
  const frameFactor =
    frames === undefined ? 1 : Math.sqrt(Math.floor(Math.max(0, frames - 1) / 4) + 1)
  return baseMb + Math.round(rules.vram_mb_per_megapixel * megapixels * frameFactor)
}

/** Mirrors `resolution::output_target`: the long side at `longEdge`, even sides. */
export function outputTarget(width: number, height: number, longEdge: number): [number, number] {
  if (!longEdge || !width || !height) return [width, height]
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
  return width >= height
    ? [longEdge, even((longEdge * height) / width)]
    : [even((longEdge * width) / height), longEdge]
}

export function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * Frames for a clip of `seconds` at `fps`, on the lattice
 * `n % modulus == offset` the model wants (Wan is 4n + 1), never fewer than
 * `modulus + offset`. Mirrors `resolution::frames_for`.
 */
export function framesFor(
  seconds: number,
  fps: number,
  rule: { modulus: number; offset: number } = { modulus: 4, offset: 1 }
): number {
  const modulus = Math.max(1, Math.round(rule.modulus))
  const offset = Math.round(rule.offset)
  const k = Math.max(1, Math.round((seconds * fps - offset) / modulus))
  return modulus * k + offset
}
