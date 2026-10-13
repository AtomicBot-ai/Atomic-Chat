import { useEffect, useState } from 'react'
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from '@tabler/icons-react'
import { DownloadIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  overallDownloadProgress,
  useDownloadDrawer,
} from '@/stores/download-drawer-store'
import {
  formatEta,
  formatProgressPair,
  formatSpeed,
  shortModelName,
} from '@/lib/downloadFormat'
import { quantFromModelId } from '@/lib/telemetry'
import type { DownloadRowProps } from './DownloadProgressRow'
import { hueFor, pruneBlockFields } from '@/lib/downloadBlockFields'
import { FallingBlocks } from './FallingBlocks'

const accent = (hue: number, alpha = 1) => `hsl(${hue} 70% 55% / ${alpha})`

/** One coloured button per download; the figures on it are real. */
function DownloadTab({
  item,
  hue,
  selected,
  onSelect,
}: {
  item: DownloadRowProps
  hue: number
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const percent = Math.round(item.progress * 100)
  const speed = item.paused ? null : formatSpeed(item.bytesPerSecond)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-testid="download-tab"
      data-no-hover-glow
      onClick={onSelect}
      title={item.id}
      className={cn(
        'flex min-w-0 flex-1 flex-col rounded-lg border px-2 py-1 text-left transition-colors',
        selected ? 'shadow-md' : 'opacity-75 hover:opacity-100'
      )}
      style={{
        borderColor: accent(hue, selected ? 0.9 : 0.4),
        background: accent(hue, selected ? 0.22 : 0.1),
      }}
    >
      <span className="truncate text-[11px] font-medium">
        {shortModelName(item.name || item.id)}
      </span>
      <span className="truncate font-mono text-[10px] tabular-nums text-muted-foreground">
        {item.paused
          ? t('common:downloadPanel.paused')
          : item.total > 0
            ? `${percent}%${speed ? ` · ${speed}` : ''}`
            : t('common:downloadPanel.preparing')}
      </span>
    </button>
  )
}

/** The picture plus the real numbers for the selected download. */
function DownloadStage({
  item,
  hue,
}: {
  item: DownloadRowProps
  hue: number
}) {
  const { t } = useTranslation()
  const known = item.total > 0
  const percent = Math.round(item.progress * 100)
  const speed = item.paused ? null : formatSpeed(item.bytesPerSecond)
  const eta = item.paused
    ? null
    : formatEta(item.total - item.current, item.bytesPerSecond)
  const quant = quantFromModelId(item.id)

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border p-3"
      style={{ borderColor: accent(hue, 0.35) }}
      role="tabpanel"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black/30">
        <FallingBlocks
          id={item.id}
          hue={hue}
          paused={item.paused}
          progress={item.progress}
          className="absolute inset-0 size-full"
        />
      </div>

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={item.id}>
            {shortModelName(item.name || item.id)}
          </p>
          {quant && (
            <p className="truncate text-xs text-muted-foreground">{quant}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-0.5">
          {item.pausable &&
            (item.paused ? (
              <Button
                variant="secondary"
                size="icon-xs"
                onClick={item.onResume}
                aria-label={t('common:resumeDownload')}
              >
                <IconPlayerPlay size={16} />
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="icon-xs"
                onClick={item.onPause}
                aria-label={t('common:pauseDownload')}
              >
                <IconPlayerPause size={16} />
              </Button>
            ))}
          <Button
            variant="secondary"
            size="icon-xs"
            onClick={item.onCancel}
            aria-label={t('common:cancelDownload')}
          >
            <IconX size={16} />
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs tabular-nums">
        <dt className="text-muted-foreground">
          {t('common:downloadPanel.progress', { defaultValue: 'Progress' })}
        </dt>
        <dd className="text-right">
          {item.paused
            ? t('common:downloadPanel.paused')
            : known
              ? `${percent}%`
              : t('common:downloadPanel.preparing')}
        </dd>
        <dt className="text-muted-foreground">
          {t('common:downloadPanel.size', { defaultValue: 'Downloaded' })}
        </dt>
        <dd className="text-right">
          {known ? formatProgressPair(item.current, item.total) : '–'}
        </dd>
        <dt className="text-muted-foreground">
          {t('common:downloadPanel.speed', { defaultValue: 'Speed' })}
        </dt>
        <dd className="text-right">{speed ?? '–'}</dd>
        <dt className="text-muted-foreground">
          {t('common:downloadPanel.timeLeft', { defaultValue: 'Time left' })}
        </dt>
        <dd className="text-right">{eta ?? '–'}</dd>
      </dl>
    </div>
  )
}

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

/** Tabs of coloured buttons, one per download, above the selected one's stage. */
function DownloadTabs({ items }: { items: DownloadRowProps[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = items.find((item) => item.id === selectedId) ?? items[0]

  useEffect(() => {
    pruneBlockFields(items.map((item) => item.id))
  }, [items])

  if (!selected) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div role="tablist" className="flex gap-1.5">
        {items.map((item, index) => (
          <DownloadTab
            key={item.id}
            item={item}
            hue={hueFor(index)}
            selected={item.id === selected.id}
            onSelect={() => setSelectedId(item.id)}
          />
        ))}
      </div>
      <DownloadStage item={selected} hue={hueFor(items.indexOf(selected))} />
    </div>
  )
}

/** Slides out beside the sidebar; every transfer with its pause and cancel. */
export function DownloadDrawer() {
  const { t } = useTranslation()
  const { state } = useSidebar()
  const items = useDownloadDrawer((s) => s.items)
  const open = useDownloadDrawer((s) => s.open)
  const setOpen = useDownloadDrawer((s) => s.setOpen)
  const shown = open && items.length > 0

  return (
    <aside
      aria-label={t('common:downloads')}
      aria-hidden={!shown}
      inert={!shown}
      data-testid="download-drawer"
      className={cn(
        'fixed inset-y-2 z-40 flex w-[22rem] max-w-[calc(100vw-5rem)] flex-col gap-3 rounded-2xl border bg-background p-3 shadow-xl',
        'transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        shown
          ? 'translate-x-0 opacity-100'
          : 'pointer-events-none -translate-x-6 opacity-0'
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
      <DownloadTabs items={items} />
    </aside>
  )
}
