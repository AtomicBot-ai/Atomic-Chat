/**
 * Classification of the downloader's stringly-typed errors, so the download
 * UI can tell the user which fault it was (disk full, permission, auth, …)
 * instead of a generic "download failed".
 */

export type DownloadFailureReason =
  | 'http_404'
  | 'http_401_auth'
  | 'http_other'
  | 'checksum_mismatch'
  | 'size_mismatch'
  // ATO-467: `disk_io` was the single largest failure cause (647 devices) and
  // covered at least five unrelated faults. The Rust downloader now names the
  // subcause; `disk_io` stays as the catch-all, so old clients and unmapped
  // errors keep landing where they always did.
  | 'disk_full'
  | 'disk_permission'
  | 'disk_file_locked'
  | 'disk_path_too_long'
  | 'disk_device_lost'
  | 'disk_io'
  | 'network'
  | 'cancelled'
  | 'path_guard'
  | 'unknown'

/**
 * Subcause tags emitted by `src-tauri/src/core/downloads/disk.rs`. Kept as an
 * explicit allowlist so a malformed or unknown tag degrades to the heuristics
 * below instead of inventing a new enum value.
 */
const DISK_FAULT_TAGS = new Set<DownloadFailureReason>([
  'disk_full',
  'disk_permission',
  'disk_file_locked',
  'disk_path_too_long',
  'disk_device_lost',
  'disk_io',
])

/** Parse an `HTTP status NNN` token out of a stringly-typed download error. */
export function parseHttpStatus(err?: string | null): number | null {
  if (!err) return null
  const match = err.match(/HTTP status (\d{3})/i)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Read the `[disk_*]` subcause tag the Rust downloader prefixes onto every
 * filesystem error (see `downloads/disk.rs`). Returns null for untagged errors
 * — legacy clients, and every non-filesystem failure.
 */
function diskFaultTag(err: string): DownloadFailureReason | null {
  const match = err.match(/\[(disk_[a-z_]+)\]/)
  if (!match) return null
  const tag = match[1] as DownloadFailureReason
  return DISK_FAULT_TAGS.has(tag) ? tag : null
}

/** Classify a stringly-typed download error into a stable enum. */
export function classifyDownloadFailure(
  err?: string | null
): DownloadFailureReason {
  if (!err) return 'unknown'
  const e = err.toLowerCase()
  if (/\b(abort|aborted|cancel|cancelled|canceled|stopped|interrupt)\b/.test(e))
    return 'cancelled'

  // The downloader's own tag beats every heuristic below: it was derived from
  // the OS error code, not from guessing at the message text.
  const tagged = diskFaultTag(err)
  if (tagged) return tagged

  const status = parseHttpStatus(err)
  if (status === 404) return 'http_404'
  if (status === 401 || status === 403) return 'http_401_auth'
  if (status != null) return 'http_other'

  if (e.includes('hash verification')) return 'checksum_mismatch'
  if (e.includes('size verification')) return 'size_mismatch'
  if (
    e.includes('no such file') ||
    e.includes('permission denied') ||
    e.includes('disk') ||
    e.includes('io error') ||
    e.includes('os error')
  )
    return 'disk_io'
  if (
    e.includes('path') &&
    (e.includes('guard') ||
      e.includes('invalid') ||
      e.includes('outside') ||
      e.includes('traversal'))
  )
    return 'path_guard'
  if (
    e.includes('network') ||
    e.includes('connection') ||
    e.includes('dns') ||
    e.includes('timed out') ||
    e.includes('timeout') ||
    e.includes('failed to download')
  )
    return 'network'
  return 'unknown'
}
