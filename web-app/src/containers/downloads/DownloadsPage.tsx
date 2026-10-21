import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Clapperboard,
  Cpu,
  FileClock,
  HardDrive,
  Image,
  Mic,
  PieChart,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import HeaderPage from '@/containers/HeaderPage'
import { useInstalledInventory } from '@/hooks/useInstalledInventory'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { downloadStatusLabel, formatProgressPair } from '@/lib/downloadFormat'
import {
  INVENTORY_CATEGORIES,
  type InventoryCategory,
  type InventoryItem,
  type InventoryKind,
} from '@/lib/installed-inventory'
import { isManagedProvider, managedEngines } from '@/lib/managed-engines'
import { formatBytes } from '@/lib/utils'

type CategoryFilter = 'all' | InventoryCategory

const KIND_ICONS: Record<InventoryKind, typeof Box> = {
  model: Box,
  embedding: Box,
  decision: Box,
  image: Image,
  video: Clapperboard,
  voice: Mic,
  engine: Cpu,
  partial: FileClock,
  draft: Zap,
}

/** `—` where the source does not say; never a made-up size. */
const sizeLabel = (bytes: number | null): string =>
  bytes && bytes > 0 ? formatBytes(bytes) : '—'

/** The name a confirmation and its toast use: a build is named with its version. */
const removalName = (item: InventoryItem): string =>
  item.kind === 'engine' ? [item.name, ...item.details].join(' ') : item.name

type Refusal = { code?: unknown; message?: unknown }

/**
 * Downloads — everything the app put on this computer, how much room it
 * takes, and a way to remove it. Built from the stores that own each kind
 * (`useInstalledInventory`); there is no usage history behind it, so the page
 * shows inventory, sizes, free space and removal only.
 */
export function DownloadsPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { items, totalBytes, remove, cancel } = useInstalledInventory()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [confirming, setConfirming] = useState<InventoryItem | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)

  const refreshFreeSpace = useCallback(() => {
    serviceHub
      .modelSetup()
      .diskAvailable()
      .then(setFreeBytes)
      .catch(() => setFreeBytes(null))
  }, [serviceHub])

  useEffect(() => refreshFreeSpace(), [refreshFreeSpace])

  const kindLabel = useCallback(
    (kind: InventoryKind) =>
      kind === 'model' ? null : t(`downloads:kind.${kind}`),
    [t]
  )

  /** Why the remove button is off, when it is: the owner's reason or ours. */
  const blockedReason = useCallback(
    (item: InventoryItem): string | null =>
      item.notRemovableReason
        ? t(`settings:engineBuilds.notRemovable.${item.notRemovableReason}`)
        : item.removalBlocked
          ? t(`downloads:blocked.${item.removalBlocked}`)
          : null,
    [t]
  )

  const detailLine = useCallback(
    (item: InventoryItem) =>
      [...item.details, kindLabel(item.kind), blockedReason(item)]
        .filter(Boolean)
        .join(' · '),
    [kindLabel, blockedReason]
  )

  // What a download that never finished left behind is not a downloaded item.
  const installedCount = items.filter(
    (item) => !item.download && item.kind !== 'partial'
  ).length
  const hasEngineBuilds = items.some((item) => item.kind === 'engine')

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter(
      (item) =>
        (category === 'all' || item.category === category) &&
        (needle.length === 0 ||
          `${item.name} ${detailLine(item)}`.toLowerCase().includes(needle))
    )
  }, [items, query, category, detailLine])

  const describeRefusal = (refusal: unknown): string => {
    const { code, message } = (refusal ?? {}) as Refusal
    const text =
      typeof message === 'string'
        ? message
        : refusal instanceof Error
          ? refusal.message
          : String(refusal)
    if (code === 'BACKEND_IN_USE')
      return t('settings:engineBuilds.error.inUse', { message: text })
    if (code === 'INVALID_REQUEST')
      return t('settings:engineBuilds.error.invalid', { message: text })
    if (code === 'DOWNLOAD_ACTIVE') return t('downloads:error.downloadActive')
    if (code === 'DRAFT_IN_USE') return t('downloads:blocked.draftInUse')
    return text
  }

  const confirmRemove = async (item: InventoryItem) => {
    setRemoving(item.key)
    try {
      await remove(item)
      toast.success(t('downloads:removed', { name: removalName(item) }))
      setConfirming(null)
    } catch (refusal) {
      console.error('[downloads] remove failed:', refusal)
      toast.error(t('downloads:removeFailed', { name: removalName(item) }), {
        description: describeRefusal(refusal),
      })
      setConfirming(null)
    } finally {
      setRemoving(null)
      refreshFreeSpace()
    }
  }

  const tiles = [
    {
      icon: HardDrive,
      // Nothing on disk is a known zero, unlike a size nobody reported.
      value: totalBytes > 0 ? formatBytes(totalBytes) : '0 MB',
      label: t('downloads:summary.totalStorage'),
      hint: hasEngineBuilds ? t('downloads:summary.enginesNotCounted') : null,
    },
    {
      icon: Box,
      value: String(installedCount),
      label: t('downloads:summary.items'),
      hint: null,
    },
    {
      icon: PieChart,
      value: sizeLabel(freeBytes),
      label: t('downloads:summary.freeSpace'),
      hint: null,
    },
  ]

  const managedNote =
    confirming?.removal?.type === 'model' &&
    isManagedProvider(confirming.removal.provider)

  return (
    <div className="flex h-svh w-full min-w-0 flex-col">
      <HeaderPage>
        <div className="flex items-center justify-between">
          <h1 className="font-studio text-lg font-semibold">
            {t('downloads:title')}
          </h1>
        </div>
      </HeaderPage>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div
          className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3"
          data-testid="downloads-summary"
        >
          {tiles.map(({ icon: Icon, value, label, hint }) => (
            <div
              key={label}
              className="min-w-0 rounded-xl border border-border bg-card p-4"
            >
              <Icon size={17} className="mb-3 text-muted-foreground" />
              <div
                className="font-studio truncate text-xl font-semibold tabular-nums"
                aria-label={label}
              >
                {value}
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {label}
              </p>
              {hint && (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                  {hint}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="my-4 flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={t('downloads:searchLabel')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('downloads:search')}
              className="pl-9"
            />
          </div>
          <select
            aria-label={t('downloads:categoryLabel')}
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as CategoryFilter)
            }
            className="h-9 max-w-[45%] shrink-0 rounded-md border border-input bg-background px-3 text-sm"
          >
            {(['all', ...INVENTORY_CATEGORIES] as const).map((value) => (
              <option key={value} value={value}>
                {t(`downloads:category.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="bg-secondary/30 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">
                  {t('downloads:column.download')}
                </th>
                <th className="w-[11em] p-3 font-medium">
                  {t('downloads:column.storage')}
                </th>
                <th className="w-[3.75rem] p-3">
                  <span className="sr-only">
                    {t('downloads:column.actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const Icon = KIND_ICONS[item.kind]
                const detail = detailLine(item)
                return (
                  <tr
                    key={item.key}
                    data-testid="downloads-row"
                    className="border-t border-border hover:bg-secondary/20"
                  >
                    <td className="p-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                          <Icon size={17} />
                        </div>
                        <div className="min-w-0">
                          <div
                            className="truncate font-medium"
                            title={item.name}
                          >
                            {item.name}
                          </div>
                          {detail && (
                            <div
                              className="mt-0.5 truncate text-xs text-muted-foreground"
                              title={detail}
                            >
                              {detail}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap tabular-nums">
                      {item.download ? (
                        <div className="min-w-0">
                          <div className="truncate">
                            {downloadStatusLabel(t, item.download)}
                          </div>
                          {item.download.total > 0 && (
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {formatProgressPair(
                                item.download.current,
                                item.download.total
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span
                          title={
                            item.bytes === null
                              ? t('downloads:unknownSize')
                              : undefined
                          }
                        >
                          {sizeLabel(item.bytes)}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      {item.download ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('common:cancelDownload')}
                          title={t('common:cancelDownload')}
                          onClick={() => cancel(item)}
                          className="text-muted-foreground"
                        >
                          <X size={15} />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('downloads:remove', {
                            name: [item.name, detail]
                              .filter(Boolean)
                              .join(' · '),
                          })}
                          title={
                            blockedReason(item) ?? t('downloads:removeTitle')
                          }
                          disabled={
                            blockedReason(item) !== null || removing !== null
                          }
                          aria-busy={removing === item.key}
                          onClick={() => setConfirming(item)}
                          className="text-muted-foreground"
                        >
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {items.length === 0
                ? t('downloads:empty')
                : t('downloads:noMatch')}
            </p>
          )}
        </div>
      </div>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && removing === null) setConfirming(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="break-words">
              {confirming &&
                t('downloads:confirm.title', {
                  name: removalName(confirming),
                })}
            </DialogTitle>
            <DialogDescription>
              {t('downloads:confirm.description')}
            </DialogDescription>
          </DialogHeader>
          {managedNote && (
            <p className="text-sm text-muted-foreground">
              {t('providers:deleteModel.managedShared', {
                engines: managedEngines()
                  .map((engine) => engine.label)
                  .join(', '),
              })}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={removing !== null}
              onClick={() => setConfirming(null)}
            >
              {t('downloads:confirm.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removing !== null}
              aria-busy={removing !== null}
              onClick={() => confirming && void confirmRemove(confirming)}
            >
              {t('downloads:confirm.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
