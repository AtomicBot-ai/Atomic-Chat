import { useMemo } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useEnsureManagedPlans, useHeldManagedPlans } from '@/hooks/useManagedPlan'
import {
  managedHubState,
  UNKNOWN_HUB_STATE,
  type ManagedHubState,
} from '@/lib/managed-engine/hub-state'
import { managedEngines, type ManagedEngine } from '@/lib/managed-engines'
import {
  selectEnvironment,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * The managed engines in the Model Hub: whether each engine's format is offered and in which state
 * (design D2), every engine by its own plan — the one its provider page shows (`useManagedPlan`),
 * asked only where its provider is shown. In registry order, which is the order every list of
 * managed engines shows them in (change `add-vllm-runtime`, design D14).
 */
export function useManagedHubStates(): Array<{ engine: ManagedEngine; hub: ManagedHubState }> {
  const engines = managedEngines()
  const providers = useModelProvider((state) => state.providers)
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const plans = useHeldManagedPlans()
  const shown = useMemo(
    () =>
      engines
        .filter((engine) => providers.some((provider) => provider.provider === engine.id))
        .map((engine) => engine.id),
    [engines, providers]
  )
  useEnsureManagedPlans(shown)
  return useMemo(
    () =>
      engines.map((engine) => ({
        engine,
        hub: managedHubState({
          providerShown: shown.includes(engine.id),
          environment,
          installation: environment?.installations.find(
            (installation) => installation.engine_id === engine.id
          ),
          plan: plans[engine.id],
        }),
      })),
    [engines, shown, environment, plans]
  )
}

/** One managed engine in the Model Hub (`useManagedHubStates`). */
export function useManagedHubState(engineId: string): ManagedHubState {
  const states = useManagedHubStates()
  const own = states.find((entry) => entry.engine.id === engineId)
  return own?.hub ?? UNKNOWN_HUB_STATE
}
