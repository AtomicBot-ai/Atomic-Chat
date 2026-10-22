import { useMemo, useState } from 'react'
import { ChevronRight, CircleCheck, Search, TriangleAlert } from 'lucide-react'

import { Input } from '@/components/ui/input'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  buildCloudModelCatalog,
  listedModels,
  searchCloudModels,
  searchCloudProviders,
} from '@/lib/cloud-model-catalog'
import { isProviderConnected } from '@/lib/cloud-providers'
import { isMediaConnected } from '@/lib/media-models'
import { cn, getProviderTitle } from '@/lib/utils'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'

/** Model matches rendered at once; the rest wait for a narrower search. */
const MODEL_RESULTS_LIMIT = 50

type CloudProviderBrowserProps = {
  /** Hosted providers only: the user's own servers live on Custom Endpoint. */
  providers: ProviderObject[]
  selected?: string
  onSelect: (provider: string, model?: string) => void
}

/**
 * The Cloud page's left pane: every hosted provider, and a search that also
 * finds a model across them ("Available through N providers").
 *
 * Counts and status are the provider's own: its model list as the registry
 * and the last reload left it, and the same state the connection card shows:
 * connected, or a saved key that is unverified or was rejected
 * (`provider-key-status-store`).
 */
export function CloudProviderBrowser({
  providers,
  selected,
  onSelect,
}: CloudProviderBrowserProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const needle = query.trim()
  const keyStatuses = useProviderKeyStatusStore((state) => state.statuses)

  const catalog = useMemo(() => buildCloudModelCatalog(providers), [providers])
  const models = useMemo(
    () => searchCloudModels(catalog, needle),
    [catalog, needle]
  )
  const visibleProviders = useMemo(
    () => searchCloudProviders(providers, needle),
    [providers, needle]
  )
  const byName = useMemo(
    () => new Map(providers.map((p) => [p.provider, p])),
    [providers]
  )

  const countLabel = (count: number) =>
    count === 0
      ? t('cloud:models.countNone')
      : count === 1
        ? t('cloud:models.countOne')
        : t('cloud:models.count', { count })

  const providerRow = (provider: ProviderObject, model?: string) => {
    const title = getProviderTitle(provider.provider)
    const configured =
      isProviderConnected(provider) || isMediaConnected(provider)
    // A key the provider refused, or one it could not be asked about, is
    // listed as such rather than as connected.
    const keyState = configured
      ? keyStatusFor(provider, keyStatuses)?.state
      : undefined
    const connected = configured && !keyState
    return (
      <button
        type="button"
        key={provider.provider}
        aria-label={
          model
            ? t('cloud:browser.configureFor', { provider: title, model })
            : t('cloud:browser.configure', { provider: title })
        }
        aria-pressed={selected === provider.provider}
        onClick={() => onSelect(provider.provider, model)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left transition-colors hover:bg-secondary',
          selected === provider.provider && 'bg-secondary'
        )}
      >
        <ProvidersAvatar provider={provider} className="size-6 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {countLabel(listedModels(provider).length)}
            {connected && ` · ${t('cloud:connection.connected')}`}
            {keyState === 'rejected' && ` · ${t('cloud:connection.rejected')}`}
            {keyState === 'unverified' &&
              ` · ${t('cloud:connection.unverified')}`}
          </span>
        </span>
        {connected && (
          <CircleCheck
            size={14}
            className="shrink-0 text-emerald-500"
            aria-hidden
          />
        )}
        {keyState && (
          <TriangleAlert
            size={14}
            className={cn(
              'shrink-0',
              keyState === 'rejected' ? 'text-destructive' : 'text-amber-500'
            )}
            aria-hidden
          />
        )}
        <ChevronRight
          size={14}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
      </button>
    )
  }

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col border-r border-border"
      aria-label={t('cloud:browser.label')}
    >
      <div className="p-3 pb-2">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('cloud:browser.searchLabel')}
            placeholder={t('cloud:browser.searchPlaceholder')}
            className="pl-9"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {models.length > 0 && (
          <>
            <h2 className="px-3 py-2 text-xs font-medium text-muted-foreground">
              {t('cloud:browser.models', { count: models.length })}
            </h2>
            {models.slice(0, MODEL_RESULTS_LIMIT).map((model) => (
              <div
                key={model.key}
                className="mb-3 rounded-xl border border-border p-1"
              >
                <div className="min-w-0 px-3 py-2">
                  <h3
                    className="truncate text-sm font-medium"
                    title={model.name}
                  >
                    {model.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {model.providers.length === 1
                      ? t('cloud:browser.availableThroughOne')
                      : t('cloud:browser.availableThrough', {
                          count: model.providers.length,
                        })}
                  </p>
                </div>
                {model.providers.map((id) => {
                  const provider = byName.get(id)
                  return provider ? providerRow(provider, model.name) : null
                })}
              </div>
            ))}
            {models.length > MODEL_RESULTS_LIMIT && (
              <p className="px-3 pb-3 text-xs text-muted-foreground">
                {t('cloud:browser.moreModels', {
                  shown: MODEL_RESULTS_LIMIT,
                  count: models.length,
                })}
              </p>
            )}
          </>
        )}
        {visibleProviders.length > 0 && (
          <>
            <h2 className="px-3 py-2 text-xs font-medium text-muted-foreground">
              {t('cloud:browser.providers', {
                count: visibleProviders.length,
              })}
            </h2>
            {visibleProviders.map((provider) => providerRow(provider))}
          </>
        )}
        {visibleProviders.length === 0 && models.length === 0 && (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            {t('cloud:browser.noResults')}
          </p>
        )}
      </div>
    </aside>
  )
}
