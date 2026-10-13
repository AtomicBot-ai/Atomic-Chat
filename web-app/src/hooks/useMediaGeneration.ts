/**
 * The UI entry point for media generation.
 *
 * Replaces `useAtomicMediaJob` as the surface components talk to. The
 * difference that matters is ownership: the old hook *held* the job in
 * `useState`, so the job existed only while one component was mounted
 * (coupling C10). This hook owns nothing. It subscribes to the module-scoped
 * `mediaJobManager`, which keeps running whether or not anything is rendered.
 *
 * `useAtomicMediaJob` is deliberately left untouched and still works exactly as
 * it did - it and `MediaStudio.tsx` are frozen by the selective v2.0.32
 * protected-surface guard, and Task 11 is the task designated to edit them.
 * See decision D5 in the tracker.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from 'zustand'

import {
  mediaJobManager,
  type MediaJobEntry,
  type MediaJobManager,
} from '@/services/media/jobManager'
import type { NormalizedMediaRequest } from '@/services/media/contract'
import { useMediaLastUsedStore } from '@/stores/media-last-used-store'

export type UseMediaGeneration = {
  /** Every tracked job, newest first. */
  jobs: MediaJobEntry[]
  /** The most recently submitted job, if any. */
  latest: MediaJobEntry | undefined
  job: (clientJobId: string) => MediaJobEntry | undefined
  submit: (request: NormalizedMediaRequest) => Promise<MediaJobEntry>
  cancel: (clientJobId: string) => Promise<void>
  canCancel: (clientJobId: string) => boolean
}

export function useMediaGeneration(
  manager: MediaJobManager = mediaJobManager
): UseMediaGeneration {
  // Restore jobs persisted by a previous session, once per mounted hook. The
  // manager's own `load` is idempotent, so a second mount is harmless.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void manager.load()
  }, [manager])

  // Selecting the two stable slices rather than a derived array: zustand v5
  // compares with Object.is, so a selector building a new array every call
  // would re-render on every store read.
  const jobsById = useStore(manager.store, (state) => state.jobs)
  const order = useStore(manager.store, (state) => state.order)

  const jobs = useMemo(
    () =>
      order
        .map((id) => jobsById[id])
        .filter((entry): entry is MediaJobEntry => entry !== undefined),
    [order, jobsById]
  )

  const job = useCallback(
    (clientJobId: string) => jobsById[clientJobId],
    [jobsById]
  )

  const submit = useCallback(
    (request: NormalizedMediaRequest) => {
      // What the user tuned on the Media page is what chat generates with.
      useMediaLastUsedStore.getState().record(request)
      return manager.submit(request)
    },
    [manager]
  )

  const cancel = useCallback(
    (clientJobId: string) => manager.cancel(clientJobId),
    [manager]
  )

  // Reads the manager rather than the snapshot: cancellability depends on what
  // the provider reports, not on anything renderable.
  const canCancel = useCallback(
    (clientJobId: string) => manager.canCancel(clientJobId),
    [manager]
  )

  return { jobs, latest: jobs[0], job, submit, cancel, canCancel }
}
