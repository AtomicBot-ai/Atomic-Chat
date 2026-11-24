import { describe, expect, it } from 'vitest'

import {
  CTX_LEN_USER_SET_KEY,
  ctxLenUserSetSetting,
  isCtxLenUserSet,
  mirrorPlannedWindow,
  sendsCtxSize,
} from '@/lib/planned-context-window'

const settings = (ctxLen: unknown, userSet?: boolean) => ({
  ...(ctxLen === undefined
    ? {}
    : { ctx_len: { controller_props: { value: ctxLen } } }),
  ...(userSet === undefined
    ? {}
    : { [CTX_LEN_USER_SET_KEY]: { controller_props: { value: userSet } } }),
})

describe('sendsCtxSize', () => {
  it.each([
    // provider, ctx_len, user-set, sent
    ['llamacpp-upstream', 16384, undefined, false],
    ['llamacpp-upstream', 8192, undefined, false],
    ['llamacpp-upstream', '16384', undefined, false],
    ['llamacpp', 16384, undefined, false],
    ['atomic-prism', 8192, undefined, false],
    ['mlx', 16384, undefined, false],
    ['mlx', 16384, false, false],
    // Chosen by hand, the old default included.
    ['llamacpp-upstream', 16384, true, true],
    ['mlx', 8192, true, true],
    // Grown, mirrored back from a load, or set by an older release by hand.
    ['llamacpp-upstream', 32768, undefined, true],
    ['llamacpp-upstream', 65536, undefined, true],
    ['mlx', 40960, undefined, true],
    ['llamacpp-upstream', 4096, undefined, true],
    ['llamacpp-upstream', 0, undefined, true],
    ['llamacpp-upstream', undefined, undefined, true],
    // Engines whose core load does not plan the window send what they have.
    ['fastflowlm', 16384, undefined, true],
    ['litert-lm', 8192, undefined, true],
    ['geniex', 16384, undefined, true],
    ['openai', 16384, undefined, true],
  ] as const)(
    '%s with ctx_len %s (user set: %s) sends: %s',
    (provider, ctxLen, userSet, sent) => {
      expect(sendsCtxSize(provider, settings(ctxLen, userSet))).toBe(sent)
    }
  )

  it('sends for a model without settings', () => {
    expect(sendsCtxSize('llamacpp-upstream', undefined)).toBe(true)
  })
})

describe('the user-set marker', () => {
  it('is a hidden boolean setting that reads as set', () => {
    const marker = ctxLenUserSetSetting()
    expect(marker.key).toBe(CTX_LEN_USER_SET_KEY)
    expect(marker.controller_props.value).toBe(true)
    expect(isCtxLenUserSet({ [CTX_LEN_USER_SET_KEY]: marker })).toBe(true)
    expect(isCtxLenUserSet(settings(16384))).toBe(false)
    expect(isCtxLenUserSet(undefined)).toBe(false)
  })
})

describe('mirrorPlannedWindow', () => {
  const run = async (
    providerId: string,
    measured: { windowTokens?: number } | undefined | Error,
    current: number | undefined = 16384
  ) => {
    const written: number[] = []
    const result = await mirrorPlannedWindow(providerId, 'm', {
      measure: async () => {
        if (measured instanceof Error) throw measured
        return measured
      },
      currentCtxLen: () => current,
      write: (window) => written.push(window),
    })
    return { result, written }
  }

  it('writes the window the core chose for an MLX load', async () => {
    expect(await run('mlx', { windowTokens: 98304 })).toEqual({
      result: 98304,
      written: [98304],
    })
  })

  it.each([
    [
      'a llama.cpp load, mirrored from /props by its extension',
      'llamacpp-upstream',
      { windowTokens: 98304 },
      16384,
    ],
    ['a core that does not say', 'mlx', undefined, 16384],
    ['a window the model already shows', 'mlx', { windowTokens: 16384 }, 16384],
    ['a failed measure', 'mlx', new Error('boom'), 16384],
  ] as const)(
    'writes nothing for %s',
    async (_name, provider, measured, current) => {
      expect(await run(provider, measured, current)).toEqual({
        result: undefined,
        written: [],
      })
    }
  )
})
