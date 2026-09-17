import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/api/core')>(
    '@tauri-apps/api/core'
  )
  return { ...actual, invoke: (...args: unknown[]) => invoke(...args) }
})

import { findFoundationModelsSession, findLocalSession } from '../model-factory'

beforeEach(() => invoke.mockReset())

describe('findLocalSession ownership boundary', () => {
  it('treats null from the Rust resolver as the authoritative answer', async () => {
    invoke.mockResolvedValue(null)

    await expect(
      findLocalSession('llamacpp-upstream', 'missing')
    ).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('resolve_local_session', {
      provider: 'llamacpp-upstream',
      modelId: 'missing',
    })
  })

  it('falls back to plugin IPC only when an old shell lacks the resolver command', async () => {
    invoke
      .mockRejectedValueOnce(new Error('unknown command resolve_local_session'))
      .mockResolvedValueOnce({ model_id: 'm', port: 3001 })

    await expect(
      findLocalSession('llamacpp-upstream', 'm')
    ).resolves.toMatchObject({
      model_id: 'm',
      port: 3001,
    })
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'plugin:llamacpp-upstream|find_session_by_model',
      { modelId: 'm' }
    )
  })

  it('does not cross to the plugin after an operational resolver failure', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'resolve_local_session') {
        return Promise.reject(new Error('owner is changing'))
      }
      return Promise.resolve(undefined)
    })

    let caught: unknown
    try {
      await findLocalSession('llamacpp-upstream', 'm')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('owner is changing')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe('findFoundationModelsSession', () => {
  it('answers from the resolver when the core runs the server', async () => {
    invoke.mockResolvedValueOnce({ model_id: 'apple/on-device', port: 3007 })
    await expect(findFoundationModelsSession('apple/on-device')).resolves.toMatchObject({ port: 3007 })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('resolve_local_session', {
      provider: 'foundation-models',
      modelId: 'apple/on-device',
    })
  })

  it('reads the plugin table when the resolver has nothing, or on an old shell without it', async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce({ port: 3008 })
    await expect(findFoundationModelsSession('apple/on-device')).resolves.toEqual({ port: 3008 })
    expect(invoke).toHaveBeenNthCalledWith(2, 'plugin:foundation-models|find_foundation_models_session', {})

    invoke.mockReset()
    invoke.mockRejectedValueOnce(new Error('unknown command resolve_local_session')).mockResolvedValueOnce(null)
    await expect(findFoundationModelsSession('apple/on-device')).resolves.toBeNull()
  })

  it('does not fall back to the plugin after an operational resolver failure', async () => {
    invoke.mockRejectedValueOnce(new Error('owner is changing'))
    await expect(findFoundationModelsSession('apple/on-device')).rejects.toThrow('owner is changing')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
