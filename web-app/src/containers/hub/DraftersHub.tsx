import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useChatSessions } from '@/stores/chat-session-store'
import { switchToModel } from '@/utils/switchModel'
import {
  drafterModelRepo,
  useInstalledDrafterModels,
} from './installedDrafterModel'
import { HuggingFaceRepoLink } from './HuggingFaceRepoLink'
import { HubSearchToolbar } from './HubSearchToolbar'
import { Button } from '@/components/ui/button'
import {
  drafters,
  drafterError,
  type Drafter,
  type DrafterInventory,
  type DrafterSearch,
} from '@/services/drafters'

function useInventory() {
  const [value, setValue] = useState<DrafterInventory>({
    files: [],
    downloads: [],
  })
  const [error, setError] = useState('')
  const [version, refresh] = useState(0)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let interval = 1500
    const poll = async () => {
      try {
        const next = await drafters.list()
        if (active) {
          interval = next.downloads.length ? 800 : 5000
          setValue(next)
          setError('')
        }
      } catch (e) {
        if (active) setError(drafterError(e))
      }
      if (active) timer = setTimeout(poll, interval)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [version])
  return { value, error, refresh: () => refresh((n) => n + 1) }
}
const size = (bytes: number) =>
  bytes >= 1e9
    ? (bytes / 1e9).toFixed(1) + ' GB'
    : Math.round(bytes / 1e6) + ' MB'

function DrafterRows({
  rows,
  inventory,
  refresh,
  source,
}: {
  rows: Drafter[]
  inventory: DrafterInventory
  refresh: () => void
  source?: string
}) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const installedModels = useInstalledDrafterModels(inventory.files.length > 0)
  const selectedId = useModelProvider((state) =>
    state.selectedProvider === 'llamacpp-upstream'
      ? state.selectedModel?.id
      : undefined
  )
  const generating = useChatSessions(
    (s) =>
      Object.values(s.requestActive).some(Boolean) ||
      Object.values(s.sessions).some((v) => v.isStreaming)
  )
  const [starting, setStarting] = useState<string>()
  const installedIds = new Set(inventory.files.map((file) => file.sha256))
  const [pending, setPending] = useState<Set<string>>(new Set())
  const action = async (id: string, operation: () => Promise<unknown>) => {
    setError('')
    setPending((ids) => new Set(ids).add(id))
    try {
      await operation()
    } catch (e) {
      setError(drafterError(e))
    } finally {
      setPending((ids) => {
        const next = new Set(ids)
        next.delete(id)
        return next
      })
      refresh()
    }
  }
  const newChat = async (modelId: string, drafterId: string) => {
    setStarting(drafterId)
    try {
      const previous = await drafters.selection(modelId)
      await drafters.select(modelId, drafterId)
      const provider = 'llamacpp-upstream'
      try {
        await switchToModel({
          modelId,
          providerName: provider,
          updateCurrentThread: false,
          serviceHub: getServiceHub(),
        })
      } catch (error) {
        if (previous !== drafterId) await drafters.select(modelId, previous)
        throw error
      }
      if (mounted.current)
        await navigate({
          to: route.home,
          search: { threadModel: { id: modelId, provider } },
        })
    } finally {
      setStarting(undefined)
    }
  }
  return (
    <>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => {
          const id = row.sha256
          const installed = installedIds.has(id)
          const matches =
            installedModels.matches?.get(row.target.toLowerCase()) ?? []
          const modelId =
            selectedId && matches.includes(selectedId) ? selectedId : matches[0]
          const progress = inventory.downloads.find(
            (d) => d.taskId === 'dspark:' + id
          )
          return (
            <li key={id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-[1_1_12rem]">
                <div className="truncate text-sm font-medium" title={row.file}>
                  {row.file}
                </div>
                <div className="break-words text-xs text-muted-foreground">
                  {t('hub:drafters.for', { model: row.target })} ·{' '}
                  {row.repo.split('/')[0]} · {row.quant} · {size(row.size)}
                </div>
              </div>
              <HuggingFaceRepoLink repo={row.repo} />
              {progress ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void action(id, () => drafters.cancel(id))}
                >
                  {Math.round(progress.percent)}% · {t('hub:drafters.cancel')}
                </Button>
              ) : installed ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!!starting || pending.has(id)}
                    onClick={() => void action(id, () => drafters.remove(id))}
                  >
                    {t('hub:drafters.remove')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      installedModels.loading ||
                      !!starting ||
                      (Boolean(modelId) && generating) ||
                      pending.has(id)
                    }
                    onClick={() => {
                      if (modelId) void action(id, () => newChat(modelId, id))
                      else {
                        const repo = drafterModelRepo(row.target, source)
                        void navigate({
                          to: route.hub.index,
                          search: { model: repo, repo, engine: 'gguf' },
                        })
                      }
                    }}
                  >
                    {starting === id || installedModels.loading
                      ? t('common:loading')
                      : modelId
                        ? t('hub:newChat')
                        : t('hub:drafters.viewModel')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending.has(id)}
                  onClick={() => void action(id, () => drafters.install(id))}
                >
                  {t('hub:drafters.download')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function InstalledDrafters() {
  const { t } = useTranslation()
  const inventory = useInventory()
  if (!inventory.value.files.length) return null
  return (
    <section className="my-4 space-y-2">
      <h2 className="font-medium">{t('hub:drafters.title')}</h2>
      <DrafterRows
        rows={inventory.value.files}
        inventory={inventory.value}
        refresh={inventory.refresh}
      />
    </section>
  )
}

export function DraftersHub({
  tabs,
  source,
  target,
  q,
  onQuery,
  onClear,
  onTarget,
}: {
  tabs: ReactNode
  source?: string
  target?: string
  q: string
  onQuery: (query: string) => void
  onClear: () => void
  onTarget?: (checkpoint: string) => void
}) {
  const { t } = useTranslation()
  const inv = useInventory()
  const [result, setResult] = useState<DrafterSearch>({
    results: [],
    partial: false,
  })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const searchKey = JSON.stringify([source, target, q])
  const [cursor, setCursor] = useState({ key: '', page: 0 })
  const [nextPage, setNextPage] = useState(0)
  const startPage = cursor.key === searchKey ? cursor.page : 0
  const [attempt, retry] = useState(0)
  const modelScoped = Boolean(source || target)
  const canonicalSearch = useRef<string | undefined>(undefined)
  useEffect(() => {
    // Writing the resolved checkpoint into the route completes this same search.
    const requestKey = JSON.stringify([source, target, q, attempt, startPage])
    const alreadyShown = canonicalSearch.current === requestKey
    canonicalSearch.current = undefined
    if (alreadyShown) return
    let active = true
    let progress: ReturnType<typeof setTimeout> | undefined
    let livePending = true
    const showAvailable = async () => {
      if (!active || !livePending) return
      try {
        const available = await drafters.search(source, target, q, false)
        if (active && livePending)
          setResult((prev) => ({
            ...prev,
            results: available.results,
            target: available.target,
          }))
      } catch {
        /* The live request reports transport errors. */
      }
      if (active && livePending) progress = setTimeout(showAvailable, 2000)
    }
    setBusy(true)
    setError('')
    const timer = setTimeout(async () => {
      try {
        const cached = await drafters.search(source, target, q, false)
        if (!active) return
        setResult(cached)
        progress = setTimeout(showAvailable, 2000)
        let current = startPage
        let partial = false
        const initialCount = startPage
          ? new Set(cached.results.map((d) => d.repo + '@' + d.target)).size
          : 0
        while (active) {
          const live = await drafters.search(source, target, q, true, current)
          if (!active) return
          partial ||= live.partial
          setResult({ ...live, partial })
          current++
          const count = new Set(
            live.results.map((d) => d.repo + '@' + d.target)
          ).size
          // Sparse HF pages may contain mostly base models or legacy-format heads.
          // Fill a screen before asking the user to page through more results.
          setNextPage(current)
          if (
            !live.hasMore ||
            (!modelScoped &&
              (count >= initialCount + 12 ||
                current - startPage >= 4 ||
                (live.partial && !live.results.length)))
          ) {
            if (
              onTarget &&
              source &&
              !target &&
              live.target &&
              (!live.partial || live.target !== source)
            ) {
              canonicalSearch.current = JSON.stringify([
                source,
                live.target,
                q,
                attempt,
                0,
              ])
              onTarget(live.target)
            }
            break
          }
        }
      } catch (e) {
        if (active) setError(drafterError(e))
      } finally {
        livePending = false
        clearTimeout(progress)
        if (active) setBusy(false)
      }
    }, 180)
    return () => {
      active = false
      clearTimeout(timer)
      clearTimeout(progress)
    }
  }, [source, target, q, attempt, startPage, onTarget, modelScoped])
  const label = (result.target ?? target ?? source)?.split('/').pop()
  return (
    <div className="flex h-full min-w-0 flex-col">
      <HubSearchToolbar
        value={q}
        onChange={(value) => {
          onQuery(value)
        }}
        placeholder={t('hub:drafters.search')}
        busy={busy}
        modelType={tabs}
        showImport={false}
      />
      <div className="min-w-0 space-y-3 overflow-y-auto p-4">
        {label && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onClear()
            }}
            aria-label={t('hub:drafters.clear')}
          >
            {t('hub:drafters.for', { model: label })} ×
          </Button>
        )}
        {(error || result.partial || inv.error) && (
          <div role="status" className="text-sm">
            {error || inv.error || t('hub:drafters.offline')}{' '}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => retry((n) => n + 1)}
            >
              {t('hub:drafters.retry')}
            </Button>
          </div>
        )}
        {result.results.length > 0 ? (
          <DrafterRows
            rows={result.results}
            source={source}
            inventory={inv.value}
            refresh={inv.refresh}
          />
        ) : (
          !busy && (
            <div className="py-8 text-center text-sm">
              <p>
                {label
                  ? t('hub:drafters.emptyFor', { model: label })
                  : t('hub:drafters.empty')}
              </p>
              {label && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    onClear()
                  }}
                >
                  {t('hub:drafters.browse')}
                </Button>
              )}
            </div>
          )
        )}
        {!modelScoped && result.hasMore && !busy && (
          <Button
            variant="outline"
            onClick={() => setCursor({ key: searchKey, page: nextPage })}
          >
            {t('hub:drafters.more')}
          </Button>
        )}
      </div>
    </div>
  )
}
