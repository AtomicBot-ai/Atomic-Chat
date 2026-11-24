import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  compactContext,
  contextRoutesAbsent,
  isRouteAbsentError,
  measureContext,
  resetCoreContextRoutes,
} from '../core-context'

const request = { messages: [{ role: 'user', content: 'hello' }] }

describe('measureContext', () => {
  beforeEach(() => {
    invoke.mockReset()
    resetCoreContextRoutes()
  })

  it("asks the core for the session's measure", async () => {
    invoke.mockResolvedValue({
      promptTokens: 1234,
      exact: true,
      windowTokens: 8192,
      maxWindowTokens: 65536,
      resize: 'reload',
      supportsPromptProgress: true,
    })

    await expect(
      measureContext('llamacpp-upstream', 'org/model.gguf', request)
    ).resolves.toEqual({
      promptTokens: 1234,
      exact: true,
      windowTokens: 8192,
      maxWindowTokens: 65536,
      resize: 'reload',
      supportsPromptProgress: true,
    })
    expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/models/llamacpp-upstream/org/model.gguf/context/measure',
      body: request,
    })
  })

  it('never asks for a cloud model', async () => {
    await expect(
      measureContext('openai', 'gpt-5', request)
    ).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls back on an older core and stops asking for a while', async () => {
    invoke.mockRejectedValue({ code: 'HTTP_404', message: 'Not Found' })

    await expect(
      measureContext('vllm', 'qwen', request)
    ).resolves.toBeUndefined()
    expect(contextRoutesAbsent('measure')).toBe(true)
    await expect(
      measureContext('vllm', 'qwen', request)
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('reads any other failure, or a malformed answer, as no measure', async () => {
    invoke.mockRejectedValueOnce({ code: 'SESSION_NOT_FOUND' })
    await expect(measureContext('mlx', 'm', request)).resolves.toBeUndefined()
    expect(contextRoutesAbsent()).toBe(false)

    invoke.mockResolvedValueOnce({ promptTokens: 'many', resize: 'reload' })
    await expect(measureContext('mlx', 'm', request)).resolves.toBeUndefined()

    invoke.mockResolvedValueOnce({ promptTokens: 10, resize: 'sometimes' })
    await expect(measureContext('mlx', 'm', request)).resolves.toBeUndefined()
  })

  it('drops windows that are not positive', async () => {
    invoke.mockResolvedValue({
      promptTokens: 10,
      exact: false,
      windowTokens: 0,
      resize: 'fixed',
      supportsPromptProgress: false,
    })
    await expect(
      measureContext('foundry-local', 'phi', request)
    ).resolves.toEqual({
      promptTokens: 10,
      exact: false,
      resize: 'fixed',
      supportsPromptProgress: false,
    })
  })
})

describe('compactContext', () => {
  beforeEach(() => {
    invoke.mockReset()
    resetCoreContextRoutes()
  })

  it('returns the compaction', async () => {
    const result = {
      summary: 'Tides.',
      keepFrom: 3,
      summarizedCount: 2,
      tokensBefore: 9000,
      tokensAfter: 2000,
      cached: false,
    }
    invoke.mockResolvedValue(result)

    await expect(
      compactContext('vllm', 'qwen', { ...request, reserveTokens: 1024 })
    ).resolves.toEqual({ ok: true, result })
    expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/models/vllm/qwen/compact',
      body: { ...request, reserveTokens: 1024 },
    })
  })

  it('tells an older core from a summary that failed', async () => {
    invoke.mockRejectedValueOnce({ code: 'ROUTE_NOT_FOUND' })
    await expect(compactContext('vllm', 'qwen', request)).resolves.toEqual({
      ok: false,
      reason: 'absent',
    })
    expect(contextRoutesAbsent('compact')).toBe(true)
    resetCoreContextRoutes()

    invoke.mockRejectedValueOnce({ code: 'COMPACTION_FAILED' })
    await expect(compactContext('vllm', 'qwen', request)).resolves.toEqual({
      ok: false,
      reason: 'failed',
    })

    invoke.mockResolvedValueOnce({ summary: '', keepFrom: 2 })
    await expect(compactContext('vllm', 'qwen', request)).resolves.toEqual({
      ok: false,
      reason: 'failed',
    })
  })

  it('has nothing to compact for a cloud model', async () => {
    await expect(compactContext('openai', 'gpt-5', request)).resolves.toEqual({
      ok: false,
      reason: 'absent',
    })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('isRouteAbsentError', () => {
  it.each([
    [{ code: 'HTTP_404', message: 'The core answered 404.' }, true],
    [
      {
        code: 'INVALID_ARGUMENT',
        message:
          'No such control route: /atomic/v1/models/vllm/qwen/context/measure',
      },
      true,
    ],
    [{ code: 'INVALID_ARGUMENT', message: 'compact needs messages' }, false],
    [{ code: 'MODEL_NOT_LOADED', message: 'qwen is not loaded' }, false],
    [new Error('boom'), false],
    [null, false],
  ])('%o → %s', (error, absent) => {
    expect(isRouteAbsentError(error)).toBe(absent)
  })
})
