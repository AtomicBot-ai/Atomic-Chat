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
 * Rejects when a local engine refuses (unknown model, missing `model.yml`);
 * the caller is expected to surface that.
 */
export async function deleteLocalModel(
  serviceHub: ServiceHub,
  modelId: string,
  provider: string
): Promise<void> {
  if (isLocalProvider(provider)) {
    // A loaded model holds its weights open and keeps showing up as active in
    // the model picker, so unload it before the files go away. A failure here
    // is not fatal to the delete itself.
    const { activeModels, setActiveModels } = useAppState.getState()
    if (activeModels.includes(modelId)) {
      await serviceHub
        .models()
        .stopModel(modelId, provider)
        .catch((error) => {
          console.error('[deleteLocalModel] stopModel failed:', error)
        })
      setActiveModels(activeModels.filter((id) => id !== modelId))
    }

    await serviceHub.models().deleteModel(modelId, provider)
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
}
