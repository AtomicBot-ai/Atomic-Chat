import { describe, expect, it } from 'vitest'
import type { ReasoningControls } from '@janhq/core'

import {
  availableReasoningLevels,
  buildAgentReasoningRequest,
  buildReasoningRequestFields,
  modelEffortValue,
  resolveReasoningLevel,
} from '../reasoning-effort'

const NON_THINKING: ReasoningControls = { supportsThinking: false }
const BUDGET_ONLY: ReasoningControls = { supportsThinking: true }
const GPT_OSS: ReasoningControls = {
  supportsThinking: true,
  effortKwarg: 'reasoning_effort',
  effortValues: ['low', 'medium', 'high'],
}
// Hunyuan 3 has no `medium`, and skips thinking through its own value.
const HY3: ReasoningControls = {
  supportsThinking: true,
  effortKwarg: 'reasoning_effort',
  effortValues: ['low', 'high'],
  offValue: 'no_think',
}
// Inkling declares the whole scale, plus a `minimal` the picker never offers.
const INKLING: ReasoningControls = {
  supportsThinking: true,
  effortKwarg: 'reasoning_effort',
  effortValues: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  offValue: 'none',
}
const SEED_OSS: ReasoningControls = {
  supportsThinking: true,
  effortKwarg: 'thinking_budget',
}

describe('availableReasoningLevels', () => {
  it('offers nothing for a model without a thinking phase', () => {
    expect(availableReasoningLevels(NON_THINKING)).toEqual([])
    expect(availableReasoningLevels(undefined)).toEqual([])
  })

  it('offers the full scale when there is no native effort knob', () => {
    expect(availableReasoningLevels(BUDGET_ONLY)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(availableReasoningLevels(SEED_OSS)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('offers only the levels a native-effort template declares', () => {
    expect(availableReasoningLevels(GPT_OSS)).toEqual(['low', 'medium', 'high'])
    expect(availableReasoningLevels(HY3)).toEqual(['low', 'high'])
    expect(availableReasoningLevels(INKLING)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })
})

describe('resolveReasoningLevel', () => {
  it('keeps a level the model offers', () => {
    expect(resolveReasoningLevel('high', ['low', 'medium', 'high'])).toBe('high')
  })

  it('falls back to the nearest offered level', () => {
    expect(resolveReasoningLevel('medium', ['low', 'high'])).toBe('low')
    expect(resolveReasoningLevel('max', ['low', 'medium', 'high'])).toBe('high')
  })

  it('returns nothing when the model offers no level', () => {
    expect(resolveReasoningLevel('high', [])).toBeUndefined()
  })
})

describe('modelEffortValue', () => {
  it('never invents a value the template did not declare', () => {
    expect(modelEffortValue('medium', ['low', 'high'])).toBe('low')
    expect(modelEffortValue('high', ['minimal', 'low', 'medium', 'high', 'max']))
      .toBe('high')
    expect(modelEffortValue('low', [])).toBeUndefined()
    expect(modelEffortValue('low', ['weird'])).toBeUndefined()
  })
})

describe('buildReasoningRequestFields', () => {
  it('sends nothing for a model without a thinking phase', () => {
    expect(buildReasoningRequestFields('high', 'llamacpp', NON_THINKING)).toEqual(
      {}
    )
    expect(buildReasoningRequestFields('high', 'llamacpp', undefined)).toEqual({})
  })

  it('sends the backend budget sampler field for llama.cpp', () => {
    expect(buildReasoningRequestFields('low', 'llamacpp', BUDGET_ONLY)).toEqual({
      reasoning_budget_tokens: 256,
    })
    expect(
      buildReasoningRequestFields('high', 'llamacpp-upstream', BUDGET_ONLY)
    ).toEqual({ reasoning_budget_tokens: 4096 })
    expect(
      buildReasoningRequestFields('xhigh', 'llamacpp', BUDGET_ONLY)
    ).toEqual({ reasoning_budget_tokens: 8192 })
  })

  it('sends the mlx-vlm budget field for MLX', () => {
    expect(buildReasoningRequestFields('medium', 'mlx', BUDGET_ONLY)).toEqual({
      thinking_budget: 1024,
    })
  })

  it('omits any cap at the max level of a budget model', () => {
    expect(buildReasoningRequestFields('max', 'llamacpp', BUDGET_ONLY)).toEqual(
      {}
    )
  })

  it('sends the strongest declared value at the max level', () => {
    expect(buildReasoningRequestFields('max', 'llamacpp', INKLING)).toEqual({
      chat_template_kwargs: { reasoning_effort: 'max' },
    })
    // gpt-oss stops at `high`, so `max` clamps onto it rather than being invented.
    expect(buildReasoningRequestFields('max', 'llamacpp', GPT_OSS)).toEqual({
      chat_template_kwargs: { reasoning_effort: 'high' },
    })
  })

  it('routes a native effort through template kwargs on llama.cpp', () => {
    expect(buildReasoningRequestFields('high', 'llamacpp', GPT_OSS)).toEqual({
      chat_template_kwargs: { reasoning_effort: 'high' },
    })
  })

  it('routes a native effort through the top-level field on MLX', () => {
    expect(buildReasoningRequestFields('high', 'mlx', GPT_OSS)).toEqual({
      reasoning_effort: 'high',
    })
  })

  it('never sends a level a native-effort template would reject', () => {
    expect(buildReasoningRequestFields('medium', 'llamacpp', HY3)).toEqual({
      chat_template_kwargs: { reasoning_effort: 'low' },
    })
  })

  it('renders a template-native thinking budget into the prompt', () => {
    expect(buildReasoningRequestFields('medium', 'llamacpp', SEED_OSS)).toEqual({
      chat_template_kwargs: { thinking_budget: 1024 },
    })
  })
})

describe('buildAgentReasoningRequest', () => {
  it('maps a level onto a thinking-token budget for a budget-only model', () => {
    expect(buildAgentReasoningRequest('medium', false, BUDGET_ONLY)).toEqual({
      enabled: true,
      effort: 'medium',
      budget_tokens: 1024,
      supports_thinking: true,
    })
  })

  it('leaves max uncapped', () => {
    expect(buildAgentReasoningRequest('max', false, BUDGET_ONLY)).toEqual({
      enabled: true,
      effort: 'max',
      supports_thinking: true,
    })
  })

  it('sends a declared effort value instead of a budget', () => {
    expect(buildAgentReasoningRequest('high', false, GPT_OSS)).toEqual({
      enabled: true,
      effort: 'high',
      effort_value: 'high',
      supports_thinking: true,
    })
  })

  it('clamps a level the model does not declare', () => {
    // Hunyuan 3 has no `medium`; ties go to the weaker declared level.
    expect(buildAgentReasoningRequest('medium', false, HY3)).toMatchObject({
      enabled: true,
      effort: 'low',
      effort_value: 'low',
    })
  })

  it('reports a model with no thinking phase as unknown rather than off', () => {
    // `supports_thinking: false` is what tells the backend to leave the
    // transport's own default alone — every cloud model lands here.
    expect(buildAgentReasoningRequest('high', false, NON_THINKING)).toEqual({
      enabled: false,
      supports_thinking: false,
    })
    expect(buildAgentReasoningRequest('high', false, undefined)).toEqual({
      enabled: false,
      supports_thinking: false,
    })
  })

  it('suppresses thinking when the bulb is off or the level is off', () => {
    const suppressed = { enabled: false, supports_thinking: true }
    expect(buildAgentReasoningRequest('high', true, BUDGET_ONLY)).toEqual(
      suppressed
    )
    expect(buildAgentReasoningRequest('off', false, BUDGET_ONLY)).toEqual(
      suppressed
    )
    // The bulb wins over any stored level.
    expect(buildAgentReasoningRequest('max', true, INKLING)).toEqual(suppressed)
  })

  it('treats a template-rendered budget model as a budget model', () => {
    expect(buildAgentReasoningRequest('low', false, SEED_OSS)).toEqual({
      enabled: true,
      effort: 'low',
      budget_tokens: 256,
      supports_thinking: true,
    })
  })
})
