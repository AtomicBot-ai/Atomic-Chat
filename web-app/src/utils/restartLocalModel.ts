import { useModelProvider } from '@/hooks/useModelProvider'
import type { ServiceHub } from '@/services'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

export async function restartLocalModel(
  serviceHub: ServiceHub,
  providerName: string,
  modelId: string
): Promise<void> {
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
  const activeModels = await serviceHub.models().getActiveModels()
  syncActiveModelsFromEngines(activeModels || [])
}
