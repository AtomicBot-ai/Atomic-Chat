import { useMemo } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  deriveInferenceStatus,
  type InferenceStatus,
} from '@/lib/inference-status'
import { LOCAL_PROVIDER_NAMES } from '@/utils/registerRemoteProvider'

/**
 * The local inference server's state, assembled from the stores the switch
 * path already writes. See `deriveInferenceStatus` for the rules.
 */
export const useInferenceStatus = (): InferenceStatus => {
  const selectedModelId = useModelProvider((state) => state.selectedModel?.id)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const loadingModel = useAppState((state) => state.loadingModel)
  const loadingModelId = useAppState((state) => state.loadingModelId)
  const loadingModelKind = useAppState((state) => state.loadingModelKind)
  const loadingModelProgress = useAppState(
    (state) => state.loadingModelProgress
  )
  const loadingModelCancelling = useAppState(
    (state) => state.loadingModelCancelling
  )
  const activeModels = useAppState((state) => state.activeModels)
  const modelLoadError = useModelLoad((state) => state.modelLoadError)
  const loadErrorModelId = useModelLoad((state) => state.modelLoadErrorModelId)

  return useMemo(
    () =>
      deriveInferenceStatus({
        selectedModelId,
        isLocalEngine: (LOCAL_PROVIDER_NAMES as readonly string[]).includes(
          selectedProvider
        ),
        loadingModel: !!loadingModel,
        loadingModelId,
        loadingModelKind,
        loadingModelProgress,
        loadingModelCancelling,
        activeModels,
        hasLoadError: !!modelLoadError,
        loadErrorModelId,
      }),
    [
      selectedModelId,
      selectedProvider,
      loadingModel,
      loadingModelId,
      loadingModelKind,
      loadingModelProgress,
      loadingModelCancelling,
      activeModels,
      modelLoadError,
      loadErrorModelId,
    ]
  )
}
