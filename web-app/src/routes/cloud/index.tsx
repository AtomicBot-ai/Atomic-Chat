import { useCallback, useMemo, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { IconRefresh } from '@tabler/icons-react'
import cloneDeep from 'lodash/cloneDeep'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { openAIProviderSettings } from '@/constants/providers'
import HeaderPage from '@/containers/HeaderPage'
import { CloudConnectionCard } from '@/containers/cloud/CloudConnectionCard'
import { CloudModelsCard } from '@/containers/cloud/CloudModelsCard'
import { CloudSubscriptionCard } from '@/containers/cloud/CloudSubscriptionCard'
import { AddProviderDialog } from '@/containers/dialogs'
import { useChatGptAuth } from '@/hooks/useChatGptAuth'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isCloudProvider,
  isProviderConnected,
  isSubscriptionProvider,
} from '@/lib/cloud-providers'
import { refreshProviderModels } from '@/lib/refresh-provider-models'
import { cn } from '@/lib/utils'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.cloud.index as any)({
  component: CloudPage,
  validateSearch: (search: Record<string, unknown>): { provider?: string } => {
    // Absent must stay absent — `String(undefined)` would put the literal
    // "undefined" in the URL and then fail to match any provider.
    const provider = search?.provider
    return typeof provider === 'string' && provider.length > 0
      ? { provider }
      : {}
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
export function CloudPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const search = useSearch({ from: Route.id }) as { provider?: string }
  const { providers, addProvider, updateProvider, setProviders } =
    useModelProvider()

  const subscription = useChatGptAuth()

  const [customOpen, setCustomOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // The provider catalog is a cloud concern, so its refresh moved here from
  // Settings along with the providers it describes.
  const registryLoading = useProviderRegistryStore((s) => s.status === 'loading')
  const registryFetchedAt = useProviderRegistryStore((s) => s.fetchedAt)
  const refreshRegistry = useProviderRegistryStore((s) => s.refresh)

  const cloudProviders = useMemo(
    () => providers.filter(isCloudProvider),
    [providers]
  )

  const selected = useMemo(() => {
    if (search.provider) {
      return cloudProviders.find((p) => p.provider === search.provider)
    }
    // No explicit selection: open on something the user already set up, so the
    // page is useful on arrival rather than an empty picker.
    return cloudProviders.find(isProviderConnected)
  }, [cloudProviders, search.provider])

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

  const clearSelection = useCallback(() => {
    navigate({ to: route.cloud.index, search: {}, replace: true })
  }, [navigate])

  const createProvider = useCallback(
    (name: string) => {
      if (
        providers.some((p) => p.provider.toLowerCase() === name.toLowerCase())
      ) {
        toast.error(t('common:providerAlreadyExists', { name }))
        return
      }
      addProvider({
        provider: name,
        active: true,
        models: [],
        settings: cloneDeep(openAIProviderSettings) as ProviderSetting[],
        api_key: '',
        base_url: 'https://api.openai.com/v1',
      })
      // Let the store commit before the route reads it back.
      setTimeout(() => selectProvider(name), 0)
    },
    [addProvider, providers, selectProvider, t]
  )

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

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage />
      <div className="h-[calc(100%-60px)] overflow-y-auto px-4 pb-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div
            className={cn(
              'flex flex-wrap items-start justify-between gap-3 pb-2',
              !IS_MACOS && 'pr-30'
            )}
          >
            <div className="min-w-0">
              <h1 className="font-studio text-2xl font-medium text-foreground">
                {t('cloud:title')}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('cloud:subtitle')}
              </p>
            </div>
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

          <CloudConnectionCard
            providers={providers}
            selected={selected}
            onSelect={selectProvider}
            onAddCustom={() => setCustomOpen(true)}
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
            />
          )}

          {selected && (
            <CloudModelsCard
              provider={selected}
              refreshing={refreshing}
              onRefresh={handleRefreshModels}
            />
          )}
        </div>
      </div>

      <AddProviderDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        onCreateProvider={createProvider}
      />
    </div>
  )
}
