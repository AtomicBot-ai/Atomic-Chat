import { describe, expect, it } from 'vitest'
import { classifyDownloadFailure, parseHttpStatus } from '@/lib/download-errors'

describe('classifyDownloadFailure', () => {
  it('reads the subcause tag the downloader attaches (ATO-467)', () => {
    // `disk_io` was one bucket over 647 devices; the Rust side now names which
    // filesystem fault it actually was, derived from the OS error code.
    expect(
      classifyDownloadFailure(
        'Error: [disk_full] No space left on device (os error 28)'
      )
    ).toBe('disk_full')
    expect(
      classifyDownloadFailure(
        'Error: [disk_permission] Permission denied (os error 13)'
      )
    ).toBe('disk_permission')
    expect(
      classifyDownloadFailure(
        'Error: [disk_file_locked] The process cannot access the file'
      )
    ).toBe('disk_file_locked')
    expect(
      classifyDownloadFailure(
        'Error: [disk_path_too_long] File path is 274 characters'
      )
    ).toBe('disk_path_too_long')
    expect(
      classifyDownloadFailure(
        'Error: [disk_device_lost] The device is not ready'
      )
    ).toBe('disk_device_lost')
  })

  it('keeps the tag out of the way of cancellation', () => {
    // A user-cancelled download must not be counted as a disk failure.
    expect(classifyDownloadFailure('Download cancelled')).toBe('cancelled')
  })

  it('falls back to the old heuristics for untagged errors', () => {
    // Clients that predate the tag, and every non-filesystem failure.
    expect(classifyDownloadFailure('Error: os error 5 while writing')).toBe(
      'disk_io'
    )
    expect(
      classifyDownloadFailure('Failed to get file size: HTTP status 404')
    ).toBe('http_404')
    expect(classifyDownloadFailure('connection reset by peer')).toBe('network')
    expect(classifyDownloadFailure(undefined)).toBe('unknown')
  })

  it('does not invent an enum value for an unknown tag', () => {
    // A future or malformed tag must never become a new enum value. It
    // falls through to the heuristics, which land it in the `disk_io`
    // catch-all — where it would have gone before the split anyway.
    expect(classifyDownloadFailure('Error: [disk_wat] something new')).toBe(
      'disk_io'
    )
    expect(classifyDownloadFailure('Error: [weird_tag] xyz')).toBe('unknown')
  })
})

describe('parseHttpStatus', () => {
  it('reads the status the downloader embeds in its error text', () => {
    expect(parseHttpStatus('Failed to get file size: HTTP status 429')).toBe(
      429
    )
    expect(parseHttpStatus('connection reset')).toBeNull()
    expect(parseHttpStatus(undefined)).toBeNull()
  })
})
