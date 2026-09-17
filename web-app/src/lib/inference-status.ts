/**
 * What the local inference server is doing, as one value the UI can render.
 *
 * ATO-535: the only signal used to be a coloured dot next to the model name,
 * with its explanation hidden in a tooltip. When a reply did not come back
 * there was no way to tell a model still loading from a server restarting
 * from one that never started at all — and an auto-started load that failed
 * raised no toast, so it left a dead UI and nothing else.
 *
 * This derives that answer from the state the switch path already keeps, so
 * there is one status system rather than two that can disagree.
 */

export type InferenceStatusPhase =
  /** No local engine in play — no model picked, or a remote provider. */
  | 'idle'
  /** A local model is selected but not in memory: nothing is loading either. */
  | 'notLoaded'
  /** Loading into an engine that was not serving anything. */
  | 'starting'
  /** Swapping a serving engine — another local model, or another backend. */
  | 'restarting'
  /** In memory and answering. */
  | 'ready'
  /** The load ended in an error, and the model is not serving. */
  | 'failed'

/**
 * The step a load in flight is on (ATO-530). The engine reports the two steps
 * inside its own load; the switch reports the ones around it.
 */
export type ModelLoadStep =
  /** Before anything more specific is known. */
  | { kind: 'preparing' }
  /** The model that was serving is being taken out of memory first. */
  | { kind: 'unloadingPrevious' }
  /** The engine build is missing and is being downloaded. */
  | { kind: 'installingEngine' }
  /** The weights are being read; `cachedFraction` says from where. */
  | { kind: 'loadingWeights'; cachedFraction: number | null }
  /** The model is up; the Local API Server is being pointed at it. */
  | { kind: 'startingServer' }

/**
 * A step, and — after an out-of-memory failure — what the retry changed. The
 * retry is a different wait from the first attempt, so it is said out loud.
 */
export type ModelLoadProgress = ModelLoadStep & {
  retry?: 'ctx' | 'ngl' | 'fit_target'
}

/**
 * How much of the model the OS must already hold in memory for a load to
 * count as coming from cache. Below it, most of the wait is disk reads.
 */
export const CACHED_LOAD_FRACTION = 0.9

/**
 * The `common:modelLoad.stage.*` key that describes `progress`. Pure so the
 * choice — a retry outranks the step it retries, an unknown cache state is
 * not reported as a cold one — is pinned by tests rather than by a component.
 */
export function modelLoadStageKey(progress: ModelLoadProgress): string {
  if (progress.retry) return `retry_${progress.retry}`
  switch (progress.kind) {
    case 'loadingWeights':
      if (progress.cachedFraction === null) return 'loadingWeights'
      return progress.cachedFraction >= CACHED_LOAD_FRACTION
        ? 'loadingCachedWeights'
        : 'readingWeightsFromDisk'
    default:
      return progress.kind
  }
}

export type InferenceStatus = {
  phase: InferenceStatusPhase
  /** The model the phase is about: the one loading, or the one selected. */
  modelId?: string
  /** For `starting` / `restarting`: the step the load is on. */
  progress?: ModelLoadProgress
  /** For `starting` / `restarting`: the user asked for the load to stop. */
  cancelling?: boolean
}

export type InferenceStatusInput = {
  /** The model the composer is pointed at. */
  selectedModelId?: string
  /** True when the selected provider runs the model on this machine. */
  isLocalEngine: boolean
  loadingModel: boolean
  loadingModelId?: string
  loadingModelKind?: 'start' | 'restart'
  loadingModelProgress?: ModelLoadProgress
  loadingModelCancelling?: boolean
  activeModels: string[]
  /** Set whenever a load fails, including loads that raise no toast. */
  hasLoadError: boolean
  /** Which model {@link hasLoadError} belongs to; the error carries no id. */
  loadErrorModelId?: string
}

/**
 * A load in flight wins over everything else: it is the state the user is
 * waiting on. After that a failure outranks "not loaded", because "not
 * loaded" would read as a choice the user made rather than something that
 * went wrong.
 */
export function deriveInferenceStatus(
  input: InferenceStatusInput
): InferenceStatus {
  const {
    selectedModelId,
    isLocalEngine,
    loadingModel,
    loadingModelId,
    loadingModelKind,
    loadingModelProgress,
    loadingModelCancelling,
    activeModels,
    hasLoadError,
    loadErrorModelId,
  } = input

  // A remote model has no engine on this machine to report on — the switch
  // path still flips `loadingModel` for one, but "loading into memory" would
  // be a lie about somebody else's server. And the picker has not settled on
  // anything yet when there is no selection.
  if (!selectedModelId || !isLocalEngine) return { phase: 'idle' }

  if (loadingModel) {
    return {
      phase: loadingModelKind === 'restart' ? 'restarting' : 'starting',
      modelId: loadingModelId ?? selectedModelId,
      progress: loadingModelProgress ?? { kind: 'preparing' },
      cancelling: !!loadingModelCancelling,
    }
  }

  if (activeModels.includes(selectedModelId)) {
    return { phase: 'ready', modelId: selectedModelId }
  }

  // An error from a *different* model says nothing about this one — the user
  // may well have switched away from the one that failed.
  if (hasLoadError && loadErrorModelId === selectedModelId) {
    return { phase: 'failed', modelId: selectedModelId }
  }

  return { phase: 'notLoaded', modelId: selectedModelId }
}

/**
 * Whether this phase explains why a reply is not coming. `ready` and
 * `notLoaded` are steady states the model picker already shows. Of these
 * three, a load in flight is told by the loading snackbar (ATO-530); only
 * `failed` stays above the composer.
 */
export function isBlockingInferenceStatus(phase: InferenceStatusPhase): boolean {
  return phase === 'starting' || phase === 'restarting' || phase === 'failed'
}
