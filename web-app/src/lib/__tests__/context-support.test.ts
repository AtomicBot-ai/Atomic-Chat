import { afterEach, describe, expect, it } from 'vitest'

import {
  contextResizeMode,
  contextSupport,
  growsAfterError,
  isLengthContextOverflow,
  knownContextWindow,
} from '@/lib/context-support'
import { canGrowContext } from '@/lib/managed-engine/chat'
import { DEFAULT_CTX_LEN } from '@janhq/core'
import {
  setManagedEnginesForTests,
  TENSORRT_LLM_ENGINE,
} from '@/lib/managed-engines'

describe('contextSupport', () => {
  // The same table as the core's `contextResizeMode` (`@atomic-chat/core/contracts`).
  it.each([
    ['llamacpp-upstream', 'reload', true],
    ['llamacpp', 'reload', true],
    ['atomic-prism', 'reload', true],
    ['mlx', 'reload', true],
    ['tensorrt-llm', 'restart', false],
    ['vllm', 'restart', false],
    ['sglang', 'restart', false],
    ['strata', 'restart', false],
    ['fastflowlm', 'restart', false],
    ['geniex', 'restart', false],
    ['litert-lm', 'restart', false],
    ['foundry-local', 'fixed', false],
    ['foundation-models', 'fixed', false],
    ['openai', undefined, false],
    ['anthropic', undefined, false],
    ['openrouter', undefined, false],
    ['my-custom-endpoint', undefined, false],
    [undefined, undefined, false],
  ] as const)(
    '%s resizes by %s (grows by itself: %s)',
    (provider, resize, canExpand) => {
      expect(contextResizeMode(provider)).toBe(resize)
      expect(contextSupport(provider)).toEqual({ resize, canExpand })
      // The growth gate every caller already uses agrees with it.
      expect(canGrowContext(provider)).toBe(canExpand)
    }
  )

  describe('a managed engine registered later', () => {
    afterEach(() => setManagedEnginesForTests(undefined))

    it('restarts like every managed engine', () => {
      setManagedEnginesForTests([
        { id: 'second-engine', label: 'Second', i18n: 'second' },
        TENSORRT_LLM_ENGINE,
      ])
      expect(contextSupport('second-engine')).toEqual({
        resize: 'restart',
        canExpand: false,
      })
    })
  })
})

describe('growsAfterError (the thread page’s automatic growth)', () => {
  const overflow = new Error(
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."
  )
  const codeOnly = Object.assign(new Error('Bad Request'), {
    data: { error: { code: 'context_length_exceeded' } },
  })

  it('grows a local engine that reloads after its overflow', () => {
    expect(
      growsAfterError({
        providerId: 'llamacpp-upstream',
        error: new Error('the request exceeds the available context size.'),
        autoIncrease: true,
      })
    ).toBe(true)
    expect(
      growsAfterError({
        providerId: 'mlx',
        error: codeOnly,
        autoIncrease: true,
      })
    ).toBe(true)
  })

  it.each([['openai'], ['anthropic'], ['openrouter'], ['my-custom-endpoint']])(
    'never grows a cloud model (%s) after its overflow',
    (providerId) => {
      expect(
        growsAfterError({ providerId, error: overflow, autoIncrease: true })
      ).toBe(false)
      expect(
        growsAfterError({ providerId, error: codeOnly, autoIncrease: true })
      ).toBe(false)
    }
  )

  it('never grows an engine that must restart or keeps its window', () => {
    for (const providerId of [
      'tensorrt-llm',
      'vllm',
      'strata',
      'foundry-local',
    ]) {
      expect(
        growsAfterError({ providerId, error: overflow, autoIncrease: true })
      ).toBe(false)
    }
  })

  it('respects auto-increase off and ignores other failures', () => {
    expect(
      growsAfterError({
        providerId: 'llamacpp-upstream',
        error: overflow,
        autoIncrease: false,
      })
    ).toBe(false)
    expect(
      growsAfterError({
        providerId: 'llamacpp-upstream',
        error: new Error('connection refused'),
        autoIncrease: true,
      })
    ).toBe(false)
    expect(
      growsAfterError({
        providerId: 'llamacpp-upstream',
        error: undefined,
        autoIncrease: true,
      })
    ).toBe(false)
  })
})

describe('knownContextWindow', () => {
  it('is the model’s ctx_len for any local engine', () => {
    expect(knownContextWindow('llamacpp-upstream', 32768)).toBe(32768)
    expect(knownContextWindow('vllm', 8192)).toBe(8192)
  })

  it('falls back to the engine default only for an engine that reloads', () => {
    expect(knownContextWindow('llamacpp-upstream', undefined)).toBe(
      DEFAULT_CTX_LEN
    )
    expect(knownContextWindow('vllm', undefined)).toBeUndefined()
  })

  it('is unknown for a cloud provider, whatever ctx_len a model carries', () => {
    expect(knownContextWindow('openai', undefined)).toBeUndefined()
    expect(knownContextWindow('openai', 8192)).toBeUndefined()
  })
})

describe('isLengthContextOverflow', () => {
  it('reads a long local turn that filled the window as an overflow', () => {
    expect(
      isLengthContextOverflow({
        providerId: 'llamacpp-upstream',
        ctxLen: 8192,
        totalTokens: 8000,
      })
    ).toEqual({ overflow: true, window: 8192 })
  })

  it('reads a local turn short of the window as its own answer cap', () => {
    expect(
      isLengthContextOverflow({
        providerId: 'mlx',
        ctxLen: 65536,
        totalTokens: 4000,
      }).overflow
    ).toBe(false)
  })

  it('measures against the window the core reported for the session', () => {
    // A managed engine whose model names no window: the core knows it.
    expect(
      isLengthContextOverflow({
        providerId: 'vllm',
        ctxLen: undefined,
        windowTokens: 8192,
        totalTokens: 8000,
      })
    ).toEqual({ overflow: true, window: 8192 })
    expect(
      isLengthContextOverflow({
        providerId: 'openai',
        ctxLen: undefined,
        windowTokens: 8192,
        totalTokens: 8000,
      })
    ).toEqual({ overflow: false, window: undefined })
  })

  it('never reads a cloud model’s `length` as an overflow', () => {
    // Before: the cloud model was measured against DEFAULT_CTX_LEN and the
    // page wrote a made-up ctx_len onto it.
    expect(
      isLengthContextOverflow({
        providerId: 'openai',
        ctxLen: undefined,
        totalTokens: 1_000_000,
      })
    ).toEqual({ overflow: false, window: undefined })
  })
})
