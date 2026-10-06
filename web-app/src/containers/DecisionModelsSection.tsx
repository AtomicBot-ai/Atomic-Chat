import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { IconArrowRight, IconLoader2 } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import DecisionModelCard, {
  DecisionModelStatus,
} from '@/containers/DecisionModelCard'
import { route } from '@/constants/routes'
import { useBackendUpdater } from '@/hooks/useBackendUpdater'
import { useHardware } from '@/hooks/useHardware'
import { useEngineVersionBackend } from '@/hooks/useDecisionEngineReadiness'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  DECISION_ENGINE_UI,
  decisionEngineReadiness,
} from '@/lib/decision/engine'
import { isActiveDecisionModel } from '@/lib/decision/models'
import { isDecisionHostSupported } from '@/lib/decision/platform'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import {
  decisionDiskBytes,
  type DecisionCatalogModel,
  type DecisionEngine,
} from '@/services/decision-catalog-registry'
import type { DecisionCoreError } from '@/services/decision/types'
import { useDecisionStore } from '@/stores/decision-store'

const ERROR_TEXT: Record<string, string> = {
  DECISION_ENGINE_UNSUPPORTED: 'settings:decision.errors.engineUnsupported',
  DECISION_NOT_CONFIGURED: 'settings:decision.errors.notConfigured',
  DECISION_CHECKPOINT_INCOMPLETE:
    'settings:decision.errors.checkpointIncomplete',
  MODEL_FILE_NOT_FOUND: 'settings:decision.errors.modelFileNotFound',
  DECISION_MODEL_NOT_CHAT: 'settings:decision.errors.notChat',
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

/**
 * Brings the engine to a build that runs decision models: the newest release
 * when one is out, otherwise the build that fits this machine when none is
 * installed. Mounted next to `DECISION_ENGINE_UNSUPPORTED`, and on the
 * llama.cpp page next to models that need a newer build.
 */
function InstallEngineButton({ provider }: { provider: DecisionEngine }) {
  const { t } = useTranslation()
  const engine = DECISION_ENGINE_UI[provider]
  const {
    checkForEngineUpdate,
    recheckOptimalBackend,
    downloadRecommendedBackend,
  } = useBackendUpdater(engine.updater)
  const [installing, setInstalling] = useState(false)

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      const update = await checkForEngineUpdate().catch(() => null)
      let target = update?.updateAvailable ? update.targetBackend : null
      if (!target)
        target = (await recheckOptimalBackend())?.recommendedBackend ?? null
      if (!target) {
        toast.info(t('settings:decision.engineLatest', { engine: engine.name }))
        return
      }
      await downloadRecommendedBackend(target)
    } catch (error) {
      console.error('[decision] engine install failed:', error)
      toast.error(
        t('settings:decision.engineInstallFailed', { engine: engine.name })
      )
    } finally {
      setInstalling(false)
    }
  }, [
    checkForEngineUpdate,
    recheckOptimalBackend,
    downloadRecommendedBackend,
    engine.name,
    t,
  ])

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={installing}
      onClick={() => void install()}
    >
      {installing && <IconLoader2 size={14} className="animate-spin" />}
      {t(
        provider === 'llamacpp-upstream'
          ? 'settings:decision.updateEngine'
          : 'settings:decision.installEngine',
        { engine: engine.name }
      )}
    </Button>
  )
}

function DecisionError({
  error,
  provider,
}: {
  error: DecisionCoreError
  provider: DecisionEngine
}) {
  const { t } = useTranslation()
  const key = ERROR_TEXT[error.code]
  return (
    <div
      role="alert"
      className="mb-3 flex items-start justify-between gap-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <div className="space-y-1">
        <p className="font-medium text-destructive">
          {key
            ? t(key, { engine: DECISION_ENGINE_UI[provider].name })
            : t('settings:decision.errors.generic')}
        </p>
        <p className="text-xs text-muted-foreground break-all">
          {error.message}
          {error.details ? ` — ${error.details}` : ''}
        </p>
      </div>
      {error.code === 'DECISION_ENGINE_UNSUPPORTED' && (
        <InstallEngineButton provider={provider} />
      )}
    </div>
  )
}

/** Downloaded models the configured stock llama.cpp build is too old for, and the build they need. */
function EngineUpdateNotice({
  provider,
  required,
}: {
  provider: DecisionEngine
  required: string
}) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="mb-3 flex items-start justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
    >
      <p className="text-muted-foreground">
        {t('settings:decision.requiresEngineNotice', {
          engine: DECISION_ENGINE_UI[provider].name,
          version: required,
        })}
      </p>
      <InstallEngineButton provider={provider} />
    </div>
  )
}

function modelDescription(
  model: DecisionCatalogModel,
  t: (key: string, options?: Record<string, unknown>) => string,
  requires: string | undefined
) {
  const languages =
    model.languages === 'multilingual'
      ? t('settings:decision.multilingual')
      : model.languages.toUpperCase()
  return (
    <span className="text-xs tabular-nums">
      {languages}
      <span className="mx-1.5 text-muted-foreground/50">·</span>
      {t('settings:decision.context', { tokens: model.context })}
      <span className="mx-1.5 text-muted-foreground/50">·</span>
      {t('settings:decision.diskSize', { size: gb(decisionDiskBytes(model)) })}
      {requires ? (
        <>
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {t('settings:decision.requiresEngine', {
              engine: DECISION_ENGINE_UI[model.engine].name,
              version: requires,
            })}
          </span>
        </>
      ) : (
        <DecisionModelStatus model={model} />
      )}
    </span>
  )
}

/** The newest of the builds `models` need (`b11418` beats `b11370`). */
function newestRequirement(requirements: string[]): string | undefined {
  return [...requirements].sort(
    (a, b) => Number(b.slice(1)) - Number(a.slice(1))
  )[0]
}

/**
 * The downloaded decision models of one engine's provider page (TurboQuant's
 * `llamacpp`, or stock llama.cpp's `llamacpp-upstream`), under its chat
 * models: Start serves one through the Local API Server, Stop and the trash
 * do what they say. One decision model runs at a time, whichever page it is
 * on. Downloading happens in the Hub's Decision category. Renders nothing
 * where the engine cannot run decision models.
 */
export function DecisionModelsSection({
  provider = 'llamacpp',
}: {
  provider?: DecisionEngine
}) {
  const { t } = useTranslation()
  const apiSupported = useServiceHub().decision().isSupported()
  const cpuArch = useHardware((s) => s.hardwareData.cpu.arch)
  const supported =
    PlatformFeatures[PlatformFeature.LOCAL_INFERENCE] &&
    apiSupported &&
    isDecisionHostSupported(cpuArch, provider)
  const versionBackend = useEngineVersionBackend(provider)

  const catalog = useDecisionStore((s) => s.catalog)
  const installed = useDecisionStore((s) => s.installed)
  const status = useDecisionStore((s) => s.status)
  const config = useDecisionStore((s) => s.config)
  const error = useDecisionStore((s) => s.error)

  useEffect(() => {
    if (!supported) return
    return useDecisionStore.getState().bind()
  }, [supported])

  if (!supported) return null

  // The core runs one model; its failure belongs on the page of that model's
  // engine. A model outside the catalog is the TurboQuant page's, as before.
  const activeModel = catalog.models.find((model) =>
    isActiveDecisionModel(config, model)
  )
  const ownsErrors = (activeModel?.engine ?? 'llamacpp') === provider
  const statusError =
    status && (status.state === 'failed' || status.state === 'unsupported')
      ? status.error
      : null
  const shownError = ownsErrors ? (error ?? statusError) : null
  const models = catalog.models.filter(
    (model) => model.engine === provider && installed[model.id]
  )
  const requirements = new Map<string, string>()
  for (const model of models) {
    const readiness = decisionEngineReadiness(model, versionBackend)
    if (readiness.kind === 'needs_update')
      requirements.set(model.id, readiness.required)
  }
  const updateTo = newestRequirement([...requirements.values()])

  return (
    <Card
      header={
        <h1 className="mb-4 text-base font-medium text-foreground">
          {t('settings:decision.sectionTitle')}
        </h1>
      }
    >
      {shownError && <DecisionError error={shownError} provider={provider} />}
      {updateTo && !shownError && (
        <EngineUpdateNotice provider={provider} required={updateTo} />
      )}
      {models.length > 0 ? (
        models.map((model) => (
          <CardItem
            key={model.id}
            title={<h1 className="font-medium line-clamp-1">{model.name}</h1>}
            description={modelDescription(model, t, requirements.get(model.id))}
            actions={
              <DecisionModelCard
                model={model}
                startBlocked={requirements.has(model.id)}
              />
            }
          />
        ))
      ) : (
        <CardItem
          title={
            <h6 className="text-base font-medium">
              {t('settings:decision.noneTitle')}
            </h6>
          }
          description={t('settings:decision.noneDescription')}
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to={route.hub.index} search={{ category: 'decision' }}>
                {t('common:hub')}
                <IconArrowRight size={14} />
              </Link>
            </Button>
          }
        />
      )}
    </Card>
  )
}
