/**
 * Media library index tests.
 *
 * `index.json` is the only durable record that a generation ever happened, so
 * the failure modes matter more than the happy path: a corrupt file must not
 * take the Media surface down with it, and an index written by a NEWER build
 * must not be quietly overwritten by an older one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaAsset, MediaFileSystem } from '../assets'
import {
  MEDIA_LIBRARY_SCHEMA_VERSION,
  createMediaLibrary,
} from '../library'

const DATA_FOLDER = 'C:\\jan-data'
const INDEX = `${DATA_FOLDER}\\media\\index.json`

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    asset_id: id,
    client_job_id: `job-${id}`,
    media_type: 'image',
    path: `${DATA_FOLDER}\\media\\outputs\\2026\\09\\${id}.png`,
    mime: 'image/png',
    bytes: 1024,
    created_at: 1_757_000_000_000,
    provenance: {
      provider_id: 'comfyui-local',
      model_id: 'comfyui-local:txt2img',
      model_label: 'Text to image',
      task: 'text_to_image',
      params: { prompt: 'a red car' },
      app_version: '2.0.23',
      contract_version: 2,
    },
    ...overrides,
  }
}

type FakeFs = MediaFileSystem & {
  files: Map<string, Uint8Array>
  renames: [string, string][]
  writes: string[]
}

function fakeFs(seed?: string): FakeFs {
  const files = new Map<string, Uint8Array>()
  const renames: [string, string][] = []
  const writes: string[] = []
  if (seed !== undefined) files.set(INDEX, new TextEncoder().encode(seed))

  return {
    files,
    renames,
    writes,
    join: (...parts: string[]) => parts.join('\\'),
    async mkdir() {},
    async exists(path) {
      return files.has(path)
    },
    async writeBytes(path, bytes) {
      writes.push(path)
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
    },
    async size(path) {
      return files.get(path)?.byteLength ?? 0
    },
  }
}

let warnings: string[]

function build(fs: FakeFs) {
  warnings = []
  return createMediaLibrary({
    fs,
    dataFolder: async () => DATA_FOLDER,
    warn: (message) => warnings.push(message),
  })
}

function indexOf(fs: FakeFs) {
  return JSON.parse(new TextDecoder().decode(fs.files.get(INDEX)!)) as {
    schema_version: number
    assets: MediaAsset[]
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('createMediaLibrary — first run', () => {
  it('starts empty when there is no index yet', async () => {
    const fs = fakeFs()
    const library = build(fs)

    await library.load()

    expect(library.list()).toEqual([])
    // A missing index is the normal first-run state, not a problem to report.
    expect(warnings).toEqual([])
  })

  it('writes schema_version from the very first save', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()

    await library.add([asset('a1')])

    // Day one, so a later shape change has somewhere to hang.
    expect(indexOf(fs).schema_version).toBe(MEDIA_LIBRARY_SCHEMA_VERSION)
  })
})

describe('createMediaLibrary — persistence', () => {
  it('survives a reload', async () => {
    const fs = fakeFs()
    const first = build(fs)
    await first.load()
    // Distinct timestamps: newest-first is only meaningful if they differ.
    await first.add([
      asset('a1', { created_at: 1_757_000_000_000 }),
      asset('a2', { created_at: 1_757_000_001_000 }),
    ])

    const second = build(fs)
    await second.load()

    expect(second.list().map((entry) => entry.asset_id)).toEqual(['a2', 'a1'])
  })

  it('writes through a temp file and promotes it by rename', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()

    await library.add([asset('a1')])

    // A half-written index is a lost library, so the same temp-then-rename
    // pattern materialisation uses applies here too.
    expect(fs.renames).toHaveLength(1)
    expect(fs.renames[0]![0]).toBe(`${INDEX}.partial`)
    expect(fs.renames[0]![1]).toBe(INDEX)
  })

  it('coalesces a burst of changes into one rewrite', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()

    await Promise.all([
      library.add([asset('a1')]),
      library.add([asset('a2')]),
      library.add([asset('a3')]),
    ])

    // A batch of eight images must not rewrite the whole index eight times.
    expect(fs.renames.length).toBeLessThan(3)
    expect(library.list()).toHaveLength(3)
  })

  it('keeps newest first', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()

    await library.add([asset('old', { created_at: 1 })])
    await library.add([asset('new', { created_at: 2 })])

    expect(library.list()[0]?.asset_id).toBe('new')
  })
})

describe('createMediaLibrary — damaged or foreign index', () => {
  it('degrades to empty and warns rather than throwing on corrupt JSON', async () => {
    const fs = fakeFs('{ this is not json')
    const library = build(fs)

    await expect(library.load()).resolves.toBeUndefined()

    expect(library.list()).toEqual([])
    expect(warnings.join(' ')).toMatch(/index/i)
  })

  it('degrades to empty when the index is JSON but the wrong shape', async () => {
    const fs = fakeFs('{"schema_version":1,"assets":"not-an-array"}')
    const library = build(fs)

    await library.load()

    expect(library.list()).toEqual([])
    expect(warnings).not.toEqual([])
  })

  it('refuses to overwrite an index written by a newer build', async () => {
    const fs = fakeFs(
      JSON.stringify({
        schema_version: MEDIA_LIBRARY_SCHEMA_VERSION + 1,
        assets: [asset('from-the-future')],
      })
    )
    const library = build(fs)
    await library.load()

    await library.add([asset('a1')])

    // Degrading to empty is survivable; destroying a newer library is not. The
    // file on disk must still be the newer one, untouched.
    expect(indexOf(fs).assets[0]?.asset_id).toBe('from-the-future')
    expect(fs.renames).toHaveLength(0)
    expect(warnings.join(' ')).toMatch(/newer/i)
  })
})

describe('createMediaLibrary — mutation', () => {
  it('removes an asset', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()
    await library.add([asset('a1'), asset('a2')])

    await library.remove('a1')

    expect(library.list().map((entry) => entry.asset_id)).toEqual(['a2'])
    expect(indexOf(fs).assets).toHaveLength(1)
  })

  it('marks and unmarks a favourite', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()
    await library.add([asset('a1')])

    await library.setFavourite('a1', true)
    expect(library.list()[0]?.favourite).toBe(true)

    await library.setFavourite('a1', false)
    expect(library.list()[0]?.favourite).toBe(false)
  })

  it('ignores a mutation for an asset it does not have', async () => {
    const fs = fakeFs()
    const library = build(fs)
    await library.load()

    await expect(library.remove('nope')).resolves.toBeUndefined()
    expect(library.list()).toEqual([])
  })
})

/**
 * Task 13 Step 1 - deleting an asset must remove the FILE as well as the index
 * entry, which is what the plan asks for and what a user clicking "Delete"
 * plainly means.
 *
 * Task 8 built `remove` as an index-only operation. Left that way the library
 * would forget a generation while its bytes stayed on disk forever, so the
 * user's disk fills with files nothing references and no UI can reach.
 */
describe('remove deletes the bytes, not just the record', () => {
  it('deletes the asset file and its thumbnail', async () => {
    const fs = fakeFs()
    const library = build(fs)
    const entry = asset('01', { thumb_path: `${DATA_FOLDER}\\media\\thumbs\\01.webp` })
    fs.files.set(entry.path, new Uint8Array([1]))
    fs.files.set(entry.thumb_path!, new Uint8Array([2]))

    await library.add([entry])
    await library.remove('01')

    expect(fs.files.has(entry.path)).toBe(false)
    expect(fs.files.has(entry.thumb_path!)).toBe(false)
    expect(library.list()).toHaveLength(0)
  })

  it('still forgets the entry when the file is already gone', async () => {
    const fs = fakeFs()
    const library = build(fs)
    const entry = asset('02')
    // Never written: the user deleted it in Explorer, or a sync tool moved it.
    await library.add([entry])

    await expect(library.remove('02')).resolves.toBeUndefined()
    expect(library.list()).toHaveLength(0)
  })

  it('forgets the entry even when deleting the file fails', async () => {
    const fs = fakeFs()
    const library = build(fs)
    const entry = asset('03')
    fs.files.set(entry.path, new Uint8Array([1]))
    await library.add([entry])

    // A locked file on Windows, or a permission error. The index entry must
    // still go: refusing to forget would leave a row the user cannot delete.
    fs.remove = async () => {
      throw new Error('EPERM')
    }

    await expect(library.remove('03')).resolves.toBeUndefined()
    expect(library.list()).toHaveLength(0)
  })

  it('leaves other assets files alone', async () => {
    const fs = fakeFs()
    const library = build(fs)
    const keep = asset('keep')
    const drop = asset('drop')
    fs.files.set(keep.path, new Uint8Array([1]))
    fs.files.set(drop.path, new Uint8Array([2]))

    await library.add([keep, drop])
    await library.remove('drop')

    expect(fs.files.has(keep.path)).toBe(true)
    expect(fs.files.has(drop.path)).toBe(false)
  })
})

describe('createMediaLibrary — rename', () => {
  it('sets, trims and clears a display name without touching the file', async () => {
    const fs = fakeFs()
    const library = createMediaLibrary({ fs, dataFolder: async () => DATA_FOLDER })
    const item = asset('A')
    await library.load()
    await library.add([item])
    fs.files.set(item.path, new Uint8Array([1]))

    await library.rename('A', '  Sunset  ')
    expect(library.list()[0]?.name).toBe('Sunset')

    await library.rename('A', '   ')
    expect(library.list()[0]?.name).toBeUndefined()
    expect(fs.files.has(item.path)).toBe(true)
  })
})
