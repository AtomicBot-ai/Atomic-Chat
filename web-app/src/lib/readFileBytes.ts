/**
 * Read a file from disk by path, in pages, through the `read_file_chunk`
 * Tauri command.
 *
 * Why not `fetch(convertFileSrc(path))`: on Windows every custom-protocol
 * response — the asset protocol and Tauri's own IPC channel alike — goes
 * through WebView2 as a single in-memory stream, and bodies past roughly
 * 10 MB fail to arrive ("TypeError: Failed to fetch" on a 200 with the right
 * content-length, #261). Paging keeps each response far below that. The
 * bytes cross IPC as a raw ArrayBuffer, so there is no base64 inflation.
 */

import { fs } from '@janhq/core'

import { getServiceHub } from '@/hooks/useServiceHub'

/** Bytes requested per IPC round-trip. Well under the observed failure floor. */
export const READ_FILE_CHUNK_BYTES = 2 * 1024 * 1024

export class FileTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly maxBytes: number
  ) {
    super(`File is ${size} bytes, over the ${maxBytes} byte limit`)
    this.name = 'FileTooLargeError'
  }
}

/**
 * The IPC bridge hands back an ArrayBuffer over the custom protocol, but the
 * postMessage fallback (used when the protocol is unavailable) serialises the
 * body as a plain number array.
 */
const toBytes = (payload: unknown): Uint8Array => {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    )
  }
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[])
  throw new Error('read_file_chunk returned an unexpected payload')
}

export type ReadFileBytesOptions = {
  /** Reject with {@link FileTooLargeError} before reading anything. */
  maxBytes: number
  /** Page size; defaults to {@link READ_FILE_CHUNK_BYTES}. */
  chunkBytes?: number
}

export async function readFileBytes(
  path: string,
  { maxBytes, chunkBytes = READ_FILE_CHUNK_BYTES }: ReadFileBytesOptions
): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: number }> {
  const stat = await fs.fileStat(path)
  if (!stat || stat.isDirectory) {
    throw new Error(`Cannot read ${path}: not a file`)
  }
  const size = Number(stat.size)
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`Cannot read ${path}: unknown size`)
  }
  if (size > maxBytes) {
    throw new FileTooLargeError(size, maxBytes)
  }

  // Backed by a plain ArrayBuffer (never a SharedArrayBuffer) so the result
  // is a valid BlobPart.
  const bytes = new Uint8Array(new ArrayBuffer(size))
  const core = getServiceHub().core()
  let offset = 0
  while (offset < size) {
    const length = Math.min(chunkBytes, size - offset)
    const chunk = toBytes(
      await core.invoke('read_file_chunk', { path, offset, length })
    )
    if (chunk.byteLength === 0) {
      throw new Error(`Short read of ${path} at ${offset}/${size} bytes`)
    }
    bytes.set(chunk.subarray(0, size - offset), offset)
    offset += chunk.byteLength
  }

  return { bytes, size }
}
