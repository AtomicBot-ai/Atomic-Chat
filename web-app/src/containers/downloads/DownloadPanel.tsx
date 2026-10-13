import { useEffect } from 'react'

import { useDownloadDrawer } from '@/stores/download-drawer-store'
import type { DownloadRowProps } from './DownloadProgressRow'

export type DownloadPanelProps = {
  items: DownloadRowProps[]
  /**
   * Reports whether the drawer is closed, so the owner can measure how long it
   * stayed open without also owning the flag.
   */
  onCollapsedChange?: (collapsed: boolean) => void
}

/**
 * Feeds the download drawer in the sidebar.
 *
 * This used to be a floating panel in the bottom-right corner that had to dodge
 * the composer. The downloads now live in a drawer opened from the sidebar
 * (`DownloadDrawer`), so this renders nothing itself: it hands the rows over
 * and reports the drawer's open state.
 */
export function DownloadPanel({ items, onCollapsedChange }: DownloadPanelProps) {
  const setItems = useDownloadDrawer((state) => state.setItems)
  const open = useDownloadDrawer((state) => state.open)

  useEffect(() => {
    setItems(items)
  }, [items, setItems])

  useEffect(() => {
    onCollapsedChange?.(!open)
  }, [open, onCollapsedChange])

  return null
}
