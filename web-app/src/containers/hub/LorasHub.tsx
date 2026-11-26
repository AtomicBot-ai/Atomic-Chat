import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/downloadFormat'
import {
  loras,
  loraError,
  useLoraInventoryVersion,
  type Lora,
  type LoraInventory,
} from '@/services/loras'
import { HubSearchToolbar } from './HubSearchToolbar'
export function LorasHub({
  tabs,
  target,
  source,
  q = '',
  onQuery,
  onClear,
}: {
  tabs?: ReactNode
  source?: string
  target?: string
  q?: string
  onQuery?: (q: string) => void
  onClear?: () => void
}) {
  const { t } = useTranslation()
  const [inventory, setInventory] = useState<LoraInventory>({
    files: [],
    downloads: [],
  })
  const [resolved, setResolved] = useState<{ source: string; target: string }>()
  const modelFilter =
    target ??
    (resolved?.source === source ? resolved?.target : undefined) ??
    source
  const [results, setResults] = useState<Lora[]>([])
  const [searching, setSearching] = useState(false)
  const [partial, setPartial] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [inventoryError, setInventoryError] = useState('')
  const [actionError, setActionError] = useState('')
  const [attempt, retry] = useState(0)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const version = useLoraInventoryVersion((s) => s.version)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const v = await loras.list()
        if (active) {
          setInventory(v)
          setInventoryError('')
        }
      } catch (e) {
        if (active) setInventoryError(loraError(e))
      }
      if (active) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [version, attempt])
  useEffect(() => {
    let active = true
    setSearching(true)
    setPartial(false)
    setSearchError('')
    setResults([])
    const timer = setTimeout(async () => {
      try {
        const local = await loras.search(q, target, false, source)
        if (!active) return
        if (source && local.target)
          setResolved({ source, target: local.target })
        setResults(local.results)
        const live = await loras.search(q, target, true, source)
        if (active) {
          if (source && live.target)
            setResolved({ source, target: live.target })
          setResults(live.results)
          setPartial(live.partial)
        }
      } catch (e) {
        if (active) setSearchError(loraError(e))
      } finally {
        if (active) setSearching(false)
      }
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [q, source, target, attempt])
  async function act(id: string, operation: 'install' | 'cancel' | 'remove') {
    setActionError('')
    setPending((p) => ({ ...p, [id]: true }))
    try {
      await loras[operation](id)
    } catch (e) {
      setActionError(loraError(e))
    } finally {
      setPending((p) => ({ ...p, [id]: false }))
    }
  }
  const rows = results
  const error = actionError || inventoryError || searchError
  const content = (
    <>
      {modelFilter && (
        <Button
          size="sm"
          variant="outline"
          className="max-w-full"
          aria-label={t('hub:drafters.clear')}
          onClick={onClear}
        >
          <span className="truncate" title={modelFilter}>
            {t('hub:drafters.for', { model: modelFilter })}
          </span>{' '}
          ×
        </Button>
      )}
      {(error || partial) && (
        <p role="status" className="break-words text-sm">
          {error || t('hub:drafters.offline')}{' '}
          <Button size="sm" variant="link" onClick={() => retry((n) => n + 1)}>
            {t('hub:drafters.retry')}
          </Button>
        </p>
      )}
      {!!rows.length && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((row) => {
            const installed = inventory.files.some(
              (f) => f.sha256 === row.sha256
            )
            const job = inventory.downloads.find(
              (d) => d.taskId === 'lora:' + row.sha256
            )
            const action = job ? 'cancel' : installed ? 'remove' : 'install'
            return (
              <li
                key={row.sha256}
                className="flex flex-wrap items-center gap-3 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm font-medium"
                    title={row.repo}
                  >
                    {row.repo}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={row.file}
                  >
                    {row.file}
                  </div>
                  <div className="break-words text-xs text-muted-foreground">
                    {t('hub:loras.' + row.mode)} ·{' '}
                    {t('hub:drafters.for', { model: row.target })} ·{' '}
                    {formatBytes(row.size)}
                  </div>
                </div>
                {job && (
                  <span className="text-xs tabular-nums">
                    {Math.round(job.percent)}%
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending[row.sha256] && !job}
                  onClick={() => void act(row.sha256, action)}
                >
                  {t(
                    job
                      ? 'hub:drafters.cancel'
                      : installed
                        ? 'hub:drafters.remove'
                        : 'hub:drafters.download'
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {!rows.length && !searching && !error && (
        <p className="py-8 text-center text-sm">{t('hub:loras.empty')}</p>
      )}
    </>
  )
  return (
    <div className="flex h-full min-w-0 flex-col">
      <HubSearchToolbar
        value={q}
        onChange={(v) => onQuery?.(v)}
        placeholder={t('hub:loras.search')}
        modelType={tabs}
        showImport={false}
        busy={searching}
      />
      <div className="min-w-0 space-y-3 overflow-y-auto p-4">{content}</div>
    </div>
  )
}
