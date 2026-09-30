import { afterEach, describe, expect, it, vi } from 'vitest'

import { LOCAL_API_KEY_PREFIX, generateLocalApiKey } from '../localApiKey'

describe('generateLocalApiKey', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is sk-atomic- plus 32 URL-safe characters', () => {
    expect(LOCAL_API_KEY_PREFIX).toBe('sk-atomic-')
    for (let run = 0; run < 50; run += 1) {
      expect(generateLocalApiKey()).toMatch(/^sk-atomic-[A-Za-z0-9_-]{32}$/)
    }
  })

  it('never repeats itself', () => {
    const keys = new Set(
      Array.from({ length: 200 }, () => generateLocalApiKey())
    )
    expect(keys.size).toBe(200)
  })

  it('draws 24 bytes from the platform CSPRNG, not Math.random', () => {
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues')
    const random = vi.spyOn(Math, 'random')

    const key = generateLocalApiKey()

    expect(getRandomValues).toHaveBeenCalledTimes(1)
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(24)
    expect(random).not.toHaveBeenCalled()
    expect(key).toHaveLength('sk-atomic-'.length + 32)
  })

  it('swaps the two base64 characters that break URLs and shells', () => {
    // 0xfb 0xff … encodes to `+/` runs in plain base64.
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      new Uint8Array((array as Uint8Array).buffer).fill(0xfb)
      ;(array as Uint8Array)[1] = 0xff
      return array
    })

    const key = generateLocalApiKey()

    expect(key).not.toMatch(/[+/=]/)
    expect(key).toMatch(/^sk-atomic-[A-Za-z0-9_-]{32}$/)
    expect(key).toContain('-')
    expect(key).toContain('_')
  })
})
