import { useCallback, useEffect, useMemo, useState } from 'react'
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
import ClaudeCodeConnection from '@/containers/ClaudeCodeConnection'
import { AddProviderDialog } from '@/containers/dialogs'
import { useChatGptAuth } from '@/hooks/useChatGptAuth'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isCloudProvider,
  isProviderConnected,
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
/// Opened by default when no provider is connected and the URL names none.
const DEFAULT_CLOUD_PROVIDER = 'openrouter'

export function CloudPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const search = useSearch({ from: Route.id }) as { provider?: string }
  const { providers, addProvider, updateProvider, setProviders } =
    useModelProvider()

  const subscription = useChatGptAuth('settings')

  const [customOpen, setCustomOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // The provider catalog is a cloud concern, so its refresh moved here from
  // Settings along with the providers it describes.
  const registryLoading = useProviderRegistryStore(
    (s) => s.status === 'loading'
  )
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
    // page is useful on arrival rather than an empty picker. With nothing
    // connected yet, land on OpenRouter — one key there unlocks most of the
    // catalog — and failing that on whatever comes first, so the page never
    // opens blank.
    return (
      cloudProviders.find(isProviderConnected) ??
      cloudProviders.find((p) => p.provider === DEFAULT_CLOUD_PROVIDER) ??
      cloudProviders[0]
    )
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

  // Canonicalise the implicit “first connected provider” choice into the URL.
  // Otherwise disconnecting it changes `isProviderConnected`, recomputes the
  // fallback and unexpectedly jumps the page to OpenRouter.
  useEffect(() => {
    if (!search.provider && selected) selectProvider(selected.provider)
  }, [search.provider, selectProvider, selected])

  const createProvider = useCallback(
    (name: string) => {
      if (
        providers.some((p) => p.provider.toLowerCase() === name.toLowerCase())
      ) {
        toast.error(t('common:providerAlreadyExists', { name }))
        return
      }
      // The form is OpenAI's, the address is not: a provider the user has only
      // named so far has no endpoint, and seeding OpenAI's made the app ask
      // api.openai.com for models the moment the provider appeared — a third
      // party nobody chose. The address stays on as the field's placeholder.
      const settings = (
        cloneDeep(openAIProviderSettings) as ProviderSetting[]
      ).map((setting) =>
        setting.key === 'base-url'
          ? {
              ...setting,
              controller_props: { ...setting.controller_props, value: '' },
            }
          : setting
      )
      addProvider({
        provider: name,
        active: true,
        models: [],
        settings,
        api_key: '',
        base_url: '',
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
      {/* Classic (non-overlay) scrollbars — macOS with a mouse connected or
          "Show scroll bars: Always", Windows, Linux — take layout width, so
          a provider whose model list scrolls and one whose list does not
          gave the centred column two different widths: every switch between
          them nudged the whole block sideways. Reserving the gutter keeps
          the geometry constant; same rule the onboarding picker applies. */}
      <div className="h-[calc(100%-60px)] overflow-y-auto p-4 pt-0 [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <CloudConnectionCard
            providers={providers}
            selected={selected}
            onSelect={selectProvider}
            onAddCustom={() => setCustomOpen(true)}
            onDeleted={clearSelection}
            updateProvider={updateProvider}
            serviceHub={serviceHub}
          />

          {selected?.provider === 'claude-code' && <ClaudeCodeConnection />}

          {selected?.provider === 'chatgpt' && (
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
