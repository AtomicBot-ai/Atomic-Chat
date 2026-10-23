import { getModelToStart } from './getModelToStart'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  isEmbeddingOnlyModel,
  type AnswerableModelLike,
} from '@/lib/answerable-model'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

/** A loaded id as the provider store lists it, or just the id when no provider does. */
function describeLoadedModel(modelId: string): AnswerableModelLike {
  for (const provider of useModelProvider.getState().providers) {
    const model = provider?.models?.find(
      (m: { id: string }) => m.id === modelId
    )
    if (model) return model
  }
  return { id: modelId }
}

export type EnsureModelResult =
  | { status: 'already_loaded'; modelId: string; providerName: string }
  | { status: 'loaded'; modelId: string; providerName: string }
  | { status: 'no_model_available' }

export interface EnsureModelDeps {
  /** Models service — typically `serviceHub.models()` */
  modelsService: {
    getActiveModels(provider?: string): Promise<string[]>
    stopModel(model: string, provider?: string): Promise<unknown>
    startModel(
      provider: ModelProvider,
      model: string,
      bypassAutoUnload?: boolean
    ): Promise<unknown>
  }
  /** Override the model to load (e.g. user-configured default model). */
  modelOverride?: { model: string; provider: string } | null
  onLoadStart?: () => void
  onLoadEnd?: () => void
}

/**
 * Find the provider that owns a given model ID. Both llama.cpp providers list
 * every GGUF from the shared models dir, so prefer an active provider before
 * settling for a deactivated one (e.g. TurboQuant, disabled on fresh installs).
 */
export function findProviderForModel(modelId: string): ModelProvider | undefined {
  const { providers } = useModelProvider.getState()
  const owns = (p: ModelProvider) =>
    p?.models?.some((m: { id: string }) => m.id === modelId)
  return (
    providers.find((p) => p?.active !== false && owns(p)) ??
    providers.find(owns)
  )
}

/**
 * The provider whose engine holds the loaded session of `modelId`.
 *
 * Owning the id says nothing about which provider runs it: both llama.cpp
 * providers list the same models folder, and the first owner is the
 * TurboQuant one. Each engine reports only its own sessions
 * (`getActiveModels(provider)`), so ask the owners. `preferredProvider` (the
 * server's default) is asked first and wins when both hold the model; when no
 * engine claims it, it is still the answer if it owns the id, and
 * {@link findProviderForModel} after that.
 */
export async function findServingProvider(
  modelId: string,
  modelsService: Pick<EnsureModelDeps['modelsService'], 'getActiveModels'>,
  preferredProvider?: string
): Promise<ModelProvider | undefined> {
  const { providers } = useModelProvider.getState()
  const owners = providers.filter((p) =>
    p?.models?.some((m: { id: string }) => m.id === modelId)
  )
  const preferred = owners.find((p) => p.provider === preferredProvider)
  const candidates = preferred
    ? [preferred, ...owners.filter((p) => p !== preferred)]
    : owners

  for (const provider of candidates) {
    const loaded = await modelsService
      .getActiveModels(provider.provider)
      .catch(() => [] as string[])
    if (loaded?.includes(modelId)) return provider
  }
  return preferred ?? findProviderForModel(modelId)
}

/**
 * The `{ model, provider }` pairs the server serves for `modelIds` (loaded
 * models), each named by the provider that actually runs it
 * ({@link findServingProvider}). Ids no provider owns are left out.
 */
export async function resolveServerModels(
  modelIds: string[],
  modelsService: Pick<EnsureModelDeps['modelsService'], 'getActiveModels'>,
  preferredProvider?: string
): Promise<{ model: string; provider: string }[]> {
  const resolved = await Promise.all(
    modelIds.map(async (model) => {
      const provider = await findServingProvider(
        model,
        modelsService,
        preferredProvider
      )
      return provider ? [{ model, provider: provider.provider }] : []
    })
  )
  return resolved.flat()
}

/**
 * Ensure a model is loaded for the local API server.
 *
 * - If a model is already loaded, returns immediately.
 * - If no model is loaded, picks one via {@link getModelToStart} and loads it.
 *
 * The model is started with its existing context size settings (no enforcement).
 */
export async function ensureModelForServer(
  deps: EnsureModelDeps
): Promise<EnsureModelResult> {
  const { modelsService, modelOverride, onLoadStart, onLoadEnd } = deps

  const loadedModels = await modelsService.getActiveModels()

  if (modelOverride) {
    const requestedProvider =
      useModelProvider.getState().getProviderByName(modelOverride.provider)
    const requestedIsLoaded = loadedModels.includes(modelOverride.model)

    if (requestedProvider && loadedModels.length > 0) {
      const modelsToStop = requestedIsLoaded
        ? loadedModels.filter((modelId) => modelId !== modelOverride.model)
        : loadedModels

      if (modelsToStop.length > 0) {
        await Promise.all(
          modelsToStop.map((modelId) => modelsService.stopModel(modelId))
        )
      }
    }

    if (requestedProvider && requestedIsLoaded) {
      return {
        status: 'already_loaded',
        modelId: modelOverride.model,
        providerName: requestedProvider.provider,
      }
    }
  }

  // An embedding session (project indexing loads one) is not a chat model the
  // server could answer with, so it never counts as "already loaded" (AC-01).
  const loadedChatModel = modelOverride
    ? undefined
    : loadedModels?.find((id) => !isEmbeddingOnlyModel(describeLoadedModel(id)))
  if (loadedChatModel) {
    const providerName =
      findProviderForModel(loadedChatModel)?.provider ?? LOCAL_LLAMACPP_PROVIDER
    return { status: 'already_loaded', modelId: loadedChatModel, providerName }
  }

  // No model loaded — pick one (prefer user-configured default, then auto-pick)
  const { selectedModel, selectedProvider, getProviderByName } =
    useModelProvider.getState()

  let modelToStart: { model: string; provider: ModelProvider } | null = null

  if (modelOverride) {
    const provider = getProviderByName(modelOverride.provider)
    if (provider && provider.models.some((m) => m.id === modelOverride.model)) {
      modelToStart = { model: modelOverride.model, provider }
    }
  }

  if (!modelToStart) {
    modelToStart = getModelToStart({
      selectedModel,
      selectedProvider,
      getProviderByName,
    })
  }

  if (!modelToStart) {
    return { status: 'no_model_available' }
  }

  onLoadStart?.()
  try {
    await modelsService.startModel(modelToStart.provider, modelToStart.model, true)
    await new Promise((resolve) => setTimeout(resolve, 500))
  } finally {
    onLoadEnd?.()
  }

  return {
    status: 'loaded',
    modelId: modelToStart.model,
    providerName: modelToStart.provider.provider,
  }
}
