import { useModelProvider } from '@/hooks/useModelProvider'
import {
  decisionEngineReadiness,
  type DecisionEngineReadiness,
} from '@/lib/decision/engine'
import type {
  DecisionCatalogModel,
  DecisionEngine,
} from '@/services/decision-catalog-registry'

/** The `version_backend` configured for `provider`, e.g. `b11344/macos-arm64`. */
export function useEngineVersionBackend(
  provider: DecisionEngine
): string | undefined {
  return useModelProvider((state) => {
    const value = state.providers
      .find((item) => item.provider === provider)
      ?.settings.find((setting) => setting.key === 'version_backend')
      ?.controller_props?.value
    return typeof value === 'string' ? value : undefined
  })
}

/** Whether the build configured for `model`'s engine is new enough to start it. */
export function useDecisionEngineReadiness(
  model: DecisionCatalogModel
): DecisionEngineReadiness {
  return decisionEngineReadiness(model, useEngineVersionBackend(model.engine))
}
