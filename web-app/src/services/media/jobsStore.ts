/**
 * Durable record of media jobs, so history survives an app restart.
 *
 * `<data_folder>/media/jobs.json` is written with the same discipline as
 * `library.ts` (whose comments explain the failure modes in full):
 *
 *  - **Atomic** writes, temp then rename, so a half-written file is never read
 *    back as the user's history.
 *  - **A corrupt file degrades to empty and warns**, because one unreadable
 *    file must not take the Media surface down.
 *  - **A file written by a NEWER build is never overwritten**: read-only mode.
 *  - **Bursts coalesce** so a job that reports progress many times a second
 *    does not rewrite the whole file on every frame.
 *
 * Unlike the library, the durable shape is deliberately *not* the in-memory
 * `MediaJobEntry`: `outputs` can carry inline base64 bytes far too large to
 * re-serialise on every poll. The library already owns the materialised files,
 * so `jobs.json` records job *state and provenance* (what was asked and how it
 * went), and the caller strips `outputs` before saving.
 */

import { MEDIA_FOLDER, type MediaFileSystem } from './assets'
import type { MediaJobEntry } from './jobManager'

/** Bumped only when the on-disk shape changes incompatibly. */
export const MEDIA_JOBS_SCHEMA_VERSION = 1

export const MEDIA_JOBS_FILE = 'jobs.json'

export type MediaJobsIndex = {
  schema_version: number
  jobs: MediaJobEntry[]
}

export type MediaJobsStoreDeps = {
  fs: MediaFileSystem
  /** `AppConfiguration.data_folder`. Never assumed. */
  dataFolder: () => Promise<string>
  warn?: (message: string, cause?: unknown) => void
}

export type MediaJobsStore = {
  load: () => Promise<MediaJobEntry[]>
  save: (jobs: MediaJobEntry[]) => Promise<void>
  readOnly: () => boolean
}

const JOB_STATES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

function isJobEntry(value: unknown): value is MediaJobEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MediaJobEntry>
  const request = candidate.request as
    | Partial<MediaJobEntry['request']>
    | undefined
  return (
    typeof candidate.client_job_id === 'string' &&
    typeof candidate.provider_id === 'string' &&
    typeof candidate.state === 'string' &&
    JOB_STATES.has(candidate.state) &&
    typeof candidate.submitted_at === 'number' &&
    request !== null &&
    request !== undefined &&
    typeof request.client_job_id === 'string' &&
    typeof request.provider_id === 'string' &&
    typeof request.model_id === 'string' &&
    typeof request.task === 'string' &&
    typeof request.params === 'object' &&
    request.params !== null
  )
}

export function createMediaJobsStore(deps: MediaJobsStoreDeps): MediaJobsStore {
  const warn = deps.warn ?? (() => {})
  let readOnly = false
  let indexPath: string | undefined
  let saveQueued: Promise<void> | undefined
  /** The newest state handed to `save`, written when the queued flush runs. */
  let latest: MediaJobEntry[] = []

  async function pathToIndex(): Promise<string> {
    if (!indexPath) {
      indexPath = deps.fs.join(
        await deps.dataFolder(),
        MEDIA_FOLDER,
        MEDIA_JOBS_FILE
      )
    }
    return indexPath
  }

  async function writeNow(jobs: MediaJobEntry[]): Promise<void> {
    if (readOnly) return
    const path = await pathToIndex()
    const payload: MediaJobsIndex = {
      schema_version: MEDIA_JOBS_SCHEMA_VERSION,
      jobs,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2))
    const partial = `${path}.partial`
    try {
      await deps.fs.mkdir(deps.fs.join(await deps.dataFolder(), MEDIA_FOLDER))
      await deps.fs.writeBytes(partial, bytes)
      await deps.fs.rename(partial, path)
    } catch (error) {
      await deps.fs.remove(partial).catch(() => undefined)
      // The in-memory history is still correct; only the durable copy failed.
      warn('Could not write the media jobs file.', error)
    }
  }

  return {
    readOnly: () => readOnly,

    async load() {
      const path = await pathToIndex()
      if (!(await deps.fs.exists(path))) {
        // First run. Not a problem, and not worth warning about.
        return []
      }

      try {
        const parsed = JSON.parse(await deps.fs.readText(path)) as unknown
        const index = parsed as Partial<MediaJobsIndex>

        if (
          typeof index?.schema_version === 'number' &&
          index.schema_version > MEDIA_JOBS_SCHEMA_VERSION
        ) {
          readOnly = true
          warn(
            `The media jobs file is schema_version ${index.schema_version}, ` +
              `newer than the ${MEDIA_JOBS_SCHEMA_VERSION} this build understands. ` +
              'It will be left untouched rather than overwritten.'
          )
          return []
        }

        if (!Array.isArray(index?.jobs)) {
          warn('The media jobs file is not in a shape this build recognises.')
          return []
        }

        return index.jobs.filter(isJobEntry)
      } catch (error) {
        warn('The media jobs file could not be read; starting empty.', error)
        return []
      }
    },

    async save(jobs) {
      if (readOnly) return
      // Keep the newest snapshot, not the first: the caller passes a fresh
      // array on every change, and only the last one before the flush matters.
      latest = jobs
      if (saveQueued) return
      saveQueued = Promise.resolve().then(async () => {
        saveQueued = undefined
        await writeNow(latest)
      })
      return saveQueued
    },
  }
}
