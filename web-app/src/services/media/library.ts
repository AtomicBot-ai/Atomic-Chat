/**
 * The media library index.
 *
 * `<data_folder>/media/index.json` is the only durable record that a generation
 * ever happened, so this module is written around its failure modes rather than
 * its happy path:
 *
 *  - **A corrupt index degrades to empty and warns.** Throwing would take the
 *    whole Media surface down over one unreadable file.
 *  - **An index written by a NEWER build is never overwritten.** Degrading to
 *    empty is survivable; destroying a library an upgraded app wrote is not. So
 *    a higher `schema_version` puts this instance into read-only mode.
 *  - **Writes are atomic**, temp then rename, for the same reason
 *    materialisation's are: a half-written index is a lost library.
 *  - **Bursts coalesce.** A batch of eight images changes the index eight
 *    times; rewriting it eight times would be eight full serialisations of
 *    everything the user has ever generated.
 */

import { MEDIA_FOLDER, type MediaAsset, type MediaFileSystem } from './assets'

/** Bumped only when the on-disk shape changes incompatibly. */
export const MEDIA_LIBRARY_SCHEMA_VERSION = 1

export const MEDIA_INDEX_FILE = 'index.json'

export type MediaLibraryIndex = {
  schema_version: number
  assets: MediaAsset[]
}

export type MediaLibraryDeps = {
  fs: MediaFileSystem
  /** `AppConfiguration.data_folder`. Never assumed. */
  dataFolder: () => Promise<string>
  warn?: (message: string, cause?: unknown) => void
}

export type MediaLibrary = {
  load: () => Promise<void>
  list: () => MediaAsset[]
  add: (assets: MediaAsset[]) => Promise<void>
  remove: (assetId: string) => Promise<void>
  setFavourite: (assetId: string, favourite: boolean) => Promise<void>
  /** Give an asset a display name; an empty name clears it. */
  rename: (assetId: string, name: string) => Promise<void>
  /** True when the index on disk came from a newer build and must not be written. */
  readOnly: () => boolean
  subscribe: (listener: () => void) => () => void
}

function isAsset(value: unknown): value is MediaAsset {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MediaAsset>
  return (
    typeof candidate.asset_id === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.created_at === 'number'
  )
}

export function createMediaLibrary(deps: MediaLibraryDeps): MediaLibrary {
  const warn = deps.warn ?? (() => {})
  let assets: MediaAsset[] = []
  let readOnly = false
  let indexPath: string | undefined
  const listeners = new Set<() => void>()

  /** A save already scheduled for this turn, which further changes join. */
  let queued: Promise<void> | undefined

  async function pathToIndex(): Promise<string> {
    if (!indexPath) {
      indexPath = deps.fs.join(
        await deps.dataFolder(),
        MEDIA_FOLDER,
        MEDIA_INDEX_FILE
      )
    }
    return indexPath
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  /** Newest first, which is the only order the library is ever displayed in. */
  function sort() {
    assets.sort((a, b) => b.created_at - a.created_at)
  }

  async function writeNow(): Promise<void> {
    if (readOnly) return
    const path = await pathToIndex()
    const payload: MediaLibraryIndex = {
      schema_version: MEDIA_LIBRARY_SCHEMA_VERSION,
      assets,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2))
    const partial = `${path}.partial`
    try {
      await deps.fs.mkdir(deps.fs.join(await deps.dataFolder(), MEDIA_FOLDER))
      await deps.fs.writeBytes(partial, bytes)
      await deps.fs.rename(partial, path)
    } catch (error) {
      await deps.fs.remove(partial).catch(() => undefined)
      // The in-memory library is still correct; only the durable copy failed.
      // Reporting beats throwing, because the user's generation is not lost.
      warn('Could not write the media library index.', error)
    }
  }

  /**
   * Coalesce. Callers still get a promise that resolves once their change is on
   * disk, but three changes in the same turn produce one rewrite, not three.
   */
  function save(): Promise<void> {
    if (queued) return queued
    queued = Promise.resolve().then(async () => {
      queued = undefined
      await writeNow()
    })
    return queued
  }

  return {
    readOnly: () => readOnly,

    async load() {
      const path = await pathToIndex()
      if (!(await deps.fs.exists(path))) {
        // First run. Not a problem, and not worth warning about.
        assets = []
        return
      }

      try {
        const parsed = JSON.parse(await deps.fs.readText(path)) as unknown
        const index = parsed as Partial<MediaLibraryIndex>

        if (
          typeof index?.schema_version === 'number' &&
          index.schema_version > MEDIA_LIBRARY_SCHEMA_VERSION
        ) {
          readOnly = true
          assets = []
          warn(
            `The media library index is schema_version ${index.schema_version}, ` +
              `newer than the ${MEDIA_LIBRARY_SCHEMA_VERSION} this build understands. ` +
              'It will be shown as empty and left untouched rather than overwritten.'
          )
          return
        }

        if (!Array.isArray(index?.assets)) {
          assets = []
          warn('The media library index is not in a shape this build recognises.')
          return
        }

        assets = index.assets.filter(isAsset)
        sort()
      } catch (error) {
        // One unreadable file must not take the Media surface down with it.
        assets = []
        warn('The media library index could not be read; starting empty.', error)
      }
    },

    list: () => assets,

    async add(incoming) {
      if (incoming.length === 0) return
      const known = new Set(assets.map((entry) => entry.asset_id))
      assets = [
        ...incoming.filter((entry) => !known.has(entry.asset_id)),
        ...assets,
      ]
      sort()
      notify()
      await save()
    },

    async remove(assetId) {
      const target = assets.find((entry) => entry.asset_id === assetId)
      if (!target) return

      assets = assets.filter((entry) => entry.asset_id !== assetId)
      notify()
      await save()

      // The bytes go too. An index-only delete would forget the generation
      // while its file stayed on disk forever - unreachable from any UI and
      // still consuming the space, which for video is measured in gigabytes.
      //
      // Deliberately AFTER the index is saved, and deliberately tolerant: a
      // file already gone, or locked by another process, must not resurrect a
      // row the user has just deleted and cannot delete again. Forgetting an
      // entry whose file survives is recoverable; keeping an entry the user
      // told us to remove is not.
      //
      // Note this deletes ADOPTED files too - outputs a provider wrote in its
      // own folder and materialisation pointed at rather than copying. That is
      // what "delete" means here, and it is the user's own instruction.
      for (const path of [target.path, target.thumb_path]) {
        if (!path) continue
        try {
          await deps.fs.remove(path)
        } catch (cause) {
          deps.warn?.(`could not delete ${path}`, cause)
        }
      }
    },

    async setFavourite(assetId, favourite) {
      const target = assets.find((entry) => entry.asset_id === assetId)
      if (!target) return
      assets = assets.map((entry) =>
        entry.asset_id === assetId ? { ...entry, favourite } : entry
      )
      notify()
      await save()
    },

    async rename(assetId, name) {
      const target = assets.find((entry) => entry.asset_id === assetId)
      if (!target) return
      const trimmed = name.trim()
      assets = assets.map((entry) => {
        if (entry.asset_id !== assetId) return entry
        const next = { ...entry }
        if (trimmed) next.name = trimmed
        else delete next.name
        return next
      })
      notify()
      await save()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
