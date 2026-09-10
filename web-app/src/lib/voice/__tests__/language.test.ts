import { describe, expect, it } from 'vitest'

import { transcriptionPrompt } from '@/lib/voice/language'

describe('transcriptionPrompt', () => {
  it('sends the chosen language as a directive, over the app language', () => {
    expect(transcriptionPrompt('en', 'de-DE')).toBe('lang:en')
  })

  it('resolves auto to the language the app is in', () => {
    expect(transcriptionPrompt('auto', 'de-DE')).toBe('lang:de')
    expect(transcriptionPrompt('auto', 'zh-CN')).toBe('lang:zh')
    // The app's own tag for Vietnamese is not the one the model knows.
    expect(transcriptionPrompt('auto', 'vn')).toBe('lang:vi')
  })

  it('always produces a directive, even with no UI language to go on', () => {
    expect(transcriptionPrompt('auto', undefined)).toBe('lang:en')
    expect(transcriptionPrompt('auto', '')).toBe('lang:en')
  })
})
