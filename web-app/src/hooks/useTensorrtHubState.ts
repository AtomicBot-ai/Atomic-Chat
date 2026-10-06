import { useModelProvider } from '@/hooks/useModelProvider'
import { useTensorrtPlan } from '@/hooks/useTensorrtPlan'
import { tensorrtHubState, type TensorrtHubState } from '@/lib/tensorrt-llm/hub-state'
import {
  selectEnvironment,
  selectTensorrtInstallation,
  TENSORRT_LLM_ENGINE_ID,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * TensorRT-LLM in the Model Hub: whether the format is offered and in which state (design D2).
 * The plan is the provider page's own (`useTensorrtPlan`), asked only where the provider is shown.
 */
export function useTensorrtHubState(): TensorrtHubState {
  const providerShown = useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === TENSORRT_LLM_ENGINE_ID)
  )
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const installation = useManagedEnvironmentStore(selectTensorrtInstallation)
  const { plan } = useTensorrtPlan({ enabled: providerShown })
  return tensorrtHubState({ providerShown, environment, installation, plan })
}
