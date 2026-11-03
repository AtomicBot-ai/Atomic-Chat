import { localStorageKey } from '@/constants/localStorage'
import { isAnswerableModel, isEmbeddingOnlyModel } from '@/lib/answerable-model'
import type { ModelInfo } from '@janhq/core'

// Upstream llama.cpp first: it understands the full Gemma 4 projector set
// (`gemma4uv`/`gemma4ua`) that the turboquant fork doesn't yet carry, so the
// default vision model starts cleanly. TurboQuant (`llamacpp`) stays a
// manual macOS choice. See ADR 2026-06-09 (ATO-116). PrismML lists only the
// Bonsai files the core set up for it. Foundry Local (change add-foundry-local) and LiteRT-LM
// (change add-litert-lm-runtime) and GenieX (change add-geniex-runtime) are last: their models
// are a separate download, never a copy of a model another engine lists.
const localProviderNames = [
  'llamacpp-upstream',
  'llamacpp',
  'atomic-prism',
  'mlx',
  'foundry-local',
  'litert-lm',
  'geniex',
] as const

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

function findFirstLocalModel(
  getProviderByName: (name: string) => ModelProvider | undefined
): { model: string; provider: ModelProvider } | null {
  for (const name of localProviderNames) {
    const provider = getProviderByName(name)

    // Skip broken-link models (weights file gone) — loading them only crashes
    // — and embedding models, which cannot chat.
    const firstUsable = provider?.models?.find(isAnswerableModel)
    // A deactivated provider (Settings → Model Providers toggle) must never
    // be auto-started — e.g. TurboQuant ships disabled on fresh installs.
    if (provider && provider.active !== false && firstUsable) {
      return { model: firstUsable.id, provider }
    }
  }
  return null
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
    const lastModel = provider?.models.find((m) => m.id === lastUsedModel.model)

    // A broken-link last-used model must not be reloaded, and a last-used
    // model on a since-deactivated provider must not resurrect that provider
    // — fall through to a healthy one.
    if (
      provider &&
      provider.active !== false &&
      lastModel &&
      !(lastModel as { missing?: boolean }).missing &&
      // A last-used embedding model is what the AC-01 bug left behind.
      !isEmbeddingOnlyModel(lastModel)
    ) {
      return { model: lastUsedModel.model, provider }
    } else {
      const fallback = findFirstLocalModel(getProviderByName)
      if (fallback) return fallback
    }
  }

  // Use selected model if available
  if (selectedModel && selectedProvider) {
    const provider = getProviderByName(selectedProvider)
    // A stale persisted selection may point at a deactivated provider.
    if (provider && provider.active !== false) {
      return { model: selectedModel.id, provider }
    }
  }

  return findFirstLocalModel(getProviderByName)
}
