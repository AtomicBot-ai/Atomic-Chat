import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { route } from '@/constants/routes'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useModelProvider } from '@/hooks/useModelProvider'
import { restartLocalApiServer } from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isLocalEngineProvider } from '@/lib/cloud-providers'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { sortProvidersForSettings } from '@/lib/providerOrder'
import { getProviderTitle } from '@/lib/utils'

import { ServerButton, ServerField } from './ServerPageParts'

export type ServedModel = { provider: string; model: string }

export type ServableEngine = {
  provider: string
  title: string
  models: Model[]
}

/**
 * Engines that can serve a chat model now: enabled local engines on this
 * platform (the same rules as the sidebar's engine list) with at least one
 * downloaded chat model.
 */
export function useServableEngines(): ServableEngine[] {
  const providers = useModelProvider((state) => state.providers)
  return useMemo(() => {
    const turboquant = PlatformFeatures[PlatformFeature.TURBOQUANT_ENGINE]
    const engines = providers.flatMap((provider) => {
      if (!isLocalEngineProvider(provider) || !provider.active) return []
      if (!IS_MACOS && provider.provider === 'mlx') return []
      if (!turboquant && provider.provider === 'llamacpp') return []
      const models = provider.models.filter(
        (model) => !model.embedding && !model.missing
      )
      return models.length > 0 ? [{ ...provider, models }] : []
    })
    return sortProvidersForSettings(engines).map((engine) => ({
      provider: engine.provider,
      title: getProviderTitle(engine.provider),
      models: engine.models,
    }))
  }, [providers])
}

/** The engine's model if it has it, else its first one. */
const fitModel = (engine: ServableEngine, model: string) =>
  engine.models.some((m) => m.id === model) ? model : engine.models[0].id

const modelLabel = (model: Model) => model.displayName || model.name || model.id

/** What the picker opens on: the saved choice, else what last ran, else the first. */
export function initialChoice(
  engines: ServableEngine[],
  saved: ServedModel | null,
  lastRun: ServedModel | undefined
): ServedModel | null {
  for (const candidate of [saved, lastRun]) {
    const engine = engines.find((e) => e.provider === candidate?.provider)
    if (engine && candidate)
      return {
        provider: engine.provider,
        model: fitModel(engine, candidate.model),
      }
  }
  const first = engines[0]
  return first ? { provider: first.provider, model: first.models[0].id } : null
}

/**
 * Engine first, then a model that engine can run; changing the engine keeps
 * the model when the new engine has it, else takes its first.
 */
export function EngineModelFields({
  engines,
  choice,
  onChange,
}: {
  engines: ServableEngine[]
  choice: ServedModel
  onChange: (next: ServedModel) => void
}) {
  const { t } = useTranslation()
  const engine =
    engines.find((e) => e.provider === choice.provider) ?? engines[0]

  return (
    <div className="sp-engine-model">
      <ServerField label={t('api:model.engine')}>
        <select
          value={engine.provider}
          onChange={(event) => {
            const next = engines.find((e) => e.provider === event.target.value)
            if (next)
              onChange({
                provider: next.provider,
                model: fitModel(next, choice.model),
              })
          }}
        >
          {engines.map((e) => (
            <option key={e.provider} value={e.provider}>
              {e.title}
            </option>
          ))}
        </select>
      </ServerField>
      <ServerField label={t('api:model.model')} hint={t('api:model.modelHint')}>
        <select
          value={choice.model}
          onChange={(event) =>
            onChange({ provider: engine.provider, model: event.target.value })
          }
        >
          {engine.models.map((model) => (
            <option key={model.id} value={model.id}>
              {modelLabel(model)}
            </option>
          ))}
        </select>
      </ServerField>
    </div>
  )
}

type Phase = 'idle' | 'saved' | 'restarting' | 'failed'

/**
 * Server → Engine & model: the engine first, then a model it can run. Saving
 * makes it the model the server loads on start; while the server runs, "Apply
 * & restart" restarts it so the new model is the one it serves.
 */
export function ServerModelPicker() {
  const { t } = useTranslation()
  const hub = useServiceHub()
  const control = useLocalApiServerControl()
  const engines = useServableEngines()
  const saved = useLocalApiServer((state) => state.defaultModelLocalApiServer)
  const lastRun = useLocalApiServer((state) => state.lastServerModels[0])

  const baseline = useMemo(
    () => initialChoice(engines, saved, lastRun),
    [engines, saved, lastRun]
  )
  const [draft, setDraft] = useState<ServedModel | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')

  const choice = draft ?? baseline
  const engine = engines.find((e) => e.provider === choice?.provider)
  // Against what the page opened on, so a first visit with nothing saved yet
  // does not read as an unsaved change.
  const dirty =
    draft !== null &&
    (draft.provider !== baseline?.provider || draft.model !== baseline?.model)
  const restarting = phase === 'restarting'

  if (!choice || !engine) {
    return (
      <section className="sp-panel sp-empty">
        <h2>{t('api:model.emptyTitle')}</h2>
        <p>{t('api:model.emptyBody')}</p>
        <Link to={route.hub.index} className="sp-button sp-primary">
          {t('api:model.openHub')}
        </Link>
      </section>
    )
  }

  const choose = (next: ServedModel) => {
    setDraft(next)
    setPhase('idle')
  }

  const save = async () => {
    if (!dirty || restarting) return
    useLocalApiServer.getState().setDefaultModelLocalApiServer(draft)
    setDraft(null)
    if (!control.isRunning) {
      setPhase('saved')
      return
    }
    setPhase('restarting')
    const running = await restartLocalApiServer(hub, control, {
      ensureModel: true,
    })
    setPhase(running ? 'saved' : 'failed')
  }

  const statusText = restarting
    ? t('settings:serverConfig.restarting')
    : phase === 'failed'
      ? t('settings:serverConfig.restartFailed')
      : phase === 'saved' && !dirty
        ? t('settings:serverConfig.saved')
        : dirty
          ? t('settings:serverConfig.unsaved')
          : t('settings:serverConfig.allSaved')

  return (
    <>
      <section className="sp-panel">
        <h2>{t('api:model.panelTitle')}</h2>
        <EngineModelFields
          engines={engines}
          choice={choice}
          onChange={choose}
        />
      </section>

      <div className="sp-save">
        <span role="status">{statusText}</span>
        <ServerButton
          disabled={!dirty || restarting}
          onClick={() => {
            setDraft(null)
            setPhase('idle')
          }}
        >
          {t('settings:serverConfig.discard')}
        </ServerButton>
        <ServerButton
          primary
          disabled={!dirty || restarting || control.isBusy}
          onClick={() => void save()}
        >
          {control.isRunning
            ? t('settings:serverConfig.applyRestart')
            : t('settings:serverConfig.save')}
        </ServerButton>
      </div>
    </>
  )
}
