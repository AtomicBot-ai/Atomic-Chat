import type { ModelLoadProgress } from '@/lib/inference-status'

/** Every diagnostic stage, including cache and retry variants of weight loading. */
export const modelLoadStages = [
  { stage: 'preparing', progress: { kind: 'preparing' } },
  { stage: 'unloadingPrevious', progress: { kind: 'unloadingPrevious' } },
  { stage: 'installingEngine', progress: { kind: 'installingEngine' } },
  {
    stage: 'loadingWeights',
    progress: { kind: 'loadingWeights', cachedFraction: null },
  },
  {
    stage: 'loadingCachedWeights',
    progress: { kind: 'loadingWeights', cachedFraction: 1 },
  },
  {
    stage: 'readingWeightsFromDisk',
    progress: { kind: 'loadingWeights', cachedFraction: 0.1 },
  },
  { stage: 'startingServer', progress: { kind: 'startingServer' } },
  {
    stage: 'retry_ctx',
    progress: { kind: 'loadingWeights', cachedFraction: null, retry: 'ctx' },
  },
  {
    stage: 'retry_ngl',
    progress: { kind: 'loadingWeights', cachedFraction: null, retry: 'ngl' },
  },
  {
    stage: 'retry_fit_target',
    progress: {
      kind: 'loadingWeights',
      cachedFraction: null,
      retry: 'fit_target',
    },
  },
] satisfies { stage: string; progress: ModelLoadProgress }[]
