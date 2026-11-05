import { afterEach, describe, expect, it } from 'vitest'
import type { ReasoningControls } from '@janhq/core'

import { useModelProvider } from '@/hooks/useModelProvider'
import {
  availableReasoningLevels,
  buildAgentReasoningRequest,
  buildCloudReasoningRequestFields,
  buildReasoningRequestFields,
  buildRemoteReasoningRequestFields,
  canDisableReasoning,
  cloudModelReasoningControls,
  modelEffortValue,
  isCloudReasoningProvider,
  reasoningLevelsForModel,
  resolveReasoningLevel,
  shapeCloudReasoningOverride,
  usesTemplateReasoningKwargs,
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

describe('reasoningLevelsForModel', () => {
  it('uses provider inference only when model metadata is absent', () => {
    expect(reasoningLevelsForModel('openai', undefined)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(reasoningLevelsForModel('chatgpt', NON_THINKING)).toEqual([])
  })

  it('uses a subscription model\'s declared effort levels', () => {
    expect(reasoningLevelsForModel('chatgpt', GPT_OSS)).toEqual([
      'low',
      'medium',
      'high',
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

  it('routes a subscription effort through the top-level field', () => {
    expect(buildReasoningRequestFields('high', 'chatgpt', GPT_OSS)).toEqual({
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

  it('caps Agent Max at the top finite tier so tools retain output room', () => {
    expect(buildAgentReasoningRequest('max', false, BUDGET_ONLY)).toEqual({
      enabled: true,
      effort: 'max',
      budget_tokens: 8192,
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

  it('keeps a native API at a declared effort when it has no off value', () => {
    expect(buildAgentReasoningRequest('medium', true, GPT_OSS, false)).toEqual({
      enabled: true,
      effort: 'low',
      effort_value: 'low',
      supports_thinking: true,
    })
    expect(buildAgentReasoningRequest('off', false, GPT_OSS, false)).toEqual({
      enabled: true,
      effort: 'low',
      effort_value: 'low',
      supports_thinking: true,
    })
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

/**
 * ATO-527: a provider we cannot inspect. There is no chat template to read
 * controls off, so the wire shape is fixed and the classification is the only
 * thing deciding whether it is sent at all.
 */
describe('remote reasoning', () => {
  it('drives the servers the user runs through template kwargs', () => {
    expect(usesTemplateReasoningKwargs('llamacpp-server')).toBe(true)
    expect(usesTemplateReasoningKwargs('ollama')).toBe(true)
    // Not in the catalogue, so it was added by hand in Settings → Providers.
    expect(usesTemplateReasoningKwargs('my-own-gateway')).toBe(true)
  })

  it('leaves a catalogue provider alone', () => {
    // `chatgpt` is a baseline entry, so it is known without a registry fetch.
    expect(usesTemplateReasoningKwargs('chatgpt')).toBe(false)
  })

  it('recognizes catalogue cloud providers without treating local servers as cloud', () => {
    for (const provider of [
      'openai',
      'anthropic',
      'gemini',
      'xai',
      'openrouter',
      'aimlapi',
      'edenai',
      'nvidia',
      'chatgpt',
    ]) {
      expect(isCloudReasoningProvider(provider)).toBe(true)
    }
    for (const provider of [
      'llamacpp',
      'llamacpp-upstream',
      'mlx',
      'ollama',
      'llamacpp-server',
      'my-own-gateway',
    ]) {
      expect(isCloudReasoningProvider(provider)).toBe(false)
    }
  })

  it('uses each cloud API reasoning shape', () => {
    expect(buildCloudReasoningRequestFields('high', 'openai')).toEqual({
      reasoning_effort: 'high',
    })
    expect(buildCloudReasoningRequestFields('max', 'moonshot')).toEqual({
      reasoning_effort: 'max',
    })
    // MiniMax gets the level itself; the model factory puts it on what the
    // model takes (see `shapeCloudReasoningOverride` below).
    expect(buildCloudReasoningRequestFields('max', 'minimax')).toEqual({
      reasoning_effort: 'max',
    })
    expect(buildCloudReasoningRequestFields('medium', 'anthropic')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4096 },
    })
    // Gemini takes `reasoning_effort` or a `thinking_config`, never both, and
    // knows no level above `high`.
    for (const level of ['xhigh', 'max'] as const) {
      expect(buildCloudReasoningRequestFields(level, 'gemini')).toEqual({
        reasoning_effort: 'high',
      })
    }
    expect(buildCloudReasoningRequestFields('low', 'google')).toEqual({
      reasoning_effort: 'low',
    })
    expect(buildCloudReasoningRequestFields('max', 'openrouter')).toEqual({
      reasoning: { effort: 'xhigh' },
    })
    expect(buildCloudReasoningRequestFields('low', 'nvidia')).toEqual({
      reasoning_effort: 'low',
    })
  })

  it('gives cloud Agent turns an effort even without model metadata', () => {
    expect(
      buildAgentReasoningRequest('high', false, undefined, false, 'openai')
    ).toEqual({
      enabled: true,
      effort: 'high',
      effort_value: 'high',
      supports_thinking: true,
    })
  })

  it('starts a cloud Agent turn at the weakest level while the preference is off, as chat does', () => {
    // Defaults are `disableReasoning: true` with a stored `medium` (#366).
    expect(
      buildAgentReasoningRequest('medium', true, undefined, false, 'openai')
    ).toEqual({
      enabled: true,
      effort: 'low',
      effort_value: 'low',
      supports_thinking: true,
    })
  })

  it('leaves the local engines and the big APIs to their own paths', () => {
    for (const provider of [
      'llamacpp',
      'llamacpp-upstream',
      'mlx',
      'foundation-models',
    ]) {
      expect(usesTemplateReasoningKwargs(provider)).toBe(false)
    }
    for (const provider of [
      'anthropic',
      'openai',
      'xai',
      'google',
      'gemini',
      'moonshot',
    ]) {
      expect(usesTemplateReasoningKwargs(provider)).toBe(false)
    }
    expect(usesTemplateReasoningKwargs(undefined)).toBe(false)
  })

  it('sends both kwargs an open-weight template might read', () => {
    expect(buildRemoteReasoningRequestFields('low')).toEqual({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'low' },
    })
  })

  it('never sends an effort value a template would raise on', () => {
    for (const level of ['high', 'xhigh', 'max'] as const) {
      expect(buildRemoteReasoningRequestFields(level)).toEqual({
        chat_template_kwargs: {
          enable_thinking: true,
          reasoning_effort: 'high',
        },
      })
    }
  })
})

/**
 * #381 / #366: Mistral and MiniMax check `reasoning_effort` against the model,
 * so the provider alone cannot say what to send.
 */
describe('per-model cloud reasoning', () => {
  const select = (provider: string, id: string) =>
    useModelProvider.setState({
      selectedProvider: provider,
      selectedModel: { id } as Model,
    })

  afterEach(() => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
  })

  it('knows the documented Mistral reasoning models and nothing else', () => {
    expect(
      cloudModelReasoningControls('mistral', 'mistral-small-2506')
    ).toEqual({ supportsThinking: false })
    expect(
      cloudModelReasoningControls('mistral', 'magistral-medium-2509')
    ).toEqual({ supportsThinking: false })
    expect(
      cloudModelReasoningControls('mistral', 'mistral-large-4-0')?.effortValues
    ).toEqual(['low', 'medium', 'high'])
    expect(
      cloudModelReasoningControls('mistral', 'zai-glm-5-3-flash')?.effortValues
    ).toEqual(['low', 'high', 'max'])
    expect(
      cloudModelReasoningControls('mistral', 'mistral-small-2603')
    ).toMatchObject({
      effortValues: ['high'],
      offValue: 'none',
      canDisable: true,
    })
    // Providers that do not gate per model stay on provider inference.
    expect(cloudModelReasoningControls('openai', 'gpt-5')).toBeUndefined()
  })

  it('offers no effort control for a Mistral model without reasoning', () => {
    select('mistral', 'mistral-small-2506')
    expect(reasoningLevelsForModel('mistral', undefined)).toEqual([])
    expect(canDisableReasoning('mistral', undefined)).toBe(false)
    expect(
      buildAgentReasoningRequest('low', false, undefined, false, 'mistral')
    ).toEqual({ enabled: false, supports_thinking: false })
  })

  it('offers a Mistral reasoning model the levels it declares', () => {
    select('mistral', 'zai-glm-5-3')
    expect(reasoningLevelsForModel('mistral', undefined)).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(
      buildAgentReasoningRequest('max', false, undefined, false, 'mistral')
    ).toEqual({
      enabled: true,
      effort: 'max',
      effort_value: 'max',
      supports_thinking: true,
    })

    select('mistral', 'mistral-small-2603')
    expect(reasoningLevelsForModel('mistral', undefined)).toEqual(['high'])
    expect(canDisableReasoning('mistral', undefined)).toBe(true)
  })

  it('offers MiniMax Max only where it is documented', () => {
    select('minimax', 'MiniMax-M3.1-Flash')
    expect(reasoningLevelsForModel('minimax', undefined)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(canDisableReasoning('minimax', undefined)).toBe(false)
    expect(
      buildAgentReasoningRequest('max', false, undefined, false, 'minimax')
    ).toMatchObject({ effort_value: 'max' })

    select('minimax', 'MiniMax-M2.7')
    expect(reasoningLevelsForModel('minimax', undefined)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(
      buildAgentReasoningRequest('max', false, undefined, false, 'minimax')
    ).toMatchObject({ effort_value: 'xhigh' })
  })

  it('ignores a selection on another provider', () => {
    select('openai', 'mistral-small-2506')
    expect(reasoningLevelsForModel('mistral', undefined)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('never sends an effort to a Mistral model without reasoning', () => {
    expect(
      shapeCloudReasoningOverride('mistral', 'mistral-small-2506', {
        reasoning_effort: 'low',
      })
    ).toEqual({})
  })

  it('puts the effort on the nearest value the model declares', () => {
    const shape = (provider: string, model: string, effort: string) =>
      shapeCloudReasoningOverride(provider, model, { reasoning_effort: effort })

    expect(shape('mistral', 'mistral-large-4-0', 'max')).toEqual({
      reasoning_effort: 'high',
    })
    expect(shape('mistral', 'zai-glm-5-3', 'max')).toEqual({
      reasoning_effort: 'max',
    })
    expect(shape('mistral', 'zai-glm-5-3', 'medium')).toEqual({
      reasoning_effort: 'low',
    })
    expect(shape('mistral', 'mistral-small-2603', 'low')).toEqual({
      reasoning_effort: 'high',
    })
    expect(shape('minimax', 'MiniMax-M3.1-Flash', 'max')).toEqual({
      reasoning_effort: 'max',
    })
    expect(shape('minimax', 'MiniMax-M3', 'max')).toEqual({
      reasoning_effort: 'xhigh',
    })
    expect(shape('minimax', 'MiniMax-M2.7', 'max')).toEqual({
      reasoning_effort: 'xhigh',
    })
    expect(shape('minimax', 'MiniMax-M2.7', 'low')).toEqual({
      reasoning_effort: 'low',
    })
  })

  it("turns the generic skip-thinking hint into the model's own off value", () => {
    const off = { chat_template_kwargs: { enable_thinking: false } }
    expect(
      shapeCloudReasoningOverride('mistral', 'mistral-small-2603', off)
    ).toEqual({ reasoning_effort: 'none' })
    expect(
      shapeCloudReasoningOverride('mistral', 'mistral-large-4-0', off)
    ).toEqual({})
  })

  it('leaves every other provider alone', () => {
    const override = { reasoning_effort: 'xhigh' }
    expect(shapeCloudReasoningOverride('openai', 'gpt-5', override)).toBe(
      override
    )
  })
})
