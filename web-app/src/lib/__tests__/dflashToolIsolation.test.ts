import { describe, expect, it } from 'vitest'

import {
  shouldSuppressToolsForUpstreamDflash,
  withUpstreamDflashReasoningOverride,
  withUpstreamDflashSampling,
} from '../custom-chat-transport'

function setting(key: string, value: boolean): ProviderSetting {
  return {
    key,
    title: key,
    description: '',
    controller_type: 'checkbox',
    controller_props: { value },
  }
}

describe('shouldSuppressToolsForUpstreamDflash', () => {
  it('suppresses tools for upstream llama.cpp when DFlash is enabled', () => {
    expect(
      shouldSuppressToolsForUpstreamDflash('llamacpp-upstream', [
        setting('dflash', true),
      ])
    ).toBe(true)
  })

  it('keeps tools enabled when upstream DFlash is disabled', () => {
    expect(
      shouldSuppressToolsForUpstreamDflash('llamacpp-upstream', [
        setting('dflash', false),
      ])
    ).toBe(false)
  })

  it('does not suppress tools for other providers', () => {
    expect(
      shouldSuppressToolsForUpstreamDflash('llamacpp', [
        setting('dflash', true),
      ])
    ).toBe(false)
  })
})

describe('withUpstreamDflashSampling', () => {
  it('forces greedy sampling for upstream DFlash requests', () => {
    const params = { temperature: 0.7, top_p: 0.8 }

    expect(
      withUpstreamDflashSampling(
        'llamacpp-upstream',
        [setting('dflash', true)],
        params
      )
    ).toEqual({
      temperature: 0,
      top_k: 1,
      top_p: 0.8,
      repeat_penalty: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
    })
    expect(params).toEqual({ temperature: 0.7, top_p: 0.8 })
  })

  it('preserves sampling when DFlash is disabled', () => {
    const params = { temperature: 0.7 }

    expect(
      withUpstreamDflashSampling(
        'llamacpp-upstream',
        [setting('dflash', false)],
        params
      )
    ).toBe(params)
  })

  it('preserves sampling for other providers', () => {
    const params = { temperature: 0.7 }

    expect(
      withUpstreamDflashSampling(
        'llamacpp',
        [setting('dflash', true)],
        params
      )
    ).toBe(params)
  })
})

describe('withUpstreamDflashReasoningOverride', () => {
  it('disables thinking for upstream DFlash requests', () => {
    const override = {
      chat_template_kwargs: { custom_flag: true, enable_thinking: true },
      reasoning_budget: 4096,
    }

    expect(
      withUpstreamDflashReasoningOverride(
        'llamacpp-upstream',
        [setting('dflash', true)],
        override
      )
    ).toEqual({
      chat_template_kwargs: {
        custom_flag: true,
        enable_thinking: false,
      },
      reasoning_budget: 0,
    })
    expect(override).toEqual({
      chat_template_kwargs: { custom_flag: true, enable_thinking: true },
      reasoning_budget: 4096,
    })
  })

  it('preserves reasoning settings when DFlash is disabled', () => {
    const override = { reasoning_budget: 4096 }

    expect(
      withUpstreamDflashReasoningOverride(
        'llamacpp-upstream',
        [setting('dflash', false)],
        override
      )
    ).toBe(override)
  })
})
