import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { AppEvent, events } from '@janhq/core'
import {
  IconAlertTriangle,
  IconChevronRight,
  IconLoader,
  IconRefresh,
  IconRocket,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/containers/Card'
import { DropdownControl } from '@/containers/dynamicControllerSetting/DropdownControl'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { ManageEnginePacksDialog } from '@/containers/dialogs/ManageEnginePacksDialog'
import type { EnginePackSource } from '@/containers/dialogs/ManageEnginePacksDialog'
import { route } from '@/constants/routes'
import { useBackendMismatch } from '@/hooks/useBackendMismatch'
import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  useBackendUpdater,
  type UseBackendUpdaterConfig,
} from '@/hooks/useBackendUpdater'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, getProviderTitle } from '@/lib/utils'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

/// Engines are listed in a fixed order rather than in provider-store order:
/// this page is the user's mental model of "which runtime runs my models", and
/// a list that reshuffles itself between launches is unreadable.
///
/// Foundation Models is deliberately absent: it is a macOS system feature with
/// no version, no download and nothing to tune, so a row for it is noise on a
/// page about choosing and updating engines.
const ENGINE_ORDER = ['llamacpp', 'llamacpp-upstream', 'mlx'] as const

/// Providers whose backend builds are downloaded, versioned and swappable.
/// MLX ships its server as a bundled sidecar, so it has no version list, no
/// update check and no installed packs.
const VERSIONED_ENGINES = ['llamacpp', 'llamacpp-upstream'] as const

const TURBOQUANT_UPDATER_CONFIG: UseBackendUpdaterConfig = {
  extensionName: '@janhq/llamacpp-extension',
  providerId: 'llamacpp',
  recommendationKey: 'turboquant_better_backend_recommendation',
  postUpgradeRecheckEnabled: false,
}

const PENDING_BACKEND_KEYS: Record<string, string> = {
  'llamacpp': 'turboquant_pending_backend',
  'llamacpp-upstream': 'llama_cpp_pending_backend',
}

type EngineUpdater = ReturnType<typeof useBackendUpdater>

/// Mirrors both providers' pending-backend keys so a build that finished
/// downloading but needs a relaunch is visible on the row it belongs to.
function usePendingBackends(): Record<string, string | null> {
  const read = useCallback(() => {
    if (typeof window === 'undefined') return {}
    return Object.fromEntries(
      Object.entries(PENDING_BACKEND_KEYS).map(([provider, key]) => {
        const raw = localStorage.getItem(key)
        return [provider, raw ? raw.replace(/\uFEFF/g, '').trim() : null]
      })
    )
  }, [])

  const [pending, setPending] = useState<Record<string, string | null>>(read)

  useEffect(() => {
    const refresh = () => setPending(read())
    const onFinished = (payload: { status?: string }) => {
      if (payload?.status === 'completed') refresh()
    }
    refresh()
    events.on(AppEvent.onBackendDownloadFinished, onFinished)
    window.addEventListener('storage', refresh)
    window.addEventListener('app:backend-hotswapped', refresh)
    return () => {
      events.off(AppEvent.onBackendDownloadFinished, onFinished)
      window.removeEventListener('storage', refresh)
      window.removeEventListener('app:backend-hotswapped', refresh)
    }
  }, [read])

  return pending
}

function versionBackendSetting(provider: ProviderObject) {
  return provider.settings?.find((setting) => setting.key === 'version_backend')
}

type EngineRowProps = {
  provider: ProviderObject
  updater: EngineUpdater | null
  pendingBackend: string | null
  mismatchNotice: string | null
  onToggleActive: (provider: ProviderObject, active: boolean) => void
  onVersionChange: (provider: ProviderObject, value: string) => void
}

function EngineRow({
  provider,
  updater,
  pendingBackend,
  mismatchNotice,
  onToggleActive,
  onVersionChange,
}: EngineRowProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [isFindingOptimal, setIsFindingOptimal] = useState(false)

  const setting = versionBackendSetting(provider)
  const isVersioned = (VERSIONED_ENGINES as readonly string[]).includes(
    provider.provider
  )
  const currentValue = String(setting?.controller_props?.value ?? '')
  const isConfiguring =
    isVersioned && (!currentValue || currentValue === 'none')

  // The optimal-backend matrix only exists where a provider publishes more
  // than one GPU tier for the host. macOS has a single build per engine.
  const canFindOptimal = isVersioned && (IS_WINDOWS || IS_LINUX) && !!updater

  const isOptimalBusy =
    isFindingOptimal ||
    updater?.recommendationPhase === 'downloading' ||
    updater?.recommendationPhase === 'hotswapping'

  const optimalLabel = isFindingOptimal
    ? t('settings:backendUpdater.findOptimalChecking')
    : updater?.recommendationPhase === 'downloading'
      ? t('settings:backendUpdater.findOptimalDownloading')
      : updater?.recommendationPhase === 'hotswapping'
        ? t('settings:backendUpdater.findOptimalSwitching')
        : t('settings:backendUpdater.findOptimalAction')

  const handleFindOptimal = useCallback(async () => {
    if (!updater) return
    setIsFindingOptimal(true)
    try {
      const result = await updater.recheckOptimalBackend()
      if (!result) {
        toast.success(t('settings:backendUpdater.alreadyOptimal'))
        return
      }
      // Pass the freshly detected backend explicitly — the hook's own
      // `recommendation` state has not committed yet at this point.
      void updater
        .downloadRecommendedBackend(result.recommendedBackend)
        .catch((err) => {
          console.error('Optimal backend download failed:', err)
          toast.error(t('settings:backendUpdater.downloadFailed'))
        })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'BACKEND_DETECTION_FAILED'
      ) {
        toast.info(t('settings:backendUpdater.detectionUnavailable'))
        return
      }
      console.error('Failed to recheck optimal backend:', error)
      toast.error(t('settings:backendUpdater.findOptimalFailed'))
    } finally {
      setIsFindingOptimal(false)
    }
  }, [t, updater])

  const handleRestart = useCallback(async () => {
    try {
      await window.core?.api?.relaunch()
    } catch (err) {
      console.error('Failed to relaunch for pending backend:', err)
    }
  }, [])

  const versionControl = () => {
    if (!setting) return null
    if (isConfiguring) {
      return (
        <div className="flex h-8 items-center justify-end gap-1 text-sm text-muted-foreground">
          <IconLoader size={14} className="animate-spin" />
          <span>{t('provider:runtime.configuring')}</span>
        </div>
      )
    }
    if (!isVersioned) {
      // MLX ships one sidecar per app release, so there is nothing to switch
      // to — but it still renders as a list with a single entry, so every
      // engine row reads the same way instead of one of them being bare text.
      const label = currentValue || t('provider:runtime.bundled')
      return (
        <DropdownControl
          value={label}
          options={[{ value: label, name: label }]}
          onChange={() => {}}
        />
      )
    }
    return (
      <DropdownControl
        value={currentValue}
        options={setting.controller_props?.options}
        recommended={setting.controller_props?.recommended}
        onChange={(value) => onVersionChange(provider, String(value))}
      />
    )
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border/40 py-4 first:pt-0 last:border-none last:pb-0">
      {/* The identity block must be free to shrink (long fork version ids)
          while the controls keep their size, so the switch can never be
          pushed past the card's right edge. */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 shrink-0">
            <ProvidersAvatar provider={provider} />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">
              {getProviderTitle(provider.provider)}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(`provider:runtime.blurb.${provider.provider}`, {
                defaultValue: '',
              })}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {setting && (
            <div className="w-56 max-w-[40vw]">{versionControl()}</div>
          )}
          <Switch
            checked={provider.active}
            onCheckedChange={(checked) => onToggleActive(provider, checked)}
          />
        </div>
      </div>

      {mismatchNotice && (
        <div className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-500">
          <IconAlertTriangle size={14} className="shrink-0" />
          <span>{mismatchNotice}</span>
        </div>
      )}

      {pendingBackend && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            {t('settings:backendUpdater.pendingBackendLabel')}
          </span>
          <code className="font-mono text-foreground/80">{pendingBackend}</code>
          <span className="text-muted-foreground">
            {t('settings:backendUpdater.pendingBackendHint')}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={handleRestart}
          >
            <IconRefresh size={12} className="text-muted-foreground" />
            <span>{t('settings:backendUpdater.restartNow')}</span>
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-muted-foreground hover:text-foreground hover:no-underline"
          onClick={() =>
            navigate({
              to: route.settings.providers,
              params: { providerName: provider.provider },
            })
          }
        >
          <span>{t('provider:runtime.models')}</span>
          <IconChevronRight size={14} />
        </Button>
        {canFindOptimal && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleFindOptimal}
            disabled={isOptimalBusy}
          >
            {isOptimalBusy ? (
              <IconLoader
                size={12}
                className="animate-spin text-muted-foreground"
              />
            ) : (
              <IconRocket size={12} className="text-muted-foreground" />
            )}
            <span>{optimalLabel}</span>
          </Button>
        )}
      </div>
    </div>
  )
}

export function LocalRuntimePanel() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { providers, updateProvider, setProviders } = useModelProvider()
  const pendingBackends = usePendingBackends()
  const { pending: backendMismatch } = useBackendMismatch()
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false)
  const [packsOpen, setPacksOpen] = useState(false)

  // Both llama.cpp providers ship side by side, each with its own extension,
  // backend tree and localStorage keys. Two fixed hook instances keep the
  // routing explicit — a per-row hook would break the rules of hooks as soon
  // as the provider list changes shape.
  const turboquantUpdater = useBackendUpdater(TURBOQUANT_UPDATER_CONFIG)
  const upstreamUpdater = useBackendUpdater()

  const updaterFor = useCallback(
    (providerId: string): EngineUpdater | null => {
      if (providerId === 'llamacpp') return turboquantUpdater
      if (providerId === 'llamacpp-upstream') return upstreamUpdater
      return null
    },
    [turboquantUpdater, upstreamUpdater]
  )

  const engines = useMemo(
    () =>
      ENGINE_ORDER.map((id) =>
        providers.find((provider) => provider.provider === id)
      )
        .filter((provider): provider is ProviderObject => !!provider)
        .filter((provider) => IS_MACOS || provider.provider !== 'mlx'),
    [providers]
  )

  const refreshProviders = useCallback(async () => {
    try {
      const fresh = await serviceHub.providers().getProviders()
      setProviders(fresh)
    } catch (err) {
      console.warn('[runtimes] failed to refresh providers:', err)
    }
  }, [serviceHub, setProviders])

  // The provider snapshot the app boots with is read while the engines are
  // still resolving their release catalogs, so its version lists can be the
  // short early ones — a single bundled build where several are installed.
  // This page exists to switch versions, so it re-reads them on open.
  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  const handleToggleActive = useCallback(
    async (provider: ProviderObject, active: boolean) => {
      if (!active && provider.provider === 'llamacpp') {
        await serviceHub.models().stopAllModels()
      }
      updateProvider(provider.provider, { ...provider, active })
    },
    [serviceHub, updateProvider]
  )

  const handleVersionChange = useCallback(
    (provider: ProviderObject, value: string) => {
      const updater = updaterFor(provider.provider)

      // A "Latest <variant>" pick is a `latest/<backend>` sentinel, not a
      // concrete release. Persisting it would point the engine at a download
      // URL that cannot exist, so it goes through the extension's resolve →
      // download → hot-swap orchestration instead.
      if (value.startsWith('latest/') && updater) {
        void updater.selectManualBackend(value).catch((err) => {
          console.error('Manual backend download failed:', err)
          toast.error(t('settings:backendUpdater.downloadFailed'))
        })
        return
      }

      const newSettings = provider.settings.map((setting) => {
        if (setting.key === 'version_backend') {
          return {
            ...setting,
            controller_props: { ...setting.controller_props, value },
          }
        }
        // A device selection belongs to the backend it was made on; carrying
        // it across a backend switch pins the engine to a device index the
        // new build may not have.
        if (setting.key === 'device') {
          return {
            ...setting,
            controller_props: { ...setting.controller_props, value: '' },
          }
        }
        return setting
      })

      updateProvider(provider.provider, { ...provider, settings: newSettings })

      if (provider.provider === 'llamacpp') {
        useLlamacppDevices.getState().fetchDevices()
      }

      void serviceHub
        .providers()
        .updateSettings(provider.provider, newSettings as ProviderSetting[])
      void serviceHub.models().stopAllModels()
      void serviceHub
        .models()
        .getActiveModels()
        .then((models) => syncActiveModelsFromEngines(models || []))
    },
    [serviceHub, t, updateProvider, updaterFor]
  )

  /// One button for every versioned engine. Each provider resolves its own
  /// catalog (our fork's release index vs the `atomic-chat-conf` manifest), so
  /// the check runs per provider and the outcomes are summarised together.
  const handleCheckEngineUpdates = useCallback(async () => {
    const targets = engines
      .filter((provider) =>
        (VERSIONED_ENGINES as readonly string[]).includes(provider.provider)
      )
      .map((provider) => ({
        provider,
        updater: updaterFor(provider.provider),
      }))
      .filter(
        (
          entry
        ): entry is { provider: ProviderObject; updater: EngineUpdater } =>
          !!entry.updater
      )

    if (targets.length === 0) return

    setIsCheckingUpdates(true)
    try {
      const results = await Promise.all(
        targets.map(async ({ provider, updater }) => {
          try {
            const result = await updater.checkForEngineUpdate()
            return { provider, updater, ...result }
          } catch (err) {
            console.error(
              `Failed to check engine updates for ${provider.provider}:`,
              err
            )
            return {
              provider,
              updater,
              updateAvailable: false,
              targetBackend: null,
            }
          }
        })
      )

      const updatable = results.filter(
        (result) => result.updateAvailable && result.targetBackend
      )
      if (updatable.length === 0) {
        toast.success(t('settings:noBackendUpdateAvailable'))
        return
      }

      for (const { provider, updater, targetBackend } of updatable) {
        toast.info(t('settings:backendUpdater.downloadingBackend'), {
          description: `${getProviderTitle(provider.provider)} · ${targetBackend}`,
        })
        // The archive takes minutes; the global <BackendUpdater /> owns that
        // progress UI, so the download is deliberately not awaited here.
        void updater
          .downloadRecommendedBackend(targetBackend as string)
          .then(async () => {
            await updater.refreshBackendCatalog()
            await refreshProviders()
            toast.success(t('settings:backendUpdater.updateSuccess'), {
              description: targetBackend as string,
            })
          })
          .catch((err) => {
            console.error('Engine update download failed:', err)
            toast.error(t('settings:backendUpdater.downloadFailed'))
          })
      }
    } finally {
      setIsCheckingUpdates(false)
    }
  }, [engines, refreshProviders, t, updaterFor])

  const packSources = useMemo<EnginePackSource[]>(
    () =>
      engines
        .filter((provider) =>
          (VERSIONED_ENGINES as readonly string[]).includes(provider.provider)
        )
        .map((provider) => {
          const updater = updaterFor(provider.provider)
          return {
            provider: provider.provider,
            listInstalledBackends: () =>
              updater?.listInstalledBackends() ?? Promise.resolve([]),
            deleteBackend: (version: string, backend: string) =>
              updater?.deleteBackend(version, backend) ?? Promise.resolve(),
            installBackend: (filePath: string) =>
              updater?.installBackend(filePath) ?? Promise.resolve(),
          }
        }),
    [engines, updaterFor]
  )

  const mismatchNoticeFor = useCallback(
    (providerId: string) => {
      if (!backendMismatch || backendMismatch.provider !== providerId) {
        return null
      }
      const { mismatch } = backendMismatch
      if (mismatch.kind === 'silent-fallback') {
        return t('settings:backendMismatch.actuallyRunning', {
          backend: mismatch.effective,
        })
      }
      if (mismatch.kind === 'runtime-cpu') {
        return mismatch.total
          ? t('settings:backendMismatch.actuallyRunningCpuLayers', {
              offloaded: mismatch.offloaded ?? 0,
              total: mismatch.total,
            })
          : t('settings:backendMismatch.actuallyRunningDevice', {
              device: mismatch.primaryDevice,
            })
      }
      return null
    },
    [backendMismatch, t]
  )

  return (
    <>
      <Card
        header={
          <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-50 flex-1">
              <h1 className="font-studio text-base font-medium text-foreground">
                {t('provider:runtime.title')}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('provider:runtime.description')}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCheckEngineUpdates}
                disabled={isCheckingUpdates || packSources.length === 0}
              >
                {isCheckingUpdates ? (
                  <IconLoader
                    size={14}
                    className="animate-spin text-muted-foreground"
                  />
                ) : (
                  <IconRefresh size={14} className="text-muted-foreground" />
                )}
                <span>{t('settings:checkForBackendUpdates')}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPacksOpen(true)}
                disabled={packSources.length === 0}
              >
                {t('provider:packs.manage')}
              </Button>
            </div>
          </div>
        }
      >
        {engines.length === 0 ? (
          <p className={cn('text-sm text-muted-foreground')}>
            {t('provider:runtime.empty')}
          </p>
        ) : (
          engines.map((provider) => (
            <EngineRow
              key={provider.provider}
              provider={provider}
              updater={updaterFor(provider.provider)}
              pendingBackend={pendingBackends[provider.provider] ?? null}
              mismatchNotice={mismatchNoticeFor(provider.provider)}
              onToggleActive={handleToggleActive}
              onVersionChange={handleVersionChange}
            />
          ))
        )}
      </Card>

      <ManageEnginePacksDialog
        open={packsOpen}
        onOpenChange={setPacksOpen}
        sources={packSources}
        onPacksChanged={refreshProviders}
      />
    </>
  )
}
