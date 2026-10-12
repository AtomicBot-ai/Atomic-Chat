/**
 * `jobs.json` store tests.
 *
 * The file is the only durable record of media-job history, so — exactly like
 * `library.test.ts` — the failure modes matter more than the happy path: a
 * corrupt file must not take the Media surface down, and a file written by a
 * NEWER build must not be quietly overwritten by an older one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaFileSystem } from '../assets'
import type { MediaJobEntry } from '../jobManager'
import {
  MEDIA_JOBS_SCHEMA_VERSION,
  MEDIA_JOBS_FILE,
  createMediaJobsStore,
} from '../jobsStore'

const DATA_FOLDER = 'C:\\jan-data'
const INDEX = `${DATA_FOLDER}\\media\\${MEDIA_JOBS_FILE}`

function entry(clientJobId: string): MediaJobEntry {
  return {
    client_job_id: clientJobId,
    provider_job_id: `${clientJobId}-provider`,
    provider_id: 'worker',
    state: 'succeeded',
    outputs: [],
    error: null,
    request: {
      client_job_id: clientJobId,
      provider_id: 'worker',
      model_id: 'worker:model',
      task: 'text_to_image',
      params: { prompt: 'a red car' },
    },
    submitted_at: 1_700_000_000_000,
    cancellable: false,
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
  return createMediaJobsStore({
    fs,
    dataFolder: async () => DATA_FOLDER,
    warn: (message) => warnings.push(message),
  })
}

function indexOf(fs: FakeFs) {
  return JSON.parse(new TextDecoder().decode(fs.files.get(INDEX)!)) as {
    schema_version: number
    jobs: MediaJobEntry[]
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('createMediaJobsStore — first run', () => {
  it('starts empty when there is no jobs file yet', async () => {
    const fs = fakeFs()
    const store = build(fs)

    await expect(store.load()).resolves.toEqual([])
    // A missing file is the normal first-run state, not a problem to report.
    expect(warnings).toEqual([])
  })
})

describe('createMediaJobsStore — round trip', () => {
  it('persists the jobs it is given, atomically', async () => {
    const fs = fakeFs()
    const store = build(fs)

    await store.save([entry('01JOB000000000000000001')])

    expect(fs.writes).toEqual([`${INDEX}.partial`])
    expect(fs.renames).toEqual([[`${INDEX}.partial`, INDEX]])
    expect(indexOf(fs).schema_version).toBe(MEDIA_JOBS_SCHEMA_VERSION)
    expect(indexOf(fs).jobs).toHaveLength(1)
  })

  it('loads back exactly what was saved', async () => {
    const fs = fakeFs()
    const store = build(fs)
    const jobs = [entry('01JOB000000000000000001'), entry('01JOB000000000000000002')]

    await store.save(jobs)
    await expect(store.load()).resolves.toEqual(jobs)
  })

  it('coalesces a burst of saves into a single write of the newest state', async () => {
    const fs = fakeFs()
    const store = build(fs)

    const first = store.save([entry('01JOB000000000000000001')])
    const second = store.save([
      entry('01JOB000000000000000001'),
      entry('01JOB000000000000000002'),
    ])
    await first
    await second

    expect(fs.writes).toHaveLength(1)
    expect(indexOf(fs).jobs).toHaveLength(2)
  })
})

describe('createMediaJobsStore — hostile files', () => {
  it('keeps only entries that look like jobs', async () => {
    const good = entry('01JOB000000000000000001')
    const fs = fakeFs(
      JSON.stringify({
        schema_version: MEDIA_JOBS_SCHEMA_VERSION,
        jobs: [good, { client_job_id: 'not-a-job' }, null, 42],
      })
    )
    const store = build(fs)

    await expect(store.load()).resolves.toEqual([good])
  })

  it('degrades to empty when the file is not valid JSON', async () => {
    const fs = fakeFs('{ definitely not json')
    const store = build(fs)

    await expect(store.load()).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('degrades to empty when `jobs` is missing', async () => {
    const fs = fakeFs(JSON.stringify({ schema_version: MEDIA_JOBS_SCHEMA_VERSION }))
    const store = build(fs)

    await expect(store.load()).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('goes read-only rather than overwriting a newer schema', async () => {
    const newer = JSON.stringify({
      schema_version: MEDIA_JOBS_SCHEMA_VERSION + 1,
      jobs: [entry('01JOB000000000000000001')],
    })
    const fs = fakeFs(newer)
    const store = build(fs)

    await expect(store.load()).resolves.toEqual([])
    expect(store.readOnly()).toBe(true)
    expect(warnings).toHaveLength(1)

    await store.save([entry('01JOB000000000000000002')])
    // The newer file must be left byte-for-byte untouched.
    expect(fs.writes).toHaveLength(0)
    expect(new TextDecoder().decode(fs.files.get(INDEX))).toBe(newer)
  })
})
