/**
 * The frame-count lattice of a video family and the durations offered for it.
 *
 * A video model accepts `k * step + offset` frames inside `[min, max]` (LTX:
 * 8k+1 in [9, 257]; Wan: 4k+1 in [5, 241]). The form shows durations in
 * seconds, so a target such as "2 s" is turned into the nearest frame count on
 * the lattice, and a frame count is shown as its seconds at the family's rate.
 */
export type FrameLattice = {
  fps: number
  min: number
  max: number
  step: number
  offset: number
}

export type DurationOption = {
  frames: number
  /** The seconds the option stands for: the target it was made from, or `frames / fps`. */
  seconds: number
}

/** The durations offered by default, in seconds. */
export const DEFAULT_DURATION_TARGETS: readonly number[] = [1, 2, 3, 5]

const onLattice = (k: number, lattice: FrameLattice) =>
  k * lattice.step + lattice.offset

/**
 * The nearest frame count on the lattice, clamped into the range: the
 * smallest lattice point at or above `min` and the largest at or below `max`.
 */
export function snapFrames(frames: number, lattice: FrameLattice): number {
  const { step, offset, min, max } = lattice
  const lowest = onLattice(Math.max(0, Math.ceil((min - offset) / step)), lattice)
  const highest = onLattice(Math.floor((max - offset) / step), lattice)
  if (highest < lowest) return lowest
  const k = Math.round((frames - offset) / step)
  const snapped = onLattice(Math.max(0, k), lattice)
  return Math.min(Math.max(snapped, lowest), highest)
}

/** The frame count nearest to `seconds` at the family's rate, on the lattice. */
export function framesForSeconds(seconds: number, lattice: FrameLattice): number {
  return snapFrames(Math.round(seconds * lattice.fps), lattice)
}

/** How long `frames` play at `fps`, in seconds; 0 when the rate is unusable. */
export function secondsForFrames(frames: number, fps: number): number {
  return fps > 0 ? frames / fps : 0
}

/** "1.0", "2.0", "5.0", "10.7": one decimal, the way the form labels durations. */
export function formatSeconds(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1)
}

/**
 * The duration menu: one option per target second count, plus any `extra`
 * frame counts (the family default, the persisted choice) that the targets
 * do not already produce. Deduplicated by frame count and sorted ascending.
 */
export function durationOptions(
  lattice: FrameLattice,
  targets: readonly number[] = DEFAULT_DURATION_TARGETS,
  extra: readonly number[] = []
): DurationOption[] {
  const byFrames = new Map<number, DurationOption>()
  for (const seconds of targets) {
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    const frames = framesForSeconds(seconds, lattice)
    if (!byFrames.has(frames)) byFrames.set(frames, { frames, seconds })
  }
  for (const wanted of extra) {
    if (!Number.isFinite(wanted)) continue
    const frames = snapFrames(wanted, lattice)
    if (!byFrames.has(frames)) {
      byFrames.set(frames, {
        frames,
        seconds: secondsForFrames(frames, lattice.fps),
      })
    }
  }
  return [...byFrames.values()].sort((a, b) => a.frames - b.frames)
}
