import { IconX } from '@tabler/icons-react'
import { DownloadIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useSidebar } from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  engineBuildName,
  isEngineDownload,
  overallDownloadProgress,
  useDownloadDrawer,
} from '@/stores/download-drawer-store'
import {
  DOWNLOAD_PROGRESS_INDICATOR,
  DownloadProgressRow,
  type DownloadRowProps,
} from './DownloadProgressRow'

/**
 * The sidebar entry for downloads: a progress ring with a count. It is absent
 * when nothing is downloading, and sits above Settings in both the open and the
 * icon-only sidebar.
 */
export function DownloadRailButton() {
  const { t } = useTranslation()
  const items = useDownloadDrawer((state) => state.items)
  const open = useDownloadDrawer((state) => state.open)
  const setOpen = useDownloadDrawer((state) => state.setOpen)

  if (items.length === 0) return null
  const percent = Math.round(overallDownloadProgress(items) * 100)

  return (
    <button
      type="button"
      data-testid="download-rail-button"
      aria-label={t('common:downloads')}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className={cn(
        'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md p-2 text-left text-sm outline-hidden',
        'hover:bg-sidebar-foreground/8',
        open && 'bg-sidebar-foreground/15',
        'group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0'
      )}
    >
      {/* A conic ring rather than an SVG: the sidebar rescales every SVG in its
          buttons for the icon-only state, which would distort a drawn ring. */}
      <span
        className="relative grid size-6 shrink-0 place-items-center rounded-full"
        style={{
          background: `conic-gradient(var(--color-emerald-400) ${percent}%, color-mix(in oklab, currentColor 18%, transparent) 0)`,
        }}
      >
        <span className="absolute inset-[3px] rounded-full bg-sidebar" />
        <DownloadIcon className="relative z-10 size-3 text-foreground/70" />
        <span className="absolute -right-1.5 -top-1.5 z-10 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-semibold tabular-nums text-white">
          {items.length}
        </span>
      </span>
      <span className="truncate group-data-[collapsible=icon]:hidden">
        {t('common:downloads')}
      </span>
      <span className="ml-auto text-xs tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
        {percent}%
      </span>
    </button>
  )
}

/**
 * One line for an engine build the app is fetching on its own. The user did
 * not start it, so it gets a name, a thin bar, a percentage and Cancel - not a
 * full card competing with their own downloads.
 */
function EngineDownloadRow({ item }: { item: DownloadRowProps }) {
  const { t } = useTranslation()
  const known = item.total > 0
  return (
    <li data-testid="engine-download-row" className="py-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate" title={item.id}>
          {t('common:downloadPanel.engineName', {
            name: engineBuildName(item.id),
          })}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {known
            ? `${Math.round(item.progress * 100)}%`
            : t('common:downloadPanel.preparing')}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={item.onCancel}
          aria-label={t('common:cancelDownload')}
        >
          <IconX size={14} className="text-muted-foreground" />
        </Button>
      </div>
      <Progress
        value={item.progress * 100}
        indicatorClassName={DOWNLOAD_PROGRESS_INDICATOR}
        className="mt-1 h-1 rounded-full bg-muted-foreground/15 dark:bg-muted-foreground/20"
      />
    </li>
  )
}

/**
 * Opens beside the sidebar's Downloads button, only when the user opens it.
 * A plain list: each download the user started is a row with its name, a
 * thin bar, size, speed, time left, and Pause/Cancel; engine builds the app
 * fetches by itself sit below as single quiet lines. Nothing animates.
 */
export function DownloadDrawer() {
  const { t } = useTranslation()
  const { state } = useSidebar()
  const items = useDownloadDrawer((s) => s.items)
  const open = useDownloadDrawer((s) => s.open)
  const setOpen = useDownloadDrawer((s) => s.setOpen)
  const shown = open && items.length > 0

  const userItems = items.filter((item) => !isEngineDownload(item.id))
  const engineItems = items.filter((item) => isEngineDownload(item.id))

  return (
    <aside
      aria-label={t('common:downloads')}
      aria-hidden={!shown}
      inert={!shown}
      data-testid="download-drawer"
      className={cn(
        'fixed bottom-2 z-40 flex max-h-[min(34rem,calc(100svh-3.5rem))] w-[22rem] max-w-[calc(100vw-5rem)] flex-col gap-3 rounded-2xl border bg-background p-3 shadow-xl',
        'transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
        shown
          ? 'translate-x-0 opacity-100'
          : 'pointer-events-none -translate-x-3 opacity-0'
      )}
      style={{
        left:
          state === 'collapsed'
            ? 'calc(var(--sidebar-width-icon, 3rem) + 1.75rem)'
            : 'calc(var(--sidebar-width, 15rem) + 0.75rem)',
      }}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {t('common:downloads')}
          <span className="rounded-full bg-muted-foreground/15 px-1.5 text-xs tabular-nums text-muted-foreground">
            {items.length}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(false)}
          aria-label={t('common:downloadPanel.collapse')}
        >
          <IconX size={16} className="text-muted-foreground" />
        </Button>
      </header>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {userItems.length > 0 && (
          <ul data-testid="download-list" className="flex flex-col gap-2">
            {userItems.map((item) => (
              <DownloadProgressRow key={item.id} {...item} />
            ))}
          </ul>
        )}
        {engineItems.length > 0 && (
          <section className={cn(userItems.length > 0 && 'mt-3 border-t pt-2')}>
            <h3 className="mb-0.5 text-xs font-medium text-muted-foreground">
              {t('common:downloadPanel.engines')}
            </h3>
            <ul>
              {engineItems.map((item) => (
                <EngineDownloadRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  )
}
