import { describe, expect, it } from 'vitest'

import { defaultAssistant } from '@/hooks/useAssistant'
import { hasCustomSampling, withDefaultSampling } from '@/lib/sampling-defaults'

const assistant = (extra: Partial<Assistant>) =>
  ({ id: 'writer', name: 'Writer', ...extra }) as Assistant

describe('withDefaultSampling', () => {
  it('puts every panel knob back on its default and keeps the rest', () => {
    expect(
      withDefaultSampling({
        temperature: 1.5,
        top_p: 0.35,
        min_p: 0.83,
        presence_penalty: 1,
        stream: false,
        max_tokens: 512,
      })
    ).toEqual({
      stream: false,
      max_tokens: 512,
      ...defaultAssistant.parameters,
    })
  })

  it('gives an assistant with no sampling at all the defaults', () => {
    expect(withDefaultSampling(undefined)).toEqual(defaultAssistant.parameters)
  })
})

describe('hasCustomSampling', () => {
  it('has nothing to reset on the defaults', () => {
    expect(
      hasCustomSampling(assistant({ parameters: withDefaultSampling() }))
    ).toBe(false)
  })

  it('sees a knob moved off its default', () => {
    expect(
      hasCustomSampling(
        assistant({ parameters: { ...withDefaultSampling(), temperature: 1.5 } })
      )
    ).toBe(true)
  })

  it('sees a knob the default leaves unset', () => {
    expect(
      hasCustomSampling(
        assistant({ parameters: { ...withDefaultSampling(), min_p: 0.1 } })
      )
    ).toBe(true)
  })

  it('counts the tuned flag even when the values are back on the defaults', () => {
    expect(
      hasCustomSampling(
        assistant({
          parameters: withDefaultSampling(),
          sampling_overridden: true,
        })
      )
    ).toBe(true)
  })
})
