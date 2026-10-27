import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { route } from '@/constants/routes'
import { SetupGuideHint } from '@/containers/onboarding/SetupGuideHint'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useModelProvider } from '@/hooks/useModelProvider'
import { restartLocalApiServer } from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isLocalEngineProvider } from '@/lib/cloud-providers'
import { modelVariantDetails } from '@/lib/model-display-name'
import { modelFamilyLogoSrc } from '@/lib/model-logo'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { sortProvidersForSettings } from '@/lib/providerOrder'
import { formatBytes, getProviderLogo, getProviderTitle } from '@/lib/utils'
import {
  type ServerPickerTarget,
  useServerPickerRequest,
} from '@/stores/server-picker-request-store'

import {
  ServerButton,
  type ServerDetailChoice,
  ServerDetailPicker,
  ServerField,
  ServerSelect,
} from './ServerPageParts'
import {
  NO_HELPER_MODEL,
  type ServedHelperModels,
  useServedDecisionModels,
  useServedEmbeddingModels,
} from './useServedHelperModels'

export type ServedModel = { provider: string; model: string }

export type ServableEngine = {
  provider: string
  title: string
  models: Model[]
}

/**
 * An engine the server can run on this platform: an enabled local engine, by
 * the same rules as the sidebar's engine list. Whether it has a model yet is
 * not asked, so first-run setup can tell a model still downloading for it
 * from one the server could never serve.
 */
export function isServableEngine(provider: ModelProvider): boolean {
  if (!isLocalEngineProvider(provider) || !provider.active) return false
  if (!IS_MACOS && provider.provider === 'mlx') return false
  return (
    provider.provider !== 'llamacpp' ||
    PlatformFeatures[PlatformFeature.TURBOQUANT_ENGINE]
  )
}

/**
 * Engines that can serve a chat model now: servable engines
 * (`isServableEngine`) with at least one downloaded chat model.
 */
export function useServableEngines(): ServableEngine[] {
  const providers = useModelProvider((state) => state.providers)
  return useMemo(() => {
    const engines = providers.flatMap((provider) => {
      if (!isServableEngine(provider)) return []
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
 * What each engine is, in a line, and the files it runs, for the engine
 * picker's rows. An engine left out shows its name and model count only.
 */
const ENGINE_FACTS: Record<string, { detail: string; format?: string }> = {
  'llamacpp-upstream': {
    detail: 'api:model.engineDetail.llamacpp',
    format: 'GGUF',
  },
  'llamacpp': { detail: 'api:model.engineDetail.turboquant', format: 'GGUF' },
  'mlx': { detail: 'api:model.engineDetail.mlx', format: 'MLX' },
  'atomic-prism': { detail: 'api:model.engineDetail.prism', format: 'GGUF' },
  'vllm': { detail: 'api:model.engineDetail.vllm' },
  'sglang': { detail: 'api:model.engineDetail.sglang' },
  'tensorrt-llm': { detail: 'api:model.engineDetail.tensorrt' },
  'foundry-local': { detail: 'api:model.engineDetail.foundry', format: 'ONNX' },
  'litert-lm': { detail: 'api:model.engineDetail.litert', format: 'LiteRT-LM' },
}

const joinFacts = (facts: (string | undefined | false)[]) =>
  facts.filter(Boolean).join(' · ') || undefined

/**
 * A model's row: its family's mark (the engine's when no family matches),
 * its description when it carries one, and what is known of the file — the
 * quantization its name leaves out and its size on disk.
 */
function modelChoice(
  model: Model,
  engineLogo: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): ServerDetailChoice {
  const name = modelLabel(model)
  const { quant } = modelVariantDetails(model)
  const size = formatBytes(model.sizeBytes)
  return {
    value: model.id,
    name,
    logo:
      modelFamilyLogoSrc(name) ?? modelFamilyLogoSrc(model.id) ?? engineLogo,
    detail: model.description?.trim() || undefined,
    metadata: joinFacts([
      quant && !name.toLowerCase().includes(quant.toLowerCase()) && quant,
      size && t('api:model.onDisk', { size }),
    ]),
  }
}

/**
 * Engine first, then a model that engine can run; changing the engine keeps
 * the model when the new engine has it, else takes its first. Both pickers
 * show what each choice is, as their rows do. Each opens on its own unless
 * the parent holds which one is open (`onOpenPickerChange`), as the page
 * does to open the one the tray asked for.
 */
export function EngineModelFields({
  engines,
  choice,
  onChange,
  openPicker = null,
  onOpenPickerChange,
}: {
  engines: ServableEngine[]
  choice: ServedModel
  onChange: (next: ServedModel) => void
  openPicker?: ServerPickerTarget | null
  onOpenPickerChange?: (picker: ServerPickerTarget | null) => void
}) {
  const { t } = useTranslation()
  const engine =
    engines.find((e) => e.provider === choice.provider) ?? engines[0]
  const openProps = (picker: ServerPickerTarget) =>
    onOpenPickerChange
      ? {
          open: openPicker === picker,
          onOpenChange: (open: boolean) =>
            onOpenPickerChange(open ? picker : null),
        }
      : {}

  return (
    <div className="sp-engine-model">
      <ServerDetailPicker
        {...openProps('engine')}
        label={t('api:model.engine')}
        value={engine.provider}
        choices={engines.map((e) => {
          const facts = ENGINE_FACTS[e.provider]
          return {
            value: e.provider,
            name: e.title,
            logo: getProviderLogo(e.provider),
            detail: facts && t(facts.detail),
            metadata: joinFacts([
              facts?.format,
              t('api:model.engineModels', { count: e.models.length }),
            ]),
          }
        })}
        onChange={(provider) => {
          const next = engines.find((e) => e.provider === provider)
          if (next)
            onChange({
              provider: next.provider,
              model: fitModel(next, choice.model),
            })
        }}
      />
      <ServerDetailPicker
        {...openProps('model')}
        label={t('api:model.model')}
        value={choice.model}
        choices={engine.models.map((model) =>
          modelChoice(model, getProviderLogo(engine.provider), t)
        )}
        onChange={(model) => onChange({ provider: engine.provider, model })}
      />
    </div>
  )
}

/**
 * The embedding and decision models beside the chat model, each "None" or
 * one of the downloaded ones. A kind this desktop cannot run is left out.
 */
function HelperModelFields({
  embedding,
  decision,
  choice,
  onChange,
}: {
  embedding: ServedHelperModels
  decision: ServedHelperModels
  choice: HelperChoice
  onChange: (next: HelperChoice) => void
}) {
  const { t } = useTranslation()
  const none = { value: NO_HELPER_MODEL, label: t('api:model.none') }
  const field = (
    kind: keyof HelperChoice,
    models: ServedHelperModels,
    label: string,
    hint: string
  ) => (
    <ServerField
      label={label}
      hint={models.options.length > 0 ? hint : t('api:model.helperEmpty')}
    >
      <ServerSelect
        label={label}
        value={choice[kind]}
        options={[none, ...models.options]}
        disabled={models.options.length === 0 && choice[kind] === none.value}
        onChange={(value) => onChange({ ...choice, [kind]: value })}
      />
    </ServerField>
  )

  return (
    <div className="sp-engine-model">
      {embedding.supported &&
        field(
          'embedding',
          embedding,
          t('api:model.embeddingModel'),
          t('api:model.embeddingHint')
        )}
      {decision.supported &&
        field(
          'decision',
          decision,
          t('api:model.decisionModel'),
          t('api:model.decisionHint')
        )}
    </div>
  )
}

type HelperChoice = { embedding: string; decision: string }

type Phase = 'idle' | 'restarting' | 'failed'

/**
 * Server → Engine & model: the engine first, then a model it can run, and
 * the embedding and decision models served beside it. Saving makes the chat
 * model the one the server loads on start (while the server runs, it comes
 * back serving it), and starts the chosen embedding and decision models — or
 * switches them off — right away, as their Start in the Hub does.
 */
export function ServerModelPicker() {
  const { t } = useTranslation()
  const hub = useServiceHub()
  const control = useLocalApiServerControl()
  const engines = useServableEngines()
  const saved = useLocalApiServer((state) => state.defaultModelLocalApiServer)
  const lastRun = useLocalApiServer((state) => state.lastServerModels[0])
  const embedding = useServedEmbeddingModels()
  const decision = useServedDecisionModels()

  const baseline = useMemo(
    () => initialChoice(engines, saved, lastRun),
    [engines, saved, lastRun]
  )
  const helperBaseline: HelperChoice = {
    embedding: embedding.active,
    decision: decision.active,
  }
  const [draft, setDraft] = useState<ServedModel | null>(null)
  const [helperDraft, setHelperDraft] = useState<Partial<HelperChoice>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [openPicker, setOpenPicker] = useState<ServerPickerTarget | null>(null)

  const choice = draft ?? baseline
  const engine = engines.find((e) => e.provider === choice?.provider)
  const hasFields = Boolean(choice && engine)
  const helperChoice = { ...helperBaseline, ...helperDraft }
  // Against what the page opened on, so a first visit with nothing saved yet
  // does not read as an unsaved change.
  const chatDirty =
    draft !== null &&
    (draft.provider !== baseline?.provider || draft.model !== baseline?.model)
  const helperChanges = (['embedding', 'decision'] as const).filter(
    (kind) => helperChoice[kind] !== helperBaseline[kind]
  )
  const dirty = chatDirty || helperChanges.length > 0
  const restarting = phase === 'restarting'
  const showHelpers = embedding.supported || decision.supported

  // The tray's Model or Runtime row asked for a picker: open it once, whether
  // the page mounts after the request or was already on screen. With no
  // engine to serve there is no picker, and a request kept for later would
  // pop one open on some unrelated visit, so it is dropped either way.
  const requested = useServerPickerRequest((state) => state.target)
  const requestNonce = useServerPickerRequest((state) => state.nonce)
  useEffect(() => {
    if (!requested) return
    if (hasFields) setOpenPicker(requested)
    useServerPickerRequest.getState().clear()
  }, [requested, requestNonce, hasFields])

  const discard = () => {
    setDraft(null)
    setHelperDraft({})
    setPhase('idle')
  }

  const save = async () => {
    if (!dirty || restarting) return
    setPhase('restarting')
    let running = true
    if (chatDirty) {
      useLocalApiServer.getState().setDefaultModelLocalApiServer(draft)
      if (control.isRunning) {
        running = await restartLocalApiServer(hub, control, {
          ensureModel: true,
        })
      }
    }
    const models = { embedding, decision }
    for (const kind of helperChanges) {
      try {
        await models[kind].apply(helperChoice[kind])
      } catch (error) {
        toast.error(t('api:model.helperFailed'), {
          description: coreErrorMessage(error),
        })
      }
    }
    setDraft(null)
    setHelperDraft({})
    setPhase(running ? 'idle' : 'failed')
  }

  // The bar shows only while there is something to save or a restart to
  // report; once saved it goes, and the fields show what was kept.
  const showSave = dirty || restarting || phase === 'failed'
  const statusText = restarting
    ? t('settings:serverConfig.restarting')
    : phase === 'failed'
      ? t('settings:serverConfig.restartFailed')
      : t('settings:serverConfig.unsaved')

  return (
    <>
      {choice && engine ? (
        <section className="sp-panel">
          <SetupGuideHint path="endpoint" hint={1} />
          <EngineModelFields
            engines={engines}
            choice={choice}
            onChange={(next) => {
              setDraft(next)
              setPhase('idle')
            }}
            openPicker={openPicker}
            onOpenPickerChange={setOpenPicker}
          />
        </section>
      ) : (
        <section className="sp-panel sp-empty">
          <SetupGuideHint path="endpoint" hint={1} />
          <h2>{t('api:model.emptyTitle')}</h2>
          <p>{t('api:model.emptyBody')}</p>
          <Link to={route.hub.index} className="sp-button sp-primary">
            {t('api:model.openHub')}
          </Link>
        </section>
      )}

      {showHelpers && (
        <section className="sp-panel" aria-label={t('api:model.helperTitle')}>
          <HelperModelFields
            embedding={embedding}
            decision={decision}
            choice={helperChoice}
            onChange={(next) => {
              setHelperDraft(next)
              setPhase('idle')
            }}
          />
        </section>
      )}

      {showSave && (
        <div className="sp-save">
          <span role="status">{statusText}</span>
          <ServerButton disabled={!dirty || restarting} onClick={discard}>
            {t('settings:serverConfig.discard')}
          </ServerButton>
          <ServerButton
            primary
            disabled={!dirty || restarting || control.isBusy}
            onClick={() => void save()}
          >
            {t('settings:serverConfig.save')}
          </ServerButton>
        </div>
      )}
    </>
  )
}

/** The core's `{code, message}`, or whatever else was thrown, as one line. */
function coreErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error)
    return String((error as { message: unknown }).message)
  return String(error)
}
