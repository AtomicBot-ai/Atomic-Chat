/**
 * ATO-462: one place that formats download progress.
 *
 * The panel and the onboarding screen each grew their own byte formatter, and
 * the two drifted — the same transfer read differently depending on which
 * screen you were looking at. Everything that renders a download reads its
 * strings from here.
 */

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/**
 * Size for the `current / total` readout.
 *
 * The unit is chosen from the *total*, not from each value, so the pair stays
 * comparable: `0.42 / 15.0 GB`, never `430 MB / 15 GB` where the numbers no
 * longer line up as the download progresses.
 */
export function formatBytes(bytes: number, unitFrom = bytes): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0'
  return unitFrom >= GB
    ? (bytes / GB).toFixed(2)
    : Math.round(bytes / MB).toString()
}

/** Unit label matching `formatBytes` for a given total. */
export function bytesUnit(total: number): string {
  return total >= GB ? 'GB' : 'MB'
}

/** `287 MB / 15.00 GB` — the whole readout, units resolved once. */
export function formatProgressPair(current: number, total: number): string {
  if (!(total > 0)) return ''
  const unit = bytesUnit(total)
  return `${formatBytes(current, total)} / ${formatBytes(total, total)} ${unit}`
}

/** `18.4 MB/s`. Returns null below a usable sample so the UI can omit it. */
export function formatSpeed(bytesPerSecond?: number | null): string | null {
  if (
    !bytesPerSecond ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  )
    return null
  if (bytesPerSecond >= MB) return `${(bytesPerSecond / MB).toFixed(1)} MB/s`
  if (bytesPerSecond >= KB) return `${Math.round(bytesPerSecond / KB)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

/**
 * `12m 56s left` / `1h 04m left`.
 *
 * Returns null when there is nothing honest to say — no speed sample yet, an
 * unknown total, or an estimate so long it would only mislead. A wrong ETA is
 * worse than none: the cancel rate on big models (23.8%, ATO-467) is the
 * number this readout exists to move.
 */
export function formatEta(
  remainingBytes: number,
  bytesPerSecond?: number | null
): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return null

  const seconds = Math.round(remainingBytes / bytesPerSecond)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  // Past a day the estimate says nothing useful about a stalled transfer.
  if (seconds > 24 * 60 * 60) return null

  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Strip the HuggingFace org prefix for display: `unsloth/Qwen3-4B-GGUF` reads
 * as `Qwen3-4B-GGUF`. The full id stays in the `title` attribute.
 */
export function shortModelName(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 && slash < id.length - 1 ? id.slice(slash + 1) : id
}

// ===== Speed sampling =====

/**
 * Rolling speed estimate for one transfer.
 *
 * `bytesPerSecond` is exponentially smoothed: raw deltas between progress
 * events swing wildly (the downloader emits every 10 MB, so the interval is
 * whatever the connection happened to do), and an ETA computed from the raw
 * delta jumps around enough to read as broken.
 */
export type SpeedSample = {
  bytesPerSecond: number
  /** Byte count at the last accepted sample. */
  atBytes: number
  /** `Date.now()` of the last accepted sample. */
  atTime: number
}

/** Ignore intervals shorter than this — they divide by near-zero elapsed time. */
const MIN_SAMPLE_MS = 400
/** Weight of the newest observation. Low enough to ride out a stalled chunk. */
const SMOOTHING = 0.3

export function newSpeedSample(bytes = 0, now = Date.now()): SpeedSample {
  return { bytesPerSecond: 0, atBytes: bytes, atTime: now }
}

/**
 * Fold a new byte count into a speed estimate.
 *
 * Returns the previous sample unchanged when the observation is not usable
 * yet, so callers can store the result unconditionally.
 */
export function advanceSpeedSample(
  previous: SpeedSample | undefined,
  bytes: number,
  now = Date.now()
): SpeedSample {
  if (!previous) return newSpeedSample(bytes, now)

  // A restarted or resumed transfer resets the byte counter. Carrying the old
  // baseline forward would report a huge negative-turned-positive delta.
  if (bytes < previous.atBytes) return newSpeedSample(bytes, now)

  const elapsed = now - previous.atTime
  if (elapsed < MIN_SAMPLE_MS || bytes <= previous.atBytes) return previous

  const instant = ((bytes - previous.atBytes) * 1000) / elapsed
  const bytesPerSecond =
    previous.bytesPerSecond > 0
      ? previous.bytesPerSecond * (1 - SMOOTHING) + instant * SMOOTHING
      : instant

  return { bytesPerSecond, atBytes: bytes, atTime: now }
}
