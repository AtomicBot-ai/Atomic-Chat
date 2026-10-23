import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Clapperboard,
  Copy,
  Cpu,
  FileClock,
  HardDrive,
  Image,
  Mic,
  PieChart,
  Pause,
  Play,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'

import { OverflowText } from '@/components/OverflowText'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import HeaderPage from '@/containers/HeaderPage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useInstalledInventory } from '@/hooks/useInstalledInventory'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { copyToClipboard } from '@/lib/clipboard'
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

/**
 * The name a confirmation and its toasts use: a build is named with its
 * version, a model with its quant and, in brackets, its owner, so one model
 * and quant from two owners are two names.
 */
const removalName = (item: InventoryItem): string =>
  item.kind === 'engine'
    ? [item.name, ...item.details].join(' ')
    : [item.name, item.quant, item.owner && `(${item.owner})`]
        .filter(Boolean)
        .join(' ')

/**
 * The full id behind a model row's readable name, for whoever needs the
 * exact file: shown on hover and on keyboard focus, copied on click. It stays
 * out of sight until the row is hovered or something in it has focus; its
 * slot is kept either way, so the row never moves.
 */
function ModelIdCopy({ id }: { id: string }) {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('downloads:copyId', { name: id })}
          onClick={async () => {
            if (await copyToClipboard(id))
              toast.success(t('downloads:idCopied'))
          }}
          className="size-5 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          <Copy className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(32rem,calc(100vw-2rem))] break-all">
        {id}
      </TooltipContent>
    </Tooltip>
  )
}

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
  const { items, totalBytes, remove, cancel, pause, resume } =
    useInstalledInventory()
  const resumeParams = useDownloadStore((state) => state.resumeParams)
  const downloads = useDownloadStore((state) => state.downloads)
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

  // Most telling first, since the line's ellipsis cuts from the end: the
  // engine and the quant, what the item is and why it stays, then the owner,
  // which the full id on hover and in the confirmation also gives.
  const detailLine = useCallback(
    (item: InventoryItem) =>
      [
        ...item.details,
        item.quant,
        kindLabel(item.kind),
        blockedReason(item),
        item.owner,
      ]
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
          `${item.name} ${detailLine(item)} ${item.modelId ?? ''}`
            .toLowerCase()
            .includes(needle))
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
                <th className="w-[6.5rem] p-3">
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
                    className="group border-t border-border hover:bg-secondary/20"
                  >
                    <td className="p-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                          <Icon size={17} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1">
                            <OverflowText
                              className="flex-1 font-medium"
                              text={item.name}
                              title={item.modelId ?? item.name}
                            />
                            {item.modelId && <ModelIdCopy id={item.modelId} />}
                          </div>
                          {detail && (
                            <OverflowText
                              className="mt-0.5 text-xs text-muted-foreground"
                              text={detail}
                            />
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap tabular-nums">
                      {item.download ? (
                        <div className="min-w-0">
                          <OverflowText
                            text={downloadStatusLabel(t, item.download)}
                          />
                          {item.download.total > 0 && (
                            <OverflowText
                              className="mt-0.5 text-xs text-muted-foreground"
                              text={formatProgressPair(
                                item.download.current,
                                item.download.total
                              )}
                            />
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
                    <td className="p-3 text-right whitespace-nowrap">
                      {/* A paused download, also one a quit cut off and the
                          relaunch brought back, picks up from its bytes. */}
                      {item.download ? (
                        <div className="flex items-center justify-end gap-1">
                          {(resumeParams[item.download.id] ||
                            item.download.id.startsWith('diffusion-model-')) &&
                            !downloads[item.download.id]?.recoveryBlocked && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t(
                                  item.download.paused
                                    ? 'common:resumeDownload'
                                    : 'common:pauseDownload'
                                )}
                                title={t(
                                  item.download.paused
                                    ? 'common:resumeDownload'
                                    : 'common:pauseDownload'
                                )}
                                onClick={() =>
                                  item.download?.paused
                                    ? resume(item)
                                    : pause(item)
                                }
                              >
                                {item.download.paused ? (
                                  <Play size={15} />
                                ) : (
                                  <Pause size={15} />
                                )}
                              </Button>
                            )}
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
                        </div>
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
            <DialogTitle className="wrap-anywhere">
              {confirming &&
                t('downloads:confirm.title', {
                  name: removalName(confirming),
                })}
            </DialogTitle>
            <DialogDescription>
              {t('downloads:confirm.description')}
              {/* The exact file, for a model whose name and quant another
                  owner's copy may share. */}
              {confirming?.modelId && (
                <span className="mt-1 block font-mono text-xs wrap-anywhere">
                  {confirming.modelId}
                </span>
              )}
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
