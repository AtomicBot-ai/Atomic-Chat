import { describe, expect, it } from 'vitest'

import {
  deriveInferenceStatus,
  isBlockingInferenceStatus,
  modelLoadStageKey,
  type InferenceStatusInput,
} from '../inference-status'

const base: InferenceStatusInput = {
  selectedModelId: 'qwen3-8b',
  isLocalEngine: true,
  loadingModel: false,
  activeModels: [],
  hasLoadError: false,
}

const derive = (overrides: Partial<InferenceStatusInput> = {}) =>
  deriveInferenceStatus({ ...base, ...overrides })

describe('deriveInferenceStatus', () => {
  it('separates a cold start from an engine swap', () => {
    expect(
      derive({ loadingModel: true, loadingModelId: 'qwen3-8b' })
    ).toMatchObject({ phase: 'starting', modelId: 'qwen3-8b' })

    expect(
      derive({
        loadingModel: true,
        loadingModelId: 'qwen3-8b',
        loadingModelKind: 'restart',
      })
    ).toMatchObject({ phase: 'restarting', modelId: 'qwen3-8b' })
  })

  it('names the model being loaded, not the one selected', () => {
    // The picker settles on the target only once the switch completes.
    expect(
      derive({
        loadingModel: true,
        loadingModelId: 'gemma-4-12b',
        selectedModelId: 'qwen3-8b',
      })
    ).toMatchObject({ phase: 'starting', modelId: 'gemma-4-12b' })
  })

  it('reports a loaded model as ready', () => {
    expect(derive({ activeModels: ['qwen3-8b'] })).toEqual({
      phase: 'ready',
      modelId: 'qwen3-8b',
    })
  })

  it('reports a failed load rather than "not loaded"', () => {
    expect(
      derive({ hasLoadError: true, loadErrorModelId: 'qwen3-8b' })
    ).toEqual({ phase: 'failed', modelId: 'qwen3-8b' })
  })

  it("ignores a failure that belongs to a model the user has left", () => {
    expect(
      derive({ hasLoadError: true, loadErrorModelId: 'gemma-4-12b' })
    ).toEqual({ phase: 'notLoaded', modelId: 'qwen3-8b' })
  })

  it('lets a load in flight outrank a stale failure', () => {
    expect(
      derive({
        loadingModel: true,
        loadingModelId: 'qwen3-8b',
        hasLoadError: true,
        loadErrorModelId: 'qwen3-8b',
      })
    ).toMatchObject({ phase: 'starting', modelId: 'qwen3-8b' })
  })

  it('has nothing to report without a local engine', () => {
    expect(derive({ isLocalEngine: false })).toEqual({ phase: 'idle' })
    expect(derive({ selectedModelId: undefined })).toEqual({ phase: 'idle' })
    // The switch path flips `loadingModel` for a cloud model too, but there is
    // no engine here loading anything into memory.
    expect(
      derive({
        isLocalEngine: false,
        loadingModel: true,
        loadingModelId: 'qwen3-8b',
      })
    ).toEqual({ phase: 'idle' })
  })
})

describe('load progress (ATO-530)', () => {
  it('carries the step and a cancel in flight with a load', () => {
    expect(
      derive({
        loadingModel: true,
        loadingModelId: 'qwen3-8b',
        loadingModelProgress: { kind: 'loadingWeights', cachedFraction: 1 },
        loadingModelCancelling: true,
      })
    ).toEqual({
      phase: 'starting',
      modelId: 'qwen3-8b',
      progress: { kind: 'loadingWeights', cachedFraction: 1 },
      cancelling: true,
    })
  })

  it('reads as preparing before the switch has reported a step', () => {
    expect(
      derive({ loadingModel: true, loadingModelId: 'qwen3-8b' })
    ).toMatchObject({ progress: { kind: 'preparing' }, cancelling: false })
  })

  it('leaves a steady state without progress', () => {
    expect(
      derive({
        activeModels: ['qwen3-8b'],
        loadingModelProgress: { kind: 'startingServer' },
      })
    ).toEqual({ phase: 'ready', modelId: 'qwen3-8b' })
  })
})

describe('modelLoadStageKey', () => {
  it('tells a load from cache apart from a read off the disk', () => {
    expect(
      modelLoadStageKey({ kind: 'loadingWeights', cachedFraction: 0.95 })
    ).toBe('loadingCachedWeights')
    expect(
      modelLoadStageKey({ kind: 'loadingWeights', cachedFraction: 0.3 })
    ).toBe('readingWeightsFromDisk')
  })

  it('does not call an unknown cache state cold', () => {
    expect(
      modelLoadStageKey({ kind: 'loadingWeights', cachedFraction: null })
    ).toBe('loadingWeights')
  })

  it('names the retry over the step it retries', () => {
    expect(
      modelLoadStageKey({
        kind: 'loadingWeights',
        cachedFraction: 1,
        retry: 'ctx',
      })
    ).toBe('retry_ctx')
  })

  it('names every other step by its kind', () => {
    for (const kind of [
      'preparing',
      'unloadingPrevious',
      'installingEngine',
      'startingServer',
    ] as const) {
      expect(modelLoadStageKey({ kind })).toBe(kind)
    }
  })
})

describe('isBlockingInferenceStatus', () => {
  it('interrupts the chat view only when a reply cannot come', () => {
    expect(isBlockingInferenceStatus('starting')).toBe(true)
    expect(isBlockingInferenceStatus('restarting')).toBe(true)
    expect(isBlockingInferenceStatus('failed')).toBe(true)
    expect(isBlockingInferenceStatus('ready')).toBe(false)
    expect(isBlockingInferenceStatus('notLoaded')).toBe(false)
    expect(isBlockingInferenceStatus('idle')).toBe(false)
  })
})
