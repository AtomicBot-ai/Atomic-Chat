import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { shortModelName } from '@/lib/downloadFormat'
import {
  isEngineDownload,
  useDownloadDrawer,
} from '@/stores/download-drawer-store'
import type { DownloadRowProps } from './DownloadProgressRow'

export type DownloadPanelProps = {
  items: DownloadRowProps[]
}

/**
 * Feeds the download drawer in the sidebar.
 *
 * This used to be a floating panel in the bottom-right corner that had to dodge
 * the composer. The downloads now live in a drawer opened from the sidebar
 * (`DownloadDrawer`), so this renders nothing itself: it hands the rows over
 * and announces each download the user starts with a toast whose "View"
 * button opens the drawer. The drawer no
 * longer opens by itself, and engine builds the app fetches on its own are
 * not announced at all.
 */
export function DownloadPanel({ items }: DownloadPanelProps) {
  const { t } = useTranslation()
  const setItems = useDownloadDrawer((state) => state.setItems)
  const setOpen = useDownloadDrawer((state) => state.setOpen)
  const announced = useRef(new Set<string>())

  useEffect(() => {
    setItems(items)
  }, [items, setItems])

  useEffect(() => {
    const current = new Set(items.map((item) => item.id))
    for (const id of [...announced.current]) {
      if (!current.has(id)) announced.current.delete(id)
    }
    for (const item of items) {
      if (isEngineDownload(item.id) || announced.current.has(item.id)) continue
      announced.current.add(item.id)
      toast(
        t('common:downloadPanel.started', {
          name: shortModelName(item.name || item.id),
        }),
        {
          id: `download-started-${item.id}`,
          action: {
            label: t('common:downloadPanel.view'),
            onClick: () => setOpen(true),
          },
        }
      )
    }
  }, [items, setOpen, t])

  return null
}
