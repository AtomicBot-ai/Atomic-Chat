/**
 * The loaded context window the upstream and PrismML extensions tell the web app after a load
 * (`extensions/shared/loadedContext.ts`, ATO-465).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  contextFromProps,
  mirrorLoadedContext,
  readLoadedContext,
} from '../../../shared/loadedContext'

const server = { model_id: 'LiquidAI/LFM2_5-1_2B-Instruct-Q4_K_M', port: 3507, api_key: 'k' }

/** A `/props` endpoint that answers `body` (or fails the way `answer` says). */
function propsServer(answer: { body?: unknown; status?: number; throws?: boolean }) {
  return vi.fn(async (_url: string, _init: RequestInit) => {
    if (answer.throws) throw new TypeError('Failed to fetch')
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body,
    } as Response
  })
}

describe('contextFromProps', () => {
  it.each([
    ['the slot window', { default_generation_settings: { n_ctx: 128000 }, n_ctx: 4 }, 128000],
    ['the server window when the slot has none', { n_ctx: 8192 }, 8192],
    ['the server window when the slot window is zero', { default_generation_settings: { n_ctx: 0 }, n_ctx: 4096 }, 4096],
    ['a numeric string', { default_generation_settings: { n_ctx: '16384' } }, 16384],
    ['nothing from an empty body', {}, undefined],
    ['nothing from a negative window', { n_ctx: -1 }, undefined],
    ['nothing from a non-number', { n_ctx: 'auto' }, undefined],
    ['nothing from null', null, undefined],
  ])('reads %s', (_name, props, expected) => {
    expect(contextFromProps(props)).toBe(expected)
  })
})

describe('readLoadedContext', () => {
  it('asks the session port for /props with the session key', async () => {
    const fetchImpl = propsServer({ body: { default_generation_settings: { n_ctx: 128000 } } })
    await expect(readLoadedContext(server, fetchImpl)).resolves.toBe(128000)
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3507/props', {
      headers: { Authorization: 'Bearer k' },
    })
  })

  it.each([
    ['an error status', { status: 401 }],
    ['a refused connection', { throws: true }],
    ['a body without a window', { body: { model_path: '/m.gguf' } }],
  ])('says nothing on %s', async (_name, answer) => {
    await expect(readLoadedContext(server, propsServer(answer))).resolves.toBeUndefined()
  })
})

describe('mirrorLoadedContext', () => {
  it.each([
    // QA 2.2.25: fit on, the controls said 16K, llama.cpp fitted the model's 128000.
    ['fit chose a different window', 16384, 128000, 128000],
    ['the core clamped the window to the trained one', 16384, 8192, 8192],
    ['the load asked for nothing in particular', undefined, 32768, 32768],
    ['the ask was unreadable', 'auto', 32768, 32768],
    ['the server runs what was asked for', 4096, 4096, undefined],
    ['the ask came as a string', '8192', 8192, undefined],
  ])('when %s (asked %s, loaded %s) the app hears %s', async (_name, requested, loaded, told) => {
    const notify = vi.fn()
    const result = await mirrorLoadedContext({
      server,
      requested,
      fetch: propsServer({ body: { default_generation_settings: { n_ctx: loaded } } }),
      notify,
    })
    expect(result).toBe(told)
    if (told === undefined) expect(notify).not.toHaveBeenCalled()
    else expect(notify).toHaveBeenCalledWith(server.model_id, told)
  })

  it('leaves the controls alone, with a warning, when the server cannot say', async () => {
    const notify = vi.fn()
    const warnings: string[] = []
    const result = await mirrorLoadedContext({
      server,
      requested: 16384,
      fetch: propsServer({ throws: true }),
      notify,
      warn: (message) => warnings.push(message),
    })
    expect(result).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
    expect(warnings).toEqual([
      'Could not read the loaded context of LiquidAI/LFM2_5-1_2B-Instruct-Q4_K_M from /props',
    ])
  })

  it('never throws when telling the app fails', async () => {
    const warnings: string[] = []
    const result = await mirrorLoadedContext({
      server,
      requested: 16384,
      fetch: propsServer({ body: { n_ctx: 128000 } }),
      notify: () => {
        throw new Error('no listener')
      },
      warn: (message) => warnings.push(message),
    })
    expect(result).toBeUndefined()
    expect(warnings).toEqual([
      'Could not tell the app the loaded context of LiquidAI/LFM2_5-1_2B-Instruct-Q4_K_M: Error: no listener',
    ])
  })
})
