import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { IconArrowRight, IconLoader2 } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import EmbeddingModelCard, {
  EmbeddingModelStatus,
  LocalEmbeddingModelActions,
  LocalEmbeddingModelStatus,
} from '@/containers/EmbeddingModelCard'
import { route } from '@/constants/routes'
import { useBackendUpdater } from '@/hooks/useBackendUpdater'
import { useEngineVersionBackend } from '@/hooks/useDecisionEngineReadiness'
import { useLocalEmbeddingModels } from '@/hooks/useEmbeddingModel'
import { useHardware } from '@/hooks/useHardware'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  EMBEDDING_ENGINE,
  EMBEDDING_ENGINE_UI,
  embeddingEngineReadiness,
  isEmbeddingHostSupported,
} from '@/lib/embedding/engine'
import type { LocalEmbeddingModel } from '@/lib/embedding/models'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import {
  embeddingDiskBytes,
  type EmbeddingCatalogModel,
} from '@/services/embedding-catalog-registry'
import type { EmbeddingCoreError } from '@/services/embedding/types'
import { useEmbeddingStore } from '@/stores/embedding-store'

const ERROR_TEXT: Record<string, string> = {
  EMBEDDING_ENGINE_UNSUPPORTED: 'settings:embedding.errors.engineUnsupported',
  EMBEDDING_NOT_CONFIGURED: 'settings:embedding.errors.notConfigured',
  EMBEDDING_MODEL_NOT_EMBEDDING: 'settings:embedding.errors.notEmbedding',
  MODEL_FILE_NOT_FOUND: 'settings:embedding.errors.modelFileNotFound',
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

/**
 * Brings llama.cpp to a build that runs the embedding models: the newest
 * release when one is out, otherwise the build that fits this machine when
 * none is installed. Mounted next to `EMBEDDING_ENGINE_UNSUPPORTED`, and next
 * to models that need a newer build.
 */
function UpdateEngineButton() {
  const { t } = useTranslation()
  const {
    checkForEngineUpdate,
    recheckOptimalBackend,
    downloadRecommendedBackend,
  } = useBackendUpdater(EMBEDDING_ENGINE_UI.updater)
  const [installing, setInstalling] = useState(false)

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      const update = await checkForEngineUpdate().catch(() => null)
      let target = update?.updateAvailable ? update.targetBackend : null
      if (!target)
        target = (await recheckOptimalBackend())?.recommendedBackend ?? null
      if (!target) {
        toast.info(
          t('settings:embedding.engineLatest', {
            engine: EMBEDDING_ENGINE_UI.name,
          })
        )
        return
      }
      await downloadRecommendedBackend(target)
    } catch (error) {
      console.error('[embedding] engine update failed:', error)
      toast.error(
        t('settings:embedding.engineInstallFailed', {
          engine: EMBEDDING_ENGINE_UI.name,
        })
      )
    } finally {
      setInstalling(false)
    }
  }, [
    checkForEngineUpdate,
    recheckOptimalBackend,
    downloadRecommendedBackend,
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
      {t('settings:embedding.updateEngine', {
        engine: EMBEDDING_ENGINE_UI.name,
      })}
    </Button>
  )
}

function EmbeddingError({ error }: { error: EmbeddingCoreError }) {
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
            ? t(key, { engine: EMBEDDING_ENGINE_UI.name })
            : t('settings:embedding.errors.generic')}
        </p>
        <p className="text-xs text-muted-foreground break-all">
          {error.message}
          {error.details ? ` — ${error.details}` : ''}
        </p>
      </div>
      {error.code === 'EMBEDDING_ENGINE_UNSUPPORTED' && <UpdateEngineButton />}
    </div>
  )
}

/** Downloaded models the configured llama.cpp build is too old for, and the build they need. */
function EngineUpdateNotice({ required }: { required: string }) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="mb-3 flex items-start justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
    >
      <p className="text-muted-foreground">
        {t('settings:embedding.requiresEngineNotice', {
          engine: EMBEDDING_ENGINE_UI.name,
          version: required,
        })}
      </p>
      <UpdateEngineButton />
    </div>
  )
}

function Dot() {
  return <span className="mx-1.5 text-muted-foreground/50">·</span>
}

function modelDescription(
  model: EmbeddingCatalogModel,
  t: (key: string, options?: Record<string, unknown>) => string,
  requires: string | undefined
) {
  return (
    <span className="text-xs tabular-nums">
      {t('settings:embedding.dims', { dims: model.dims })}
      <Dot />
      {t('settings:embedding.context', { tokens: model.context })}
      <Dot />
      {t('settings:embedding.diskSize', {
        size: gb(embeddingDiskBytes(model)),
      })}
      {requires ? (
        <>
          <Dot />
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {t('settings:embedding.requiresEngine', {
              engine: EMBEDDING_ENGINE_UI.name,
              version: requires,
            })}
          </span>
        </>
      ) : (
        <EmbeddingModelStatus model={model} />
      )}
    </span>
  )
}

function localModelDescription(
  model: LocalEmbeddingModel,
  t: (key: string) => string
) {
  return (
    <span className="text-xs">
      {t('settings:embedding.localModel')}
      <LocalEmbeddingModelStatus model={model} />
    </span>
  )
}

/** The newest of the builds `requirements` name (`b11454` beats `b11443`). */
function newestRequirement(requirements: string[]): string | undefined {
  return [...requirements].sort(
    (a, b) => Number(b.slice(1)) - Number(a.slice(1))
  )[0]
}

/**
 * The embedding models of the llama.cpp provider page, under its decision
 * models: the downloaded catalog models, then the llama.cpp models the
 * extension flagged as embedding GGUFs. Start serves one on the Local API
 * Server's `/v1/embeddings` under its id, Stop and the trash do what they
 * say. One embedding model runs at a time. Downloading happens in the Hub's
 * Embedding category. Renders nothing where llama.cpp has no build or there
 * is no core.
 */
export function EmbeddingModelsSection() {
  const { t } = useTranslation()
  const apiSupported = useServiceHub().embedding().isSupported()
  const cpuArch = useHardware((s) => s.hardwareData.cpu.arch)
  const supported =
    PlatformFeatures[PlatformFeature.LOCAL_INFERENCE] &&
    apiSupported &&
    isEmbeddingHostSupported(cpuArch)
  const versionBackend = useEngineVersionBackend(EMBEDDING_ENGINE)

  const catalog = useEmbeddingStore((s) => s.catalog)
  const installed = useEmbeddingStore((s) => s.installed)
  const status = useEmbeddingStore((s) => s.status)
  const error = useEmbeddingStore((s) => s.error)
  const localModels = useLocalEmbeddingModels()

  useEffect(() => {
    if (!supported) return
    return useEmbeddingStore.getState().bind()
  }, [supported])

  if (!supported) return null

  const statusError =
    status && (status.state === 'failed' || status.state === 'unsupported')
      ? status.error
      : null
  const shownError = error ?? statusError
  const models = catalog.models.filter((model) => installed[model.id])
  const requirements = new Map<string, string>()
  for (const model of models) {
    const readiness = embeddingEngineReadiness(model, versionBackend)
    if (readiness.kind === 'needs_update')
      requirements.set(model.id, readiness.required)
  }
  const updateTo = newestRequirement([...requirements.values()])
  const empty = models.length === 0 && localModels.length === 0

  return (
    <Card
      header={
        <h1 className="mb-4 text-base font-medium text-foreground">
          {t('settings:embedding.sectionTitle')}
        </h1>
      }
    >
      {shownError && <EmbeddingError error={shownError} />}
      {updateTo && !shownError && <EngineUpdateNotice required={updateTo} />}
      {models.map((model) => (
        <CardItem
          key={model.id}
          title={<h1 className="font-medium line-clamp-1">{model.name}</h1>}
          description={modelDescription(model, t, requirements.get(model.id))}
          actions={
            <EmbeddingModelCard
              model={model}
              startBlocked={requirements.has(model.id)}
            />
          }
        />
      ))}
      {localModels.map((model) => (
        <CardItem
          key={`local-${model.id}`}
          title={<h1 className="font-medium line-clamp-1">{model.name}</h1>}
          description={localModelDescription(model, t)}
          actions={<LocalEmbeddingModelActions model={model} />}
        />
      ))}
      {empty && (
        <CardItem
          title={
            <h6 className="text-base font-medium">
              {t('settings:embedding.noneTitle')}
            </h6>
          }
          description={t('settings:embedding.noneDescription')}
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to={route.hub.index} search={{ category: 'embedding' }}>
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
