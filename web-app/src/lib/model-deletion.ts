/**
 * Removing a model from a provider, shared by every entry point that offers it
 * (the Hub download panel, Settings → Model Providers, the cloud model list).
 *
 * Kept in one place because the order matters: the caches must not be updated
 * before the engine confirms the files are gone, or a failed delete leaves the
 * row hidden until the next provider refresh brings it back — which reads as
 * "the model won't delete" with nothing to explain why.
 */

import { useAppState } from '@/hooks/useAppState'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ServiceHub } from '@/services'
import type { ModelDeletionReport } from '@/services/models/types'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

/**
 * Delete a model and reconcile the app state around it.
 *
 * Only local providers (llama.cpp, MLX, …) own weights on disk and register an
 * inference engine, so only they go through `stopModel` + `deleteModel`. A
 * cloud or self-hosted provider (OpenRouter, a custom OpenAI-compatible
 * endpoint) has no engine — asking for one used to reject with "No engine
 * registered for provider" (#264) — and removing its model is purely a
 * store-level tombstone.
 *
 * Rejects when a local engine refuses (unknown model, missing `model.yml`, a
 * TensorRT-LLM model the core could not stop); the caller is expected to
 * surface that. Resolves with what the engine freed when it measured it.
 */
export async function deleteLocalModel(
  serviceHub: ServiceHub,
  modelId: string,
  provider: string
): Promise<ModelDeletionReport | void> {
  let report: ModelDeletionReport | void = undefined
  if (isLocalProvider(provider)) {
    // TensorRT-LLM's delete goes to the core, which stops the model itself and
    // deletes nothing until Docker confirms the stop (design D12a). Unloading
    // here first would mark the model stopped even when that stop fails and
    // the delete is refused, so it is left active until the delete succeeds.
    const stopsInCore = provider === 'tensorrt-llm'
    // A loaded model holds its weights open and keeps showing up as active in
    // the model picker, so unload it before the files go away. A failure here
    // is not fatal to the delete itself.
    const { activeModels, setActiveModels } = useAppState.getState()
    if (!stopsInCore && activeModels.includes(modelId)) {
      await serviceHub
        .models()
        .stopModel(modelId, provider)
        .catch((error) => {
          console.error('[deleteLocalModel] stopModel failed:', error)
        })
      setActiveModels(activeModels.filter((id) => id !== modelId))
    }

    report = await serviceHub.models().deleteModel(modelId, provider)

    if (stopsInCore) {
      const state = useAppState.getState()
      state.setActiveModels(state.activeModels.filter((id) => id !== modelId))
    }
  }

  useFavoriteModel.getState().removeFavorite(modelId)
  useModelProvider.getState().deleteModel(modelId)

  // Re-list the engines so a model the other llama.cpp provider also registered
  // (both read the same models directory) disappears too.
  const providers = await serviceHub.providers().getProviders()
  useModelProvider.getState().setProviders(
    providers.map((entry) => ({
      ...entry,
      models: entry.models.filter((model) => model.id !== modelId),
    }))
  )
  return report
}
