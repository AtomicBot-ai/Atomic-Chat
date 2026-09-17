import { describe, expect, it } from 'vitest'

import { subscriptionModelToProviderModel } from '../useChatGptAuth'

describe('subscriptionModelToProviderModel', () => {
  it('keeps the subscription catalogue reasoning levels on the picker model', () => {
    const model = subscriptionModelToProviderModel({
      id: 'gpt-6-astra',
      display_name: 'GPT 6 Astra',
      context_length: 200_000,
      vision: true,
      reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
      listed: true,
    })

    expect(model.reasoning).toEqual({
      supportsThinking: true,
      canDisable: false,
      effortKwarg: 'reasoning_effort',
      effortValues: ['low', 'medium', 'high', 'xhigh'],
    })
  })

  it('separates a real off value from selectable effort levels', () => {
    const model = subscriptionModelToProviderModel({
      id: 'fixture',
      display_name: 'Fixture',
      vision: false,
      reasoning_efforts: [' none ', 'LOW', 'high'],
      listed: true,
    })

    expect(model.reasoning).toEqual({
      supportsThinking: true,
      canDisable: true,
      effortKwarg: 'reasoning_effort',
      effortValues: ['low', 'high'],
      offValue: 'none',
    })
  })
})
