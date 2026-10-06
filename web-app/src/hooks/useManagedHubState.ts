import { useModelProvider } from '@/hooks/useModelProvider'
import { useManagedPlan } from '@/hooks/useManagedPlan'
import { managedHubState, type ManagedHubState } from '@/lib/managed-engine/hub-state'
import {
  selectEnvironment,
  selectInstallation,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * A managed engine in the Model Hub: whether its format is offered and in which state (design D2).
 * The plan is the engine's provider page's own (`useManagedPlan`), asked only where the provider is
 * shown.
 */
export function useManagedHubState(engineId: string): ManagedHubState {
  const providerShown = useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === engineId)
  )
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const installation = useManagedEnvironmentStore((state) => selectInstallation(state, engineId))
  const { plan } = useManagedPlan(engineId, { enabled: providerShown })
  return managedHubState({ providerShown, environment, installation, plan })
}
