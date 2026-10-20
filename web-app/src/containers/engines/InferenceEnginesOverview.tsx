import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Clapperboard, Cpu, Mic } from 'lucide-react'

import { Switch } from '@/components/ui/switch'
import { route } from '@/constants/routes'
import {
  VOICE_MODEL_ID,
  VOICE_MODEL_NAME,
  VOICE_PROVIDER,
} from '@/constants/voice'
import HeaderPage from '@/containers/HeaderPage'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { VoiceSettingsPanel } from '@/containers/VoiceSettingsPanel'
import { MediaSettingsPanel } from '@/containers/images/MediaSettingsPanel'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isLocalEngineProvider } from '@/lib/cloud-providers'
import { engineUpdateOfferFrom } from '@/lib/engineUpdateOffer'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { sortProvidersForSettings } from '@/lib/providerOrder'
import { refreshAppManagedProviders } from '@/lib/provider-visibility'
import { cn, getProviderTitle } from '@/lib/utils'
import type { EngineId, EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'

type EngineStatus = 'running' | 'idle' | 'disabled' | 'notInstalled'

/** The media engine's name, as Settings → Media names it. */
const MEDIA_ENGINE_NAME = 'stable-diffusion.cpp'

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
function joinFacts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' · ')
}

function StatusLabel({ status }: { status: EngineStatus }) {
  const { t } = useTranslation()
  return (
    <span
      data-status={status}
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/60'
        )}
      />
      <span>{t(`providers:overview.status.${status}`)}</span>
    </span>
  )
}

function UpdateBadge() {
  const { t } = useTranslation()
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
      <span>{t('providers:overview.updateAvailable')}</span>
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
 * A language engine. The whole card opens the engine's own page
 * (`/settings/providers/$providerName`, unchanged); the switch above it turns
 * the engine on and off as the provider list always has.
 */
function EngineRow({
  provider,
  versions,
  status,
  onToggle,
}: {
  provider: ModelProvider
  versions: EngineVersions | undefined
  status: EngineStatus
  onToggle: (active: boolean) => void
}) {
  const { t } = useTranslation()
  const title = getProviderTitle(provider.provider)
  const build = versions?.active?.version
  const update = versions ? engineUpdateOfferFrom(versions) : null

  return (
    <li
      data-testid={`engine-row-${provider.provider}`}
      className="relative flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
    >
      <ProvidersAvatar provider={provider} />
      <div className="min-w-0 flex-1">
        <Link
          to={route.settings.providers}
          params={{ providerName: provider.provider }}
          className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
        >
          {title}
        </Link>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {joinFacts([
            provider.models.length === 1
              ? t('providers:overview.modelCountOne')
              : t('providers:overview.modelCountOther', {
                  count: provider.models.length,
                }),
            build && t('providers:overview.build', { version: build }),
          ])}
        </p>
      </div>
      {update && <UpdateBadge />}
      <StatusLabel status={status} />
      <Switch
        className="relative z-10"
        aria-label={t('providers:overview.enable', { name: title })}
        checked={provider.active}
        onCheckedChange={onToggle}
      />
      <ChevronRight
        aria-hidden
        size={16}
        className="shrink-0 text-muted-foreground"
      />
    </li>
  )
}

/**
 * Media and Voice have no page of their own in the list: their existing
 * settings panels open inside the card, as in the prototype.
 */
function PanelRow({
  testId,
  icon,
  name,
  description,
  status,
  update,
  children,
}: {
  testId: string
  icon: ReactNode
  name: string
  description: string
  status: EngineStatus
  update: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  return (
    <li
      data-testid={testId}
      className="rounded-xl border border-border bg-card"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 rounded-xl p-4 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex size-4.5 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {description}
          </span>
        </span>
        {update && <UpdateBadge />}
        <StatusLabel status={status} />
        {/* The language rows' switch column, so statuses line up. */}
        <span aria-hidden className="w-8.5 shrink-0" />
        <ChevronDown
          aria-hidden
          size={16}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border p-4">
          {children}
        </div>
      )}
    </li>
  )
}

/**
 * Models Hub → Inference engines: every engine on this machine in the
 * prototype's three groups. Language engines open their own page; the media
 * and voice settings open in place. Engines have no start or stop of their
 * own — one runs while a model is loaded on it — so the status is read from
 * the loaded models, not offered as a button.
 */
export function InferenceEnginesOverview() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { providers, updateProvider } = useModelProvider()
  const versions = useEngineVersionsStore((state) => state.engines)
  // Changes whenever a model loads or unloads anywhere in the app: the cue
  // to ask the engines again.
  const activeModels = useAppState((state) => state.activeModels)
  const mediaLoaded = useImageGenerationStore((state) =>
    Boolean(state.status?.model.loaded)
  )
  const showMedia = PlatformFeatures[PlatformFeature.MEDIA_GENERATION]
  const showVoice = PlatformFeatures[PlatformFeature.VOICE_INPUT]

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

  // The engines to ask what they have loaded, as one stable key.
  const asked = useMemo(() => {
    const names = engines.filter((p) => p.active).map((p) => p.provider)
    if (showVoice) names.push(VOICE_PROVIDER)
    return [...new Set(names)].join(',')
  }, [engines, showVoice])

  const [loaded, setLoaded] = useState<Record<string, string[]>>({})
  useEffect(() => {
    let cancelled = false
    const names = asked ? asked.split(',') : []
    void Promise.all(
      names.map(async (name) => {
        const models = await serviceHub
          .models()
          .getActiveModels(name)
          .catch(() => [] as string[])
        return [name, models] as const
      })
    ).then((entries) => {
      if (!cancelled) setLoaded(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [serviceHub, asked, activeModels])

  const statusOf = (provider: ModelProvider): EngineStatus => {
    if (!provider.active) return 'disabled'
    return (loaded[provider.provider]?.length ?? 0) > 0 ? 'running' : 'idle'
  }

  const toggle = async (provider: ModelProvider, active: boolean) => {
    if (!active && provider.provider.toLowerCase() === 'llamacpp') {
      await serviceHub.models().stopAllModels()
    }
    updateProvider(provider.provider, { ...provider, active })
  }

  const versionsOf = (id: string) => versions[id as EngineId]
  const offers = (id: EngineId) => {
    const entry = versions[id]
    return entry ? engineUpdateOfferFrom(entry) !== null : false
  }

  const mediaBuild = versions['sd-cpp']?.active?.version
  const voiceInstalled = providers.some(
    (provider) =>
      provider.provider === VOICE_PROVIDER &&
      provider.models.some((model) => model.id === VOICE_MODEL_ID)
  )
  const voiceStatus: EngineStatus = loaded[VOICE_PROVIDER]?.includes(
    VOICE_MODEL_ID
  )
    ? 'running'
    : voiceInstalled
      ? 'idle'
      : 'notInstalled'

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <h1 className="font-studio truncate text-lg font-semibold">
          {t('common:navigation.inferenceEngines')}
        </h1>
      </HeaderPage>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 pb-6">
        <Group
          title={t('providers:overview.language')}
          icon={<Cpu size={16} aria-hidden />}
        >
          {engines.map((provider) => (
            <EngineRow
              key={provider.provider}
              provider={provider}
              versions={versionsOf(provider.provider)}
              status={statusOf(provider)}
              onToggle={(active) => void toggle(provider, active)}
            />
          ))}
        </Group>
        {showMedia && (
          <Group
            title={t('providers:overview.media')}
            icon={<Clapperboard size={16} aria-hidden />}
          >
            <PanelRow
              testId="engine-row-sd-cpp"
              icon={<Clapperboard size={18} />}
              name={MEDIA_ENGINE_NAME}
              description={joinFacts([
                t('providers:overview.mediaDescription'),
                mediaBuild &&
                  t('providers:overview.build', { version: mediaBuild }),
              ])}
              status={mediaLoaded ? 'running' : 'idle'}
              update={offers('sd-cpp')}
            >
              <MediaSettingsPanel />
            </PanelRow>
          </Group>
        )}
        {showVoice && (
          <Group
            title={t('providers:overview.voice')}
            icon={<Mic size={16} aria-hidden />}
          >
            <PanelRow
              testId="engine-row-voice"
              icon={<Mic size={18} />}
              name={t('common:voice')}
              description={t('providers:overview.voiceDescription', {
                model: VOICE_MODEL_NAME,
              })}
              status={voiceStatus}
              update={false}
            >
              <VoiceSettingsPanel />
            </PanelRow>
          </Group>
        )}
      </div>
    </div>
  )
}
