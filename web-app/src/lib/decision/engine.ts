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
import type { DecisionCoreError } from '@/services/decision/types'

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

/**
 * What the user can do about a failed start: install or update the engine,
 * start again, or neither (the model or the settings are wrong, and the
 * message says how to fix them).
 */
export type DecisionErrorAction = 'install' | 'retry' | 'none'

/** Failures a second start cannot fix. */
const CONFIGURATION_CODES: ReadonlySet<string> = new Set([
  'DECISION_NOT_CONFIGURED',
  'DECISION_CHECKPOINT_INCOMPLETE',
  'MODEL_FILE_NOT_FOUND',
  'DECISION_MODEL_NOT_CHAT',
])

/**
 * A `DECISION_ENGINE_UNSUPPORTED` whose evidence is a `-h` probe that could
 * not run (`<build>: probe failed: …` in the details). Cores up to 0.11.2
 * reported a probe that timed out or crashed this way; later ones fail the
 * start with the probe's own code instead. Either way nothing shows the
 * engine cannot run the model.
 */
export function isUncheckedEngineError(error: DecisionCoreError): boolean {
  return (
    error.code === 'DECISION_ENGINE_UNSUPPORTED' &&
    (error.details ?? '')
      .split('\n')
      .some((line) => line.includes(': probe failed: '))
  )
}

/**
 * `install` only when the core finished checking the engine and it cannot run
 * the model; a start that timed out or failed (`MODEL_LOAD_TIMED_OUT`,
 * `MODEL_LOAD_FAILED`, an engine that could not be checked) is worth a retry.
 */
export function decisionErrorAction(
  error: DecisionCoreError
): DecisionErrorAction {
  if (CONFIGURATION_CODES.has(error.code)) return 'none'
  if (error.code === 'DECISION_ENGINE_UNSUPPORTED')
    return isUncheckedEngineError(error) ? 'retry' : 'install'
  return 'retry'
}
