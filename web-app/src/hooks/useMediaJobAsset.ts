/**
 * Materialise a finished job's outputs, and put them in the library.
 *
 * Task 8 built `materialize()` and the library store but wired neither: the job
 * manager does not know the library exists, and the plan puts that meeting
 * point in Task 11. This hook is it.
 *
 * The invariant it upholds is decision Q4's: nothing renders a provider's own
 * output reference. Bytes land on disk first, and the preview is handed a local
 * path. That is why the CSP could be left alone rather than widened to allow
 * remote media for the entire application.
 *
 * Materialisation runs at most once per job. A repeat would re-download a file
 * that can be hundreds of megabytes and, on a metered provider, could be
 * charged for a second time - so the guard is keyed on the job id and survives
 * re-renders, rather than living in a dependency array.
 */
import { useEffect, useRef, useState } from 'react'
import { ulid } from 'ulidx'

import {
  createBrowserThumbnailer,
  materialize,
  type MaterializeContext,
  type MaterializeDeps,
  type MediaAsset,
} from '@/services/media/assets'
import {
  coreMediaFileSystem,
  mediaDataFolder,
  useMediaLibraryStore,
} from '@/stores/media-library-store'
import { chosenMediaOutputFolder } from '@/stores/media-output-store'
import { isTerminalMediaJobState } from '@/services/media/jobManager'
import type { MediaJobEntry } from '@/services/media/jobManager'
import type { MediaJobSnapshot } from '@/services/media/contract'

/** The real dependencies, for the running app. */
export const browserMaterializeDeps: MaterializeDeps = {
  fs: coreMediaFileSystem,
  dataFolder: mediaDataFolder,
  outputFolder: chosenMediaOutputFolder,
  fetchBytes: async (url: string) => {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Fetching ${url} failed with ${response.status}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      mime: response.headers.get('content-type') ?? undefined,
    }
  },
  now: () => Date.now(),
  newId: () => ulid(),
  // Non-fatal by contract: `materialize` keeps the asset if this throws, which
  // is what happens anywhere without a canvas.
  thumbnail: createBrowserThumbnailer(),
}

/** Injected so tests can drive the hook without a filesystem. */
type MaterializeFn = (
  snapshot: MediaJobSnapshot,
  context: MaterializeContext,
  deps: MaterializeDeps
) => Promise<MediaAsset[]>

export function useMediaJobAsset(
  entry: MediaJobEntry | undefined,
  modelLabel: string,
  deps: MaterializeDeps = browserMaterializeDeps,
  run: MaterializeFn = materialize
): MediaAsset | null {
  const [asset, setAsset] = useState<MediaAsset | null>(null)
  const handled = useRef<string | null>(null)
  const add = useMediaLibraryStore((state) => state.add)

  const jobId = entry?.client_job_id
  const state = entry?.state

  useEffect(() => {
    if (!entry || state !== 'succeeded') return
    if (handled.current === jobId) return
    handled.current = jobId ?? null

    let cancelled = false

    void (async () => {
      try {
        const assets = await run(
          entry,
          {
            request: entry.request,
            model_label: modelLabel,
            app_version: VERSION,
          },
          deps
        )
        if (cancelled || assets.length === 0) return

        await add(assets)
        setAsset(assets[0] ?? null)
      } catch (error) {
        // A failed save must not take the screen down: the generation itself
        // succeeded, and the job status still says so.
        console.warn('[media] materialising the job outputs failed', error)
      }
    })()

    return () => {
      cancelled = true
    }
    // `entry` is intentionally not a dependency: the manager replaces the
    // object on every poll, and the job id plus its state are what actually
    // decide whether there is new work to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, state, modelLabel, add, deps, run])

  // A new job clears the previous preview, so a finished image never sits over
  // a generation that is still running.
  useEffect(() => {
    if (jobId && handled.current !== jobId) setAsset(null)
  }, [jobId])

  return isTerminalMediaJobState(state ?? 'queued') || asset ? asset : null
}
