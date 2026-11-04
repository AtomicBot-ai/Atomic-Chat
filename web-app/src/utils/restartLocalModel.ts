import { useModelProvider } from '@/hooks/useModelProvider'
import { trackSettingsRestart } from '@/lib/settings-restart'
import type { ServiceHub } from '@/services'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

/**
 * Restarts a loaded local model so a changed setting takes effect. Every
 * caller is a settings change, so the restart is marked as one: a chat turn
 * it cuts off says the settings change restarted the model.
 */
export async function restartLocalModel(
  serviceHub: ServiceHub,
  providerName: string,
  modelId: string
): Promise<void> {
  await trackSettingsRestart(providerName, modelId, async () => {
    const unloadResult = await serviceHub
      .models()
      .stopModel(modelId, providerName)
    if (unloadResult && !unloadResult.success) {
      throw new Error(unloadResult.error || `Failed to stop model '${modelId}'`)
    }

    const provider = useModelProvider.getState().getProviderByName(providerName)
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`)
    }

    await serviceHub.models().startModel(provider, modelId, true)
  })
  const activeModels = await serviceHub.models().getActiveModels()
  syncActiveModelsFromEngines(activeModels || [])
}
