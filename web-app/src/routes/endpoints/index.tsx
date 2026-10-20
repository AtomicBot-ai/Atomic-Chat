import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import cloneDeep from 'lodash/cloneDeep'
import { Network, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { openAIProviderSettings } from '@/constants/providers'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import { CloudMediaModelsCard } from '@/containers/cloud/CloudMediaModelsCard'
import { CloudModelsCard } from '@/containers/cloud/CloudModelsCard'
import { EndpointCard } from '@/containers/endpoints/EndpointCard'
import {
  EndpointDialog,
  type EndpointDraft,
} from '@/containers/endpoints/EndpointDialog'
import { useConnectMediaServer } from '@/hooks/useConnectMediaServer'
import { canDeleteProvider, useDeleteProvider } from '@/hooks/useDeleteProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { groupCloudProviders } from '@/lib/cloud-providers'
import { isOnboardingPending } from '@/lib/onboarding'
import { buildApiKeyUpdate, saveProviderApiKey } from '@/lib/provider-api-key'
import { buildBaseUrlUpdate } from '@/lib/provider-base-url'
import { refreshProviderModels } from '@/lib/refresh-provider-models'
import { cn, getProviderTitle } from '@/lib/utils'
import type { EndpointCheckResult } from '@/services/providers/types'
import { useEndpointCheckStore } from '@/stores/endpoint-check-store'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import {
  isKnownProvider,
  useProviderRegistryStore,
} from '@/stores/provider-registry-store'
import { registerRemoteProvider } from '@/utils/registerRemoteProvider'

type EndpointsSearch = {
  /** The endpoint whose models are open. In the URL so links can open it. */
  provider?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.endpoints.index as any)({
  component: EndpointsPage,
  validateSearch: (search: Record<string, unknown>): EndpointsSearch => {
    const provider = search?.provider
    return typeof provider === 'string' && provider.length > 0
      ? { provider }
      : {}
  },
})

type EndpointDialogState = { provider?: string } | null

/**
 * Custom Endpoint — the servers that are the user's own: Ollama, a
 * `llama-server`, a media server, any OpenAI-compatible endpoint they add.
 * They are providers like the cloud ones (`groupCloudProviders().selfHosted`),
 * reached through the same proxy; this page only shows them apart.
 */
export function EndpointsPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const search = useSearch({ from: Route.id }) as EndpointsSearch
  const { providers, addProvider, updateProvider, setProviders } =
    useModelProvider()
  const deleteProvider = useDeleteProvider()

  // A provider the registry does not ship is one the user added, so the
  // grouping changes once the registry has loaded.
  const registryReady = useProviderRegistryStore((s) => s.hasInitialized)
  const endpoints = useMemo(
    () => groupCloudProviders(providers).selfHosted,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, registryReady]
  )

  const mediaAvailable = useMediaCatalog((state) => state.available)
  useEffect(() => {
    void useMediaCatalog.getState().load()
  }, [])

  const [dialog, setDialog] = useState<EndpointDialogState>(null)
  const [removing, setRemoving] = useState<ProviderObject | null>(null)
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})

  const editing = dialog?.provider
    ? endpoints.find((p) => p.provider === dialog.provider)
    : undefined

  const setExpanded = useCallback(
    (providerName: string | undefined) => {
      navigate({
        to: route.endpoints.index,
        search: providerName ? { provider: providerName } : {},
        replace: true,
      })
    },
    [navigate]
  )

  const refreshModels = useCallback(
    async (providerName: string) => {
      const provider = useModelProvider
        .getState()
        .getProviderByName(providerName)
      if (!provider) return
      setRefreshing((state) => ({ ...state, [providerName]: true }))
      try {
        await refreshProviderModels({
          provider,
          serviceHub,
          setProviders,
          updateProvider,
          t,
        })
      } finally {
        setRefreshing((state) => {
          const next = { ...state }
          delete next[providerName]
          return next
        })
      }
    },
    [serviceHub, setProviders, updateProvider, t]
  )

  const ping = useCallback(
    async (provider: ProviderObject) => {
      const checks = useEndpointCheckStore.getState()
      checks.setChecking(provider.provider)
      let result: EndpointCheckResult
      try {
        result = await serviceHub.providers().checkProviderEndpoint(provider)
      } catch (error) {
        result = {
          ok: false,
          latencyMs: 0,
          modelCount: 0,
          message: error instanceof Error ? error.message : String(error),
        }
      }
      useEndpointCheckStore.getState().setResult(provider.provider, result)
    },
    [serviceHub]
  )

  /**
   * Write what the dialog holds, then make the endpoint usable right away:
   * tell the proxy about it and ask it for its models. A media server lists
   * its models from its own Connect button instead.
   */
  const save = (draft: EndpointDraft) => {
    const existing = editing
    const name = existing?.provider ?? draft.name
    if (!existing) {
      // OpenAI's form, the user's address: never seed api.openai.com into a
      // provider that is someone's own server.
      const settings = (
        cloneDeep(openAIProviderSettings) as ProviderSetting[]
      ).map((setting) =>
        setting.key === 'base-url'
          ? {
              ...setting,
              controller_props: {
                ...setting.controller_props,
                value: draft.baseUrl,
              },
            }
          : setting
      )
      addProvider({
        provider: name,
        active: true,
        models: [],
        settings,
        api_key: '',
        base_url: draft.baseUrl,
      })
    } else if (draft.baseUrl !== (existing.base_url ?? '')) {
      const update = buildBaseUrlUpdate(existing, draft.baseUrl)
      updateProvider(name, update)
      void Promise.resolve(
        serviceHub.providers().updateSettings(name, update.settings)
      ).catch((error) => {
        console.warn('[endpoints] updateSettings failed:', error)
      })
    }

    // The key goes on the provider as stored now, address included.
    const current = useModelProvider.getState().getProviderByName(name)
    if (current && draft.apiKey !== (current.api_key ?? '')) {
      if (draft.apiKey) {
        saveProviderApiKey({
          provider: current,
          apiKey: draft.apiKey,
          duringOnboarding: isOnboardingPending(providers),
          updateProvider,
          serviceHub,
        })
      } else {
        updateProvider(name, buildApiKeyUpdate(current, ''))
      }
    }

    // A ping of the old address says nothing about the new one.
    useEndpointCheckStore.getState().clear(name)
    setDialog(null)
    setExpanded(name)

    void (async () => {
      const saved = useModelProvider.getState().getProviderByName(name)
      if (!saved) return
      try {
        await registerRemoteProvider(saved)
      } catch (error) {
        console.warn(`[endpoints] could not register ${name}:`, error)
      }
      if (!saved.media_only) await refreshModels(name)
    })()
  }

  const confirmRemove = () => {
    if (!removing) return
    deleteProvider(removing)
    useEndpointCheckStore.getState().clear(removing.provider)
    if (search.provider === removing.provider) setExpanded(undefined)
    setRemoving(null)
  }

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div
          className={cn(
            'flex items-center justify-between w-full mr-2 pr-3',
            !IS_MACOS && 'pr-30'
          )}
        >
          <h1 className="font-medium text-base font-studio">
            {t('endpoints:title')}
          </h1>
          {endpoints.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => setDialog({})}
            >
              <Plus size={14} aria-hidden />
              {t('endpoints:add')}
            </Button>
          )}
        </div>
      </HeaderPage>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        <p className="mb-5 text-sm text-muted-foreground">
          {t('endpoints:description')}
        </p>
        {endpoints.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 text-center">
            <Network
              size={32}
              className="mb-4 text-muted-foreground"
              aria-hidden
            />
            <h2 className="text-lg font-medium">
              {t('endpoints:empty.title')}
            </h2>
            <p className="my-3 text-sm text-muted-foreground">
              {t('endpoints:empty.description')}
            </p>
            <Button onClick={() => setDialog({})}>
              <Plus size={15} aria-hidden />
              {t('endpoints:add')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {endpoints.map((provider) => (
              <EndpointListItem
                key={provider.provider}
                provider={provider}
                expanded={search.provider === provider.provider}
                onToggleExpanded={() =>
                  setExpanded(
                    search.provider === provider.provider
                      ? undefined
                      : provider.provider
                  )
                }
                onPing={() => void ping(provider)}
                onConfigure={() => setDialog({ provider: provider.provider })}
                onRemove={
                  canDeleteProvider(provider)
                    ? () => setRemoving(provider)
                    : undefined
                }
                updateProvider={updateProvider}
                mediaAvailable={mediaAvailable}
                refreshing={Boolean(refreshing[provider.provider])}
                onRefreshModels={() => void refreshModels(provider.provider)}
              />
            ))}
          </div>
        )}
      </div>

      <EndpointDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null)
        }}
        provider={editing}
        takenNames={providers.map((p) => p.provider)}
        onSave={save}
      />

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('endpoints:remove.title', {
                name: removing ? getProviderTitle(removing.provider) : '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('endpoints:remove.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('endpoints:remove.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmRemove}>
              {t('endpoints:remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** One row with its own media-connect state and its model cards. */
function EndpointListItem({
  provider,
  updateProvider,
  mediaAvailable,
  refreshing,
  onRefreshModels,
  ...card
}: {
  provider: ProviderObject
  expanded: boolean
  onToggleExpanded: () => void
  onPing: () => void
  onConfigure: () => void
  onRemove?: () => void
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  mediaAvailable: boolean
  refreshing: boolean
  onRefreshModels: () => void
}) {
  const { connecting, connect } = useConnectMediaServer(updateProvider)
  const mediaServer = provider.media_only === true
  // A media server's only models are media ones, which need the core's catalog.
  const models =
    mediaServer && !mediaAvailable ? undefined : (
      <>
        {!mediaServer && (
          <CloudModelsCard
            provider={provider}
            refreshing={refreshing}
            onRefresh={onRefreshModels}
          />
        )}
        {mediaAvailable && (
          <CloudMediaModelsCard
            provider={provider}
            custom={!isKnownProvider(provider.provider)}
            onChange={(media) => updateProvider(provider.provider, { media })}
          />
        )}
      </>
    )

  return (
    <EndpointCard
      provider={provider}
      connectingMedia={connecting}
      onConnectMedia={() => void connect(provider)}
      {...card}
    >
      {models}
    </EndpointCard>
  )
}
