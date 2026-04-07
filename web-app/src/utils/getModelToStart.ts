import { localStorageKey } from '@/constants/localStorage'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import type { ModelInfo } from '@janhq/core'

export const getLastUsedModel = (): {
  provider: string
  model: string
} | null => {
  try {
    const stored = localStorage.getItem(localStorageKey.lastUsedModel)
    return stored ? JSON.parse(stored) : null
  } catch (error) {
    console.debug('Failed to get last used model from localStorage:', error)
    return null
  }
}

// Helper function to determine which model to start
export const getModelToStart = (params: {
  selectedModel?: ModelInfo | null
  selectedProvider?: string | null
  getProviderByName: (name: string) => ModelProvider | undefined
}): { model: string; provider: ModelProvider } | null => {
  const { selectedModel, selectedProvider, getProviderByName } = params

  // Use last used model if available
  const lastUsedModel = getLastUsedModel()
  if (lastUsedModel) {
    const provider = getProviderByName(lastUsedModel.provider)
    if (provider && provider.models.some((m) => m.id === lastUsedModel.model)) {
      return { model: lastUsedModel.model, provider }
    } else {
      const llamacppProvider = getProviderByName('llamacpp')
      const firstUsable = llamacppProvider?.models?.find(
        (m) => m.id !== EMBEDDING_MODEL_ID
      )
      if (llamacppProvider && firstUsable) {
        return { model: firstUsable.id, provider: llamacppProvider }
      }
    }
  }

  // Use selected model if available
  if (selectedModel && selectedProvider) {
    const provider = getProviderByName(selectedProvider)
    if (provider) {
      return { model: selectedModel.id, provider }
    }
  }

  const llamacppProvider = getProviderByName('llamacpp')
  const firstUsable = llamacppProvider?.models?.find(
    (m) => m.id !== EMBEDDING_MODEL_ID
  )
  if (llamacppProvider && firstUsable) {
    return { model: firstUsable.id, provider: llamacppProvider }
  }

  return null
}
