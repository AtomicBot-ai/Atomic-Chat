import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agentModelBlockReason,
  canGrowContext,
  contextOverflowGuidance,
  contextOverflowMessage,
  engineStageText,
  imageAttachmentsAllowed,
  loadWatchdogMs,
} from '../chat'
import { setManagedEnginesForTests, TENSORRT_LLM_ENGINE } from '@/lib/managed-engines'

const model = (capabilities: string[]) => ({ id: 'qwen3-8b', capabilities }) as unknown as Model

describe('agentModelBlockReason', () => {
  it('keeps a TensorRT-LLM model without tool calling out of Agent mode', () => {
    // spec "Модель без tools в Agent-режиме".
    expect(agentModelBlockReason('tensorrt-llm', model([]))).toBe('model-without-tools')
    expect(agentModelBlockReason('tensorrt-llm', model(['tools']))).toBeNull()
  })

  it('leaves every other provider to its own rules', () => {
    // The agent speaks a text tool contract to llama.cpp and MLX, whatever the model declares.
    expect(agentModelBlockReason('llamacpp-upstream', model([]))).toBeNull()
    expect(agentModelBlockReason('tensorrt-llm', undefined)).toBeNull()
  })
})

describe('canGrowContext', () => {
  it('never grows a TensorRT-LLM context: it is fixed when the container starts', () => {
    expect(canGrowContext('tensorrt-llm')).toBe(false)
    expect(canGrowContext('llamacpp-upstream')).toBe(true)
    expect(canGrowContext('mlx')).toBe(true)
  })
})

describe('contextOverflowGuidance', () => {
  const overflow = new Error(
    "This model's maximum context length is 8192 tokens. However, you requested 9120 tokens. [context_length_exceeded]"
  )

  it('shows the limit the engine reported and points at the context length setting', () => {
    const guidance = contextOverflowGuidance('tensorrt-llm', overflow)

    expect(guidance?.limit).toBe(8192)
    expect(guidance?.detail).toContain('9120')
  })

  it('tells the person the limit and where to raise it, instead of growing the context by itself', () => {
    // spec tensorrt-llm-desktop: `context_length_exceeded` → the limit and an offer to increase it.
    const message = contextOverflowMessage(contextOverflowGuidance('tensorrt-llm', overflow)!)

    expect(message).toContain('8192')
    expect(message).toContain('9120')
    expect(message).toContain('Context Length')
    expect(message).toContain('restart')
  })

  it('has nothing to add for other providers or other errors', () => {
    expect(contextOverflowGuidance('llamacpp-upstream', overflow)).toBeNull()
    expect(contextOverflowGuidance('tensorrt-llm', new Error('connection refused'))).toBeNull()
  })
})

describe('engineStageText', () => {
  it('names the stage and the time spent, in minutes once it gets long', () => {
    expect(engineStageText({ stage: 'initializing-engine', elapsedMs: 42_000 })).toEqual({
      key: 'common:modelLoad.engine.initializing-engine',
      elapsed: '0:42',
    })
    expect(engineStageText({ stage: 'starting-container', elapsedMs: 185_000 }).elapsed).toBe('3:05')
  })
})

describe('imageAttachmentsAllowed', () => {
  it('refuses images for every TensorRT-LLM model, even one edited to claim vision', () => {
    // No vision in this slice (design D9): the gateway would refuse the request.
    expect(imageAttachmentsAllowed('tensorrt-llm', model(['vision']))).toBe(false)
    expect(imageAttachmentsAllowed('llamacpp-upstream', model(['vision']))).toBe(true)
    expect(imageAttachmentsAllowed('llamacpp-upstream', model([]))).toBe(false)
  })
})

describe('loadWatchdogMs', () => {
  it('outlasts the longest load timeout the TensorRT-LLM settings allow', () => {
    // `load_timeout_seconds` goes up to 3600 in the core's schema; the app must not give up first.
    expect(loadWatchdogMs('tensorrt-llm', 35 * 60_000)).toBeGreaterThan(3600 * 1000)
    expect(loadWatchdogMs('llamacpp-upstream', 35 * 60_000)).toBe(35 * 60_000)
  })
})

describe('a second managed engine is chatted with by the same rules', () => {
  const overflow = new Error(
    "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens. [context_length_exceeded]"
  )
  beforeEach(() =>
    setManagedEnginesForTests([{ id: 'second-engine', label: 'Second', i18n: 'second' }, TENSORRT_LLM_ENGINE])
  )
  afterEach(() => setManagedEnginesForTests(undefined))

  it('gates Agent mode and images, keeps the context fixed and waits as long for a load', () => {
    expect(agentModelBlockReason('second-engine', model([]))).toBe('model-without-tools')
    expect(agentModelBlockReason('second-engine', model(['tools']))).toBeNull()
    expect(imageAttachmentsAllowed('second-engine', model(['vision']))).toBe(false)
    expect(canGrowContext('second-engine')).toBe(false)
    expect(loadWatchdogMs('second-engine', 35 * 60_000)).toBeGreaterThan(3600 * 1000)
  })

  it('names its own engine and settings in the overflow message', () => {
    const guidance = contextOverflowGuidance('second-engine', overflow)
    expect(guidance?.engine.id).toBe('second-engine')
    expect(guidance?.limit).toBe(4096)
    const message = contextOverflowMessage(guidance!)
    expect(message).toContain('Second does not grow the context')
    expect(message).toContain('Settings → Providers → Second')
    expect(message).not.toContain('TensorRT-LLM')
  })
})
