/**
 * Asset materialisation tests.
 *
 * `MediaOutputRef` has three variants and every provider produces at least one
 * of them, so this is the single place the three are reconciled into a file on
 * disk with a provenance record attached.
 *
 * Everything runs against an in-memory filesystem. Nothing here touches a real
 * disk, and the data folder is always supplied - never assumed - because the
 * plan is explicit that it comes from `AppConfiguration` and is never hardcoded
 * (there are three legacy Windows APPDATA folders that would each be wrong).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaJobSnapshot, NormalizedMediaRequest } from '../contract'
import {
  MEDIA_ASSET_MAX_BYTES,
  materialize,
  suggestedFileName,
  type MaterializeContext,
  type MediaFileSystem,
} from '../assets'

const DATA_FOLDER = 'C:\\jan-data'

const request: NormalizedMediaRequest = {
  client_job_id: '01JASSETJOB00000000000000',
  provider_id: 'comfyui-local',
  model_id: 'comfyui-local:txt2img',
  task: 'text_to_image',
  params: { prompt: 'a red car', seed: 42, steps: 20 },
  device: 'cuda:0',
}

const context: MaterializeContext = {
  request,
  model_label: 'Text to image',
  app_version: '2.0.23',
}

function snapshot(outputs: MediaJobSnapshot['outputs']): MediaJobSnapshot {
  return {
    client_job_id: request.client_job_id,
    provider_job_id: 'prompt-1',
    provider_id: request.provider_id,
    state: 'succeeded',
    outputs,
    error: null,
  }
}

// --- in-memory filesystem ---------------------------------------------------

type FakeFs = MediaFileSystem & {
  files: Map<string, Uint8Array>
  dirs: Set<string>
  renames: [string, string][]
  removed: string[]
  failWriteOn?: string
}

function fakeFs(): FakeFs {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const renames: [string, string][] = []
  const removed: string[] = []

  const fs: FakeFs = {
    files,
    dirs,
    renames,
    removed,
    join: (...parts: string[]) => parts.join('\\'),
    async mkdir(path) {
      dirs.add(path)
    },
    async exists(path) {
      return files.has(path)
    },
    async writeBytes(path, bytes) {
      if (fs.failWriteOn && path.includes(fs.failWriteOn)) {
        throw new Error('disk full')
      }
      files.set(path, bytes)
    },
    async readText(path) {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return new TextDecoder().decode(bytes)
    },
    async rename(from, to) {
      const bytes = files.get(from)
      if (!bytes) throw new Error(`no such file: ${from}`)
      files.delete(from)
      files.set(to, bytes)
      renames.push([from, to])
    },
    async remove(path) {
      files.delete(path)
      removed.push(path)
    },
    async size(path) {
      return files.get(path)?.byteLength ?? 0
    },
  }
  return fs
}

let fs: FakeFs
let fetched: string[]

function deps(overrides: Partial<Parameters<typeof materialize>[2]> = {}) {
  return {
    fs,
    dataFolder: async () => DATA_FOLDER,
    fetchBytes: async (url: string) => {
      fetched.push(url)
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        mime: 'image/png',
      }
    },
    now: () => Date.parse('2026-09-09T12:00:00Z'),
    newId: (() => {
      let n = 0
      return () => `01JASSET${String((n += 1)).padStart(16, '0')}`
    })(),
    ...overrides,
  }
}

beforeEach(() => {
  fs = fakeFs()
  fetched = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- the three MediaOutputRef variants --------------------------------------

describe('materialize — local_path', () => {
  it('adopts a local file in place rather than copying it', async () => {
    const path = 'D:\\Media\\out\\clip.mp4'
    const assets = await materialize(
      snapshot([{ kind: 'local_path', path, mime: 'video/mp4' }]),
      context,
      deps()
    )

    // The worker already wrote it. Copying would double the disk cost of every
    // local generation for no benefit.
    expect(assets[0]?.path).toBe(path)
    expect(fs.files.size).toBe(0)
    expect(assets[0]?.media_type).toBe('video')
  })
})

describe('materialize — url', () => {
  it('fetches to outputs/<yyyy>/<mm>/ under the configured data folder', async () => {
    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      context,
      deps()
    )

    expect(fetched).toEqual(['https://cdn.example/img.png'])
    // Never hardcoded: DATA_FOLDER came from the injected config.
    expect(assets[0]?.path).toBe(
      `${DATA_FOLDER}\\media\\outputs\\2026\\09\\01JASSET0000000000000001.png`
    )
    expect(fs.dirs.has(`${DATA_FOLDER}\\media\\outputs\\2026\\09`)).toBe(true)
  })

  it('writes to a .partial file and promotes it atomically', async () => {
    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      context,
      deps()
    )

    // The same temp-then-rename pattern jan_utils::backend_bundle uses. A
    // half-written file must never appear in the library as a real asset.
    expect(fs.renames).toHaveLength(1)
    expect(fs.renames[0]![0]).toBe(`${assets[0]!.path}.partial`)
    expect(fs.renames[0]![1]).toBe(assets[0]!.path)
  })

  it('leaves no .partial behind when the write fails', async () => {
    fs.failWriteOn = '.partial'

    await expect(
      materialize(
        snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
        context,
        deps()
      )
    ).rejects.toThrow(/disk full/)

    expect([...fs.files.keys()]).toEqual([])
  })

  it('refuses an asset larger than the ceiling', async () => {
    const huge = new Uint8Array(MEDIA_ASSET_MAX_BYTES + 1)

    await expect(
      materialize(
        snapshot([{ kind: 'url', url: 'https://cdn.example/huge.png' }]),
        context,
        deps({ fetchBytes: async () => ({ bytes: huge, mime: 'image/png' }) })
      )
    ).rejects.toThrow(/too large/i)

    expect([...fs.files.keys()]).toEqual([])
  })
})

describe('materialize — inline', () => {
  it('decodes base64 and writes it', async () => {
    const assets = await materialize(
      // "hello" in base64.
      snapshot([{ kind: 'inline', base64: 'aGVsbG8=', mime: 'image/webp' }]),
      context,
      deps()
    )

    expect(assets[0]?.path.endsWith('.webp')).toBe(true)
    expect(new TextDecoder().decode(fs.files.get(assets[0]!.path)!)).toBe('hello')
    expect(assets[0]?.bytes).toBe(5)
  })
})

describe('materialize — mime and media type', () => {
  it.each([
    ['image/png', 'png', 'image'],
    ['image/jpeg', 'jpg', 'image'],
    ['image/webp', 'webp', 'image'],
    ['video/mp4', 'mp4', 'video'],
    ['audio/wav', 'wav', 'audio'],
  ])('maps %s to .%s and media type %s', async (mime, ext, mediaType) => {
    const assets = await materialize(
      snapshot([{ kind: 'inline', base64: 'aGVsbG8=', mime }]),
      context,
      deps()
    )

    expect(assets[0]?.path.endsWith(`.${ext}`)).toBe(true)
    expect(assets[0]?.media_type).toBe(mediaType)
    expect(assets[0]?.mime).toBe(mime)
  })

  it('falls back to unknown rather than guessing at a mime it does not know', async () => {
    const assets = await materialize(
      snapshot([
        { kind: 'inline', base64: 'aGVsbG8=', mime: 'application/x-mystery' },
      ]),
      context,
      deps()
    )

    // The UI renders a download for `unknown` instead of a broken player.
    expect(assets[0]?.media_type).toBe('unknown')
    expect(assets[0]?.path.endsWith('.bin')).toBe(true)
  })
})

// --- provenance -------------------------------------------------------------

describe('materialize — provenance', () => {
  it('records everything needed to answer "how did I make this?"', async () => {
    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      context,
      deps()
    )

    expect(assets[0]?.provenance).toEqual({
      provider_id: 'comfyui-local',
      model_id: 'comfyui-local:txt2img',
      model_label: 'Text to image',
      task: 'text_to_image',
      params: { prompt: 'a red car', seed: 42, steps: 20 },
      resolved_seed: 42,
      device: 'cuda:0',
      app_version: '2.0.23',
      contract_version: 2,
    })
  })

  it('keeps the full params bag, not a summary of it', async () => {
    const wide = {
      ...context,
      request: {
        ...request,
        params: { prompt: 'p', seed: 1, steps: 30, cfg: 7.5, sampler_name: 'euler' },
      },
    }

    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      wide,
      deps()
    )

    // "Re-run with these settings" is only truthful if every knob survived.
    expect(assets[0]?.provenance.params).toEqual(wide.request.params)
  })

  it('omits resolved_seed when the seed was left to the provider', async () => {
    const noSeed = {
      ...context,
      request: { ...request, params: { prompt: 'a red car' } },
    }

    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      noSeed,
      deps()
    )

    // Honest absence rather than a fabricated 0. The contract gives a provider
    // no way to report the seed it picked - see tracker decision D8 - so
    // claiming one here would make "re-run identically" quietly wrong.
    expect(assets[0]?.provenance.resolved_seed).toBeUndefined()
  })
})

// --- thumbnails are a nicety, never a gate ----------------------------------

describe('materialize — thumbnails', () => {
  it('attaches a thumbnail path when one can be made', async () => {
    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      context,
      deps({ thumbnail: async () => new Uint8Array([9, 9, 9]) })
    )

    expect(assets[0]?.thumb_path).toBe(
      `${DATA_FOLDER}\\media\\thumbs\\01JASSET0000000000000001.webp`
    )
  })

  it('still saves the asset when thumbnailing throws', async () => {
    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      context,
      deps({
        thumbnail: async () => {
          throw new Error('no canvas in this environment')
        },
      })
    )

    // Losing a preview must never lose the generation it previews.
    expect(assets[0]?.thumb_path).toBeUndefined()
    expect(assets[0]?.path).toBeTruthy()
  })
})

// --- multiple outputs -------------------------------------------------------

describe('materialize — batches', () => {
  it('materialises every output of a batch as its own asset', async () => {
    const assets = await materialize(
      snapshot([
        { kind: 'url', url: 'https://cdn.example/1.png' },
        { kind: 'url', url: 'https://cdn.example/2.png' },
      ]),
      context,
      deps()
    )

    expect(assets).toHaveLength(2)
    expect(new Set(assets.map((asset) => asset.asset_id)).size).toBe(2)
    expect(assets.every((asset) => asset.client_job_id === request.client_job_id)).toBe(
      true
    )
  })

  it('returns nothing for a job that produced nothing', async () => {
    const assets = await materialize(snapshot([]), context, deps())

    expect(assets).toEqual([])
  })
})

describe('materialize — a folder the user chose', () => {
  it('writes there under a readable name instead of the data folder', async () => {
    const assets = await materialize(
      snapshot([{ kind: 'url', url: 'https://cdn.example/img.png' }]),
      context,
      deps({ outputFolder: async () => 'D:\\My Renders' })
    )

    expect(assets[0]?.path).toMatch(
      /^D:\\My Renders\\[a-z0-9-]+-20260909-120000-000001\.png$/
    )
    expect(fs.dirs.has('D:\\My Renders')).toBe(true)
  })

  it('suggests a name with the user-given name taking priority', () => {
    const base = {
      created_at: Date.parse('2026-09-09T12:00:00Z'),
      mime: 'video/mp4',
      path: 'x.mp4',
      provenance: { model_label: 'Wan 2.2' },
    }
    expect(suggestedFileName(base)).toBe('wan-2-2-20260909-120000.mp4')
    expect(suggestedFileName({ ...base, name: 'Beach / sunset!' })).toBe(
      'beach-sunset.mp4'
    )
  })
})
