import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import {
  FileTooLargeError,
  READ_FILE_CHUNK_BYTES,
  readFileBytes,
} from '../readFileBytes'
import { TauriCoreService } from '@/services/core/tauri'
import { seedServiceHub } from '@/test/service-hub'

type ChunkArgs = { path: string; offset: number; length: number }

const MiB = 1024 * 1024

let file: Uint8Array
let calls: ChunkArgs[]
let fileStat: ReturnType<typeof vi.fn>

/** Deep-equality on a multi-MiB typed array is far too slow for vitest. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const fillFile = (size: number) => {
  file = new Uint8Array(size)
  for (let i = 0; i < size; i++) file[i] = (i * 31 + 7) & 0xff
}

beforeEach(() => {
  calls = []
  fillFile(5 * MiB)
  fileStat = vi.fn(async () => ({ isDirectory: false, size: file.length }))
  ;(
    globalThis as Record<string, unknown> & { core: { api: object } }
  ).core.api = {
    ...(globalThis as unknown as { core: { api: object } }).core.api,
    fileStat,
  }
  mockIPC((command: string, args?: InvokeArgs) => {
    if (command !== 'read_file_chunk') throw new Error(`unexpected ${command}`)
    const { offset, length } = args as ChunkArgs
    calls.push(args as ChunkArgs)
    return file.slice(offset, offset + length).buffer
  })
  seedServiceHub({ core: new TauriCoreService() })
})

describe('readFileBytes', () => {
  it('pages through the file and reassembles it byte for byte', async () => {
    const { bytes, size } = await readFileBytes('/img/big.png', {
      maxBytes: 64 * MiB,
    })

    expect(size).toBe(5 * MiB)
    expect(calls.map((c) => c.offset)).toEqual([0, 2 * MiB, 4 * MiB])
    expect(calls.map((c) => c.length)).toEqual([
      READ_FILE_CHUNK_BYTES,
      READ_FILE_CHUNK_BYTES,
      1 * MiB,
    ])
    expect(calls.every((c) => c.path === '/img/big.png')).toBe(true)
    expect(sameBytes(bytes, file)).toBe(true)
  })

  it('honours a custom chunk size', async () => {
    fillFile(10)
    await readFileBytes('/img/tiny.png', { maxBytes: 100, chunkBytes: 4 })

    expect(calls.map((c) => [c.offset, c.length])).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ])
  })

  it('rejects an oversized file before reading any bytes', async () => {
    await expect(
      readFileBytes('/img/big.png', { maxBytes: 1 * MiB })
    ).rejects.toBeInstanceOf(FileTooLargeError)
    expect(calls).toHaveLength(0)
  })

  it('accepts the postMessage number[] payload shape', async () => {
    fillFile(6)
    mockIPC((_command: string, args?: InvokeArgs) => {
      const { offset, length } = args as ChunkArgs
      return Array.from(file.slice(offset, offset + length))
    })

    const { bytes } = await readFileBytes('/img/tiny.png', {
      maxBytes: 100,
      chunkBytes: 4,
    })
    expect(sameBytes(bytes, file)).toBe(true)
  })

  it('fails on a short read instead of returning zero-filled bytes', async () => {
    mockIPC(() => new ArrayBuffer(0))

    await expect(
      readFileBytes('/img/big.png', { maxBytes: 64 * MiB })
    ).rejects.toThrow(/Short read/)
  })

  it('propagates a rejected chunk read', async () => {
    mockIPC(() => {
      throw new Error('Access is denied')
    })

    await expect(
      readFileBytes('/img/big.png', { maxBytes: 64 * MiB })
    ).rejects.toThrow('Access is denied')
  })

  it('refuses a directory', async () => {
    fileStat.mockResolvedValue({ isDirectory: true, size: 0 })

    await expect(readFileBytes('/img', { maxBytes: 64 * MiB })).rejects.toThrow(
      /not a file/
    )
    expect(calls).toHaveLength(0)
  })
})
