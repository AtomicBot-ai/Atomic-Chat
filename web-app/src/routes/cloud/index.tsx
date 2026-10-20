import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { IconRefresh } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import { CloudConnectionCard } from '@/containers/cloud/CloudConnectionCard'
import { CloudMediaModelsCard } from '@/containers/cloud/CloudMediaModelsCard'
import { CloudModelsCard } from '@/containers/cloud/CloudModelsCard'
import { CloudProviderBrowser } from '@/containers/cloud/CloudProviderBrowser'
import { CloudSetupWizard } from '@/containers/cloud/CloudSetupWizard'
import { CloudSubscriptionCard } from '@/containers/cloud/CloudSubscriptionCard'
import { useChatGptAuth } from '@/hooks/useChatGptAuth'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  groupCloudProviders,
  isCloudProvider,
  isProviderConnected,
  isSelfHostedGroup,
  isSubscriptionProvider,
} from '@/lib/cloud-providers'
import { refreshProviderModels } from '@/lib/refresh-provider-models'
import { cn } from '@/lib/utils'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { isKnownProvider, useProviderRegistryStore } from '@/stores/provider-registry-store'

type CloudSearch = {
  provider?: string
  /**
   * The old Custom Endpoint link (`?add=custom`). Custom endpoints have their
   * own page now; the param is kept only to forward such links there.
   */
  add?: 'custom'
}

/** A provider of the user's own: Ollama, a `llama-server`, a custom endpoint. */
const isSelfHosted = (provider: ProviderObject | undefined) =>
  provider !== undefined && isCloudProvider(provider) && isSelfHostedGroup(provider)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.cloud.index as any)({
  component: CloudPage,
  validateSearch: (search: Record<string, unknown>): CloudSearch => {
    // Absent must stay absent — `String(undefined)` would put the literal
    // "undefined" in the URL and then fail to match any provider.
    const provider = search?.provider
    return {
      ...(typeof provider === 'string' && provider.length > 0
        ? { provider }
        : {}),
      ...(search?.add === 'custom' ? { add: 'custom' as const } : {}),
    }
  },
  /**
   * Self-hosted servers moved to Custom Endpoint. Links that still point here
   * — `?add=custom`, and `?provider=` for one of them, which is where the
   * `/settings/providers/$providerName` redirect and the model picker's gear
   * send it — land on that page instead.
   */
  beforeLoad: ({ search }: { search: CloudSearch }) => {
    if (search.add === 'custom') throw redirect({ to: route.endpoints.index })
    if (search.provider) {
      const provider = useModelProvider
        .getState()
        .getProviderByName(search.provider)
      if (isSelfHosted(provider)) {
        throw redirect({
          to: route.endpoints.index,
          search: { provider: search.provider },
        })
      }
    }
  },
})

/**
 * Cloud — connect the model providers that run on somebody else's hardware.
 *
 * The selected provider lives in the URL rather than in component state so the
 * page is linkable: the redirect from `/settings/providers/$providerName`, the
 * gear in the model picker and any future onboarding link all land on the right
 * connection.
 */
/// Opened by default when no provider is connected and the URL names none.
const DEFAULT_CLOUD_PROVIDER = 'openrouter'

export function CloudPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const search = useSearch({ from: Route.id }) as CloudSearch
  const { providers, updateProvider, setProviders } = useModelProvider()

  const subscription = useChatGptAuth('settings')

  const [refreshing, setRefreshing] = useState(false)
  /** The model a search result was picked for, named above the connection. */
  const [selectedModelName, setSelectedModelName] = useState<string>()

  // The provider catalog is a cloud concern, so its refresh moved here from
  // Settings along with the providers it describes.
  const registryLoading = useProviderRegistryStore(
    (s) => s.status === 'loading'
  )
  const registryFetchedAt = useProviderRegistryStore((s) => s.fetchedAt)
  const registryReady = useProviderRegistryStore((s) => s.hasInitialized)
  const refreshRegistry = useProviderRegistryStore((s) => s.refresh)

  // Which providers count as the user's own depends on the registry (a
  // provider it does not ship is one the user added), hence the dependency.
  const groups = useMemo(
    () => groupCloudProviders(providers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, registryReady]
  )
  const hostedProviders = groups.hosted

  // The first-visit guide. It is not offered to someone who already has a
  // hosted provider connected — through onboarding's own cloud dialog, say —
  // and once finished or skipped it opens only from "Guide me".
  const cloudGuideDone = useGeneralSetting((s) => s.cloudGuideDone)
  const markCloudGuideDone = useGeneralSetting((s) => s.markCloudGuideDone)
  const [guideOpen, setGuideOpen] = useState(
    () => !cloudGuideDone && !hostedProviders.some(isProviderConnected)
  )
  const finishGuide = useCallback(() => {
    markCloudGuideDone()
    setGuideOpen(false)
  }, [markCloudGuideDone])

  const selected = useMemo(() => {
    if (search.provider) {
      return hostedProviders.find((p) => p.provider === search.provider)
    }
    // No explicit selection: open on something the user already set up, so the
    // page is useful on arrival rather than an empty picker. With nothing
    // connected yet, land on OpenRouter — one key there unlocks most of the
    // catalog — and failing that on whatever comes first, so the page never
    // opens blank.
    return (
      hostedProviders.find(isProviderConnected) ??
      hostedProviders.find((p) => p.provider === DEFAULT_CLOUD_PROVIDER) ??
      hostedProviders[0]
    )
  }, [hostedProviders, search.provider])

  const selectProvider = useCallback(
    (providerName: string) => {
      navigate({
        to: route.cloud.index,
        search: { provider: providerName },
        replace: true,
      })
    },
    [navigate]
  )

  // The core's media catalog: which providers make images or video, and with which models.
  const mediaAvailable = useMediaCatalog((state) => state.available)
  useEffect(() => {
    void useMediaCatalog.getState().load()
  }, [])

  const clearSelection = useCallback(() => {
    navigate({ to: route.cloud.index, search: {}, replace: true })
  }, [navigate])

  // Canonicalise the implicit “first connected provider” choice into the URL.
  // Otherwise disconnecting it changes `isProviderConnected`, recomputes the
  // fallback and unexpectedly jumps the page to OpenRouter.
  useEffect(() => {
    if (!search.provider && selected) selectProvider(selected.provider)
  }, [search.provider, selectProvider, selected])

  // `beforeLoad` forwards a self-hosted provider, but a provider the user
  // added is only known as theirs once the registry has loaded.
  useEffect(() => {
    if (
      search.provider &&
      groups.selfHosted.some((p) => p.provider === search.provider)
    ) {
      navigate({
        to: route.endpoints.index,
        search: { provider: search.provider },
        replace: true,
      })
    }
  }, [groups.selfHosted, navigate, search.provider])

  const handleRefreshCatalog = useCallback(async () => {
    const errorMessage = t('providers:registry.errorDescription')
    try {
      await refreshRegistry({ force: true })
    } catch (err) {
      // Defensive — `refresh` is implemented never to throw.
      console.warn('[cloud] catalog refresh threw unexpectedly:', err)
      toast.error(errorMessage)
      return
    }

    if (useProviderRegistryStore.getState().error) {
      toast.error(errorMessage)
      return
    }
    toast.success(t('providers:registry.successDescription'))

    // Re-pull through the service so newly added catalog entries and models
    // reach the visible list. Off the await chain so the toast is immediate.
    void (async () => {
      try {
        setProviders(await serviceHub.providers().getProviders())
      } catch (err) {
        console.warn('[cloud] failed to apply refreshed catalog:', err)
      }
    })()
  }, [refreshRegistry, serviceHub, setProviders, t])

  const handleRefreshModels = useCallback(async () => {
    if (!selected) return
    setRefreshing(true)
    try {
      await refreshProviderModels({
        provider: selected,
        serviceHub,
        setProviders,
        updateProvider,
        t,
      })
    } finally {
      setRefreshing(false)
    }
  }, [selected, serviceHub, setProviders, updateProvider, t])

  const connectionForm = (
    <>
      <CloudConnectionCard
        hideProviderSelect
        providers={providers}
        selected={selected}
        onSelect={selectProvider}
        onDeleted={clearSelection}
        updateProvider={updateProvider}
        serviceHub={serviceHub}
      />

      {isSubscriptionProvider(selected?.provider) && (
        <CloudSubscriptionCard
          state={subscription.state}
          account={subscription.account}
          error={subscription.error}
          modelCount={subscription.modelCount}
          onConnectBrowser={() => void subscription.connect()}
          onCancel={() => void subscription.cancel()}
          onDisconnect={() => void subscription.disconnect()}
          surface="settings"
        />
      )}
    </>
  )

  const selectedConnected = selected ? isProviderConnected(selected) : false

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div
          className={cn(
            'flex items-center justify-between w-full mr-2 pr-3',
            !IS_MACOS && 'pr-30'
          )}
        >
          <span className="font-medium text-base font-studio">
            {t('cloud:title')}
          </span>
          <div className="relative z-50 flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGuideOpen(true)}
            >
              {t('cloud:guide.open')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshCatalog}
              disabled={registryLoading}
              title={
                registryFetchedAt
                  ? t('providers:registry.lastUpdated', {
                      when: new Date(registryFetchedAt).toLocaleString(),
                    })
                  : t('providers:registry.neverUpdated')
              }
            >
              <IconRefresh
                size={16}
                className={cn(registryLoading && 'animate-spin')}
              />
              <span>
                {registryLoading
                  ? t('providers:registry.refreshing')
                  : t('providers:registry.refresh')}
              </span>
            </Button>
          </div>
        </div>
      </HeaderPage>
      {guideOpen ? (
        <CloudSetupWizard
          providers={hostedProviders}
          selected={selected}
          onSelect={selectProvider}
          onFinish={finishGuide}
        >
          {connectionForm}
        </CloudSetupWizard>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(230px,290px)_minmax(0,1fr)]">
          <CloudProviderBrowser
            providers={hostedProviders}
            selected={selected?.provider}
            onSelect={(provider, model) => {
              setSelectedModelName(model)
              selectProvider(provider)
            }}
          />
          {/* Classic (non-overlay) scrollbars — macOS with a mouse connected or
              "Show scroll bars: Always", Windows, Linux — take layout width, so
              a provider whose model list scrolls and one whose list does not
              gave the centred column two different widths: every switch between
              them nudged the whole block sideways. Reserving the gutter keeps
              the geometry constant; same rule the onboarding picker applies. */}
          <section
            aria-label={t('cloud:configurationLabel')}
            className="min-w-0 overflow-y-auto p-4 pt-0 [scrollbar-gutter:stable]"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {selectedModelName && selected && (
                <div
                  role="status"
                  className="rounded-lg border border-border bg-secondary/30 px-4 py-3"
                >
                  <p className="truncate text-sm font-medium">
                    {selectedModelName}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selectedConnected
                      ? t('cloud:browser.modelReady')
                      : t('cloud:browser.modelConnect')}
                  </p>
                </div>
              )}

              {connectionForm}

              {selected && !selected.media_only && (
                <CloudModelsCard
                  provider={selected}
                  refreshing={refreshing}
                  onRefresh={handleRefreshModels}
                />
              )}

              {selected && mediaAvailable && !isSubscriptionProvider(selected.provider) && (
                <CloudMediaModelsCard
                  provider={selected}
                  custom={!isKnownProvider(selected.provider)}
                  onChange={(media) => updateProvider(selected.provider, { media })}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
