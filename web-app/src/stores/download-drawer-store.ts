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

export const useDownloadDrawer = create<DownloadDrawerState>()((set, get) => ({
  items: [],
  open: false,
  setItems: (items) => {
    const hadNone = get().items.length === 0
    // The drawer opens by itself when the first download starts, which is the
    // moment the file name and size are worth reading; after that it is the
    // user's to open and close. It closes when the queue empties.
    set({ items, ...(hadNone && items.length > 0 ? { open: true } : {}), ...(items.length === 0 ? { open: false } : {}) })
  },
  setOpen: (open) => set({ open }),
}))

/** Overall progress, 0-1, over the transfers whose size is known. */
export function overallDownloadProgress(items: DownloadRowProps[]): number {
  const known = items.filter((item) => item.total > 0)
  if (known.length === 0) return 0
  const total = known.reduce((sum, item) => sum + item.total, 0)
  const done = known.reduce((sum, item) => sum + Math.min(item.current, item.total), 0)
  return total > 0 ? done / total : 0
}
