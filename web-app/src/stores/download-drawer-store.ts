/**
 * What the sidebar's download drawer shows.
 *
 * `DownloadManagement` owns the real transfers (events, pause, resume, cancel)
 * and mirrors them here as plain rows; the sidebar renders the trigger and the
 * drawer from this. Keeping the two apart means the drawer needs no knowledge
 * of how downloads are tracked, and the tracking needs no knowledge of layout.
 */

import { create } from 'zustand'

import type { DownloadRowProps } from '@/containers/downloads/DownloadProgressRow'

type DownloadDrawerState = {
  items: DownloadRowProps[]
  open: boolean
  setItems: (items: DownloadRowProps[]) => void
  setOpen: (open: boolean) => void
}

export const useDownloadDrawer = create<DownloadDrawerState>()((set) => ({
  items: [],
  open: false,
  setItems: (items) => {
    // The drawer is the user's to open; it never opens by itself. It used to
    // open on the first download, which on a fresh install meant engine
    // downloads nobody had asked for popped it over the onboarding screen.
    // A new download the user started shows a toast with a "View" button
    // instead (`DownloadPanel`). It still closes when the queue empties.
    set({ items, ...(items.length === 0 ? { open: false } : {}) })
  },
  setOpen: (open) => set({ open }),
}))

/**
 * A llama.cpp engine build rather than something the user picked. Their task
 * ids start with `llamacpp` (`llamacpp-backend-<version>/<build>`), the same
 * test `DownloadManagement` uses to route cancel and to withhold pause.
 */
export function isEngineDownload(id: string): boolean {
  return id.startsWith('llamacpp')
}

/** The build part of an engine task id, e.g. `win-cuda-12.4-x64`. */
export function engineBuildName(id: string): string {
  return id.split('/').pop() || id
}

/** Overall progress, 0-1, over the transfers whose size is known. */
export function overallDownloadProgress(items: DownloadRowProps[]): number {
  const known = items.filter((item) => item.total > 0)
  if (known.length === 0) return 0
  const total = known.reduce((sum, item) => sum + item.total, 0)
  const done = known.reduce((sum, item) => sum + Math.min(item.current, item.total), 0)
  return total > 0 ? done / total : 0
}
