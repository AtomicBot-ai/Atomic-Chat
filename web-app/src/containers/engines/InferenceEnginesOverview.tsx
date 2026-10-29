import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronDown,
  Clapperboard,
  Cpu,
  Download,
  LoaderCircle,
  Mic,
  RefreshCw,
  Rocket,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import {
  VOICE_MODEL_ID,
  VOICE_MODEL_NAME,
  VOICE_PROVIDER,
} from '@/constants/voice'
import HeaderPage from '@/containers/HeaderPage'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { VoiceSettingsPanel } from '@/containers/VoiceSettingsPanel'
import { EngineDetail } from '@/containers/engines/EngineDetail'
import { MediaSettingsPanel } from '@/containers/images/MediaSettingsPanel'
import { useBackendUpdater } from '@/hooks/useBackendUpdater'
import { installEngineUpdate } from '@/hooks/useEngineUpdate'
import {
  backendUpdaterConfigFor,
  offersOptimalBackend,
  useFindOptimalBackend,
} from '@/hooks/useFindOptimalBackend'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isLocalEngineProvider } from '@/lib/cloud-providers'
import {
  engineUpdateOfferFrom,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { sortProvidersForSettings } from '@/lib/providerOrder'
import { refreshAppManagedProviders } from '@/lib/provider-visibility'
import { cn, getProviderTitle } from '@/lib/utils'
import type { EngineId, EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

/** The media engine's name, as Settings → Media names it. */
const MEDIA_ENGINE_NAME = 'stable-diffusion.cpp'
const MEDIA_ENGINE: EngineId = 'sd-cpp'

/**
 * The local language engines this machine lists: MLX on macOS only, the
 * TurboQuant fork behind its platform flag, and the managed engines once
 * their extension shows them (`refreshAppManagedProviders`). Cloud providers,
 * Ollama and custom endpoints live under Cloud providers.
 */
function isListedEngine(provider: ModelProvider): boolean {
  if (!isLocalEngineProvider(provider)) return false
  if (!IS_MACOS && provider.provider === 'mlx') return false
  if (
    !PlatformFeatures[PlatformFeature.TURBOQUANT_ENGINE] &&
    provider.provider === 'llamacpp'
  )
    return false
  return true
}

/** "N models · Build b10840", the build only when the core named one. */
function joinFacts(parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' · ')
}

/**
 * What a row says about its engine's build: the core's answer
 * (`useEngineVersionsStore`), nothing while none came for it.
 * `noActiveBuild`: builds are installed, but none is the one the next load
 * runs; "Not installed" is for an engine with no build at all.
 */
type UpdateStatus =
  | 'updating'
  | 'available'
  | 'upToDate'
  | 'noActiveBuild'
  | 'notInstalled'

function updateStatusOf(
  versions: EngineVersions | undefined,
  updating: boolean
): UpdateStatus | null {
  if (updating) return 'updating'
  if (!versions) return null
  if (!versions.active)
    return versions.builds.length > 0 ? 'noActiveBuild' : 'notInstalled'
  return engineUpdateOfferFrom(versions) ? 'available' : 'upToDate'
}

function StatusLabel({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation()
  return (
    <span
      role="status"
      data-status={status}
      className={cn(
        'shrink-0 whitespace-nowrap text-xs',
        status === 'available'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-muted-foreground'
      )}
    >
      {t(`providers:overview.updateStatus.${status}`)}
    </span>
  )
}

function Group({
  title,
  icon,
  children,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        <span className="min-w-0 truncate">{title}</span>
      </h2>
      <ul className="space-y-3">{children}</ul>
    </section>
  )
}

/**
 * "Find optimal backend" on a llama.cpp row (Windows and Linux): its own
 * backend updater, routed to the row's provider.
 */
function FindOptimalBackendButton({ providerName }: { providerName: string }) {
  const config = useMemo(
    () => ({
      ...backendUpdaterConfigFor(providerName),
      // The engine's page and the global dialog own the one-time recheck.
      postUpgradeRecheckEnabled: false,
    }),
    [providerName]
  )
  const optimal = useFindOptimalBackend(providerName, useBackendUpdater(config))
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={optimal.busy}
      onClick={() => void optimal.find()}
    >
      {optimal.busy ? (
        <LoaderCircle size={14} className="animate-spin" />
      ) : (
        <Rocket size={14} />
      )}
      <span>{optimal.label}</span>
    </Button>
  )
}

/**
 * One engine: its name and facts, whether its build is current, "Update"
 * while the core offers one, and its settings unfolding underneath.
 */
function EngineRow({
  testId,
  icon,
  name,
  description,
  status,
  onUpdate,
  actions,
  children,
}: {
  testId: string
  icon: ReactNode
  name: string
  description: string
  status: UpdateStatus | null
  /** Shown while an update is offered. */
  onUpdate?: () => void
  /** Engine-specific buttons left of the chevron. */
  actions?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const updating = status === 'updating'

  return (
    <li
      data-testid={testId}
      className="rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="min-w-24 flex-1 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {description}
          </span>
        </button>
        {status && <StatusLabel status={status} />}
        {onUpdate && (status === 'available' || updating) && (
          <Button
            size="sm"
            variant="outline"
            disabled={updating}
            aria-label={t('providers:overview.updateEngine', { name })}
            onClick={onUpdate}
          >
            {updating ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            <span>{t('providers:overview.update')}</span>
          </Button>
        )}
        {actions}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={t(
            open
              ? 'providers:overview.collapseSettings'
              : 'providers:overview.expandSettings',
            { name }
          )}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown
            size={16}
            className={cn('transition-transform', open && 'rotate-180')}
          />
        </Button>
      </div>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={t('providers:overview.settingsOf', { name })}
          className="border-t border-border p-4"
        >
          {children}
        </div>
      )}
    </li>
  )
}

/**
 * Models Hub → Inference engines: every engine on this machine in the
 * prototype's three groups. A row says whether the engine's build is current
 * and offers the core's update; its settings unfold underneath — a language
 * engine's are its page's, without the models. "Check for updates" asks the
 * core again for every engine; on Windows and Linux the llama.cpp rows also
 * offer "Find optimal backend". Engines have no start or stop of their own:
 * one runs while a model is loaded on it.
 */
export function InferenceEnginesOverview() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const providers = useModelProvider((state) => state.providers)
  const versions = useEngineVersionsStore((state) => state.engines)
  const checking = useEngineVersionsStore((state) => state.loading)
  const showMedia = PlatformFeatures[PlatformFeature.MEDIA_GENERATION]
  const showVoice = PlatformFeatures[PlatformFeature.VOICE_INPUT]
  // Engines whose update is running: their offer stays until the core's
  // `engine:changed` refreshes the answer.
  const [updating, setUpdating] = useState<ReadonlySet<EngineId>>(new Set())

  // Ask gated engines again each time this page opens: a TensorRT-LLM descriptor published since
  // the app started shows the provider here without an update (spec `tensorrt-llm-desktop`).
  useEffect(() => {
    void refreshAppManagedProviders(() =>
      serviceHub.providers().getProviders()
    ).catch((error) =>
      console.warn('Could not refresh gated providers:', error)
    )
  }, [serviceHub])

  const engines = useMemo(
    () => sortProvidersForSettings(providers.filter(isListedEngine)),
    [providers]
  )

  const statusOf = (engine: string) =>
    updateStatusOf(
      versions[engine as EngineId],
      updating.has(engine as EngineId)
    )

  const applyUpdate = async (engine: EngineId, offer: EngineUpdateOffer) => {
    if (offer.apply === 'reinstall') {
      // A reinstall downloads a large image and asks for consent: the
      // engine's page confirms it first, as from the banner.
      await navigate({
        to: route.settings.providers,
        params: { providerName: engine },
        search: { engineUpdate: true },
      })
      return
    }
    setUpdating((held) => new Set(held).add(engine))
    try {
      await installEngineUpdate(offer)
      await useEngineVersionsStore.getState().refresh()
    } catch (error) {
      console.error('Engine update failed:', error)
      toast.error(t('providers:overview.updateFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setUpdating((held) => {
        const next = new Set(held)
        next.delete(engine)
        return next
      })
    }
  }

  const onUpdate = (engine: string) => {
    const entry = versions[engine as EngineId]
    const offer = entry ? engineUpdateOfferFrom(entry) : null
    if (!offer) return undefined
    return () => void applyUpdate(engine as EngineId, offer)
  }

  // Every engine on this page, as the core names them.
  const listed = useMemo(() => {
    const ids = engines.map((engine) => engine.provider as EngineId)
    if (showMedia) ids.push(MEDIA_ENGINE)
    return new Set(ids)
  }, [engines, showMedia])

  const checkForUpdates = async () => {
    await useEngineVersionsStore.getState().refresh({ force: true })
    const { engines: answer, error } = useEngineVersionsStore.getState()
    if (error) {
      toast.error(t('providers:overview.checkFailed'), {
        description: error.message,
      })
      return
    }
    const offered = [...listed].filter((engine) => {
      const entry = answer[engine]
      return entry ? engineUpdateOfferFrom(entry) !== null : false
    })
    if (offered.length === 0) {
      toast.success(t('providers:overview.allUpToDate'))
    } else {
      toast.info(
        t('providers:overview.updatesFound', { count: offered.length })
      )
    }
  }

  const mediaBuild = versions[MEDIA_ENGINE]?.active?.version
  const voiceInstalled = providers.some(
    (provider) =>
      provider.provider === VOICE_PROVIDER &&
      provider.models.some((model) => model.id === VOICE_MODEL_ID)
  )

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <h1 className="font-studio truncate text-lg font-semibold">
            {t('common:navigation.inferenceEngines')}
          </h1>
          <Button
            size="sm"
            variant="outline"
            disabled={checking}
            onClick={() => void checkForUpdates()}
          >
            {checking ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            <span>{t('providers:overview.checkForUpdates')}</span>
          </Button>
        </div>
      </HeaderPage>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-6">
        <Group
          title={t('providers:overview.language')}
          icon={<Cpu size={16} aria-hidden />}
        >
          {engines.map((provider) => {
            const build =
              versions[provider.provider as EngineId]?.active?.version
            return (
              <EngineRow
                key={provider.provider}
                testId={`engine-row-${provider.provider}`}
                icon={<ProvidersAvatar provider={provider} />}
                name={getProviderTitle(provider.provider)}
                description={joinFacts([
                  provider.models.length === 1
                    ? t('providers:overview.modelCountOne')
                    : t('providers:overview.modelCountOther', {
                        count: provider.models.length,
                      }),
                  build && t('providers:overview.build', { version: build }),
                  !provider.active && t('providers:overview.status.disabled'),
                ])}
                status={statusOf(provider.provider)}
                onUpdate={onUpdate(provider.provider)}
                actions={
                  offersOptimalBackend(provider.provider) && (
                    <FindOptimalBackendButton
                      providerName={provider.provider}
                    />
                  )
                }
              >
                <EngineDetail providerName={provider.provider} embedded />
              </EngineRow>
            )
          })}
        </Group>
        {showMedia && (
          <Group
            title={t('providers:overview.media')}
            icon={<Clapperboard size={16} aria-hidden />}
          >
            <EngineRow
              testId="engine-row-sd-cpp"
              icon={<Clapperboard size={18} />}
              name={MEDIA_ENGINE_NAME}
              description={joinFacts([
                t('providers:overview.mediaDescription'),
                mediaBuild &&
                  t('providers:overview.build', { version: mediaBuild }),
              ])}
              status={statusOf(MEDIA_ENGINE)}
              onUpdate={onUpdate(MEDIA_ENGINE)}
            >
              <MediaSettingsPanel />
            </EngineRow>
          </Group>
        )}
        {showVoice && (
          <Group
            title={t('providers:overview.voice')}
            icon={<Mic size={16} aria-hidden />}
          >
            {/* Voxtral runs on stock llama.cpp: its build and update are
                that engine's, offered on its row. */}
            <EngineRow
              testId="engine-row-voice"
              icon={<Mic size={18} />}
              name={t('common:voice')}
              description={t('providers:overview.voiceDescription', {
                model: VOICE_MODEL_NAME,
              })}
              status={
                voiceInstalled ? statusOf(VOICE_PROVIDER) : 'notInstalled'
              }
            >
              <VoiceSettingsPanel />
            </EngineRow>
          </Group>
        )}
      </div>
    </div>
  )
}
