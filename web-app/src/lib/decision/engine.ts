/**
 * Which engine runs a decision model, and whether the installed build is new
 * enough for it.
 *
 * TurboQuant (`llamacpp`) is gated by the core alone: whether a build serves
 * `--decision` is known only from its `-h`, so the app shows the core's
 * `DECISION_ENGINE_UNSUPPORTED` after a start. Stock llama.cpp
 * (`llamacpp-upstream`) is gated by its build number, which the app can read
 * from the provider's `version_backend` (`b11436/macos-arm64`): a model whose
 * `min_engine` is newer than the configured build is shown as needing an
 * update before anyone presses Start. The core keeps the last word: it runs
 * the newest installed upstream build at the floor, whichever is configured
 * for chat.
 */

import type { UseBackendUpdaterConfig } from '@/hooks/useBackendUpdater'
import type {
  DecisionCatalogModel,
  DecisionEngine,
} from '@/services/decision-catalog-registry'

/** Per engine: its backend updater and its name in the UI. */
export const DECISION_ENGINE_UI: Readonly<
  Record<DecisionEngine, { updater: UseBackendUpdaterConfig; name: string }>
> = {
  'llamacpp': {
    updater: {
      extensionName: '@janhq/llamacpp-extension',
      providerId: 'llamacpp',
      recommendationKey: 'turboquant_better_backend_recommendation',
      postUpgradeRecheckEnabled: false,
    },
    name: 'TurboQuant',
  },
  // The default updater configuration is stock llama.cpp's.
  'llamacpp-upstream': { updater: {}, name: 'llama.cpp' },
}

/** `b11436` or `b11436/macos-arm64` → 11436; a fork or legacy tag → `undefined`. */
export function upstreamBuildOf(
  versionBackend: string | undefined
): number | undefined {
  const match = /^b(\d+)(?:\/|$)/.exec((versionBackend ?? '').trim())
  return match ? Number(match[1]) : undefined
}

export type DecisionEngineReadiness =
  | { kind: 'ready' }
  /** The configured stock llama.cpp build is older than the model's floor. */
  | { kind: 'needs_update'; required: string }

/**
 * Whether the configured stock llama.cpp build (`versionBackend`) reaches
 * `minEngine` (`b<build>`). No floor, or an unknown configured build, is not
 * held against the model: the core decides. Embedding models share it.
 */
export function upstreamEngineReadiness(
  minEngine: string | undefined,
  versionBackend: string | undefined
): DecisionEngineReadiness {
  if (!minEngine) return { kind: 'ready' }
  const need = upstreamBuildOf(minEngine)
  const have = upstreamBuildOf(versionBackend)
  if (need === undefined || have === undefined || have >= need)
    return { kind: 'ready' }
  return { kind: 'needs_update', required: minEngine }
}

/**
 * Whether `model` can start on the build configured for its engine
 * (`versionBackend`, the provider's `version_backend`). Only stock llama.cpp
 * models are checked here; an unknown configured build is not held against
 * the model, the core decides.
 */
export function decisionEngineReadiness(
  model: DecisionCatalogModel,
  versionBackend: string | undefined
): DecisionEngineReadiness {
  if (model.engine !== 'llamacpp-upstream') return { kind: 'ready' }
  return upstreamEngineReadiness(model.min_engine, versionBackend)
}
