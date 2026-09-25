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

describe('findLocalSession', () => {
  it('returns the session the Rust resolver finds in the core mirror', async () => {
    invoke.mockResolvedValueOnce({ model_id: 'm', port: 3001, provider: 'mlx' })

    await expect(findLocalSession('mlx', 'm')).resolves.toMatchObject({
      model_id: 'm',
      port: 3001,
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('resolve_local_session', {
      provider: 'mlx',
      modelId: 'm',
    })
  })

  it('treats null from the Rust resolver as the authoritative answer', async () => {
    invoke.mockResolvedValue(null)

    await expect(
      findLocalSession('llamacpp-upstream', 'missing')
    ).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('propagates a resolver failure instead of asking anything else', async () => {
    invoke.mockRejectedValueOnce(new Error('unknown command resolve_local_session'))

    await expect(findLocalSession('llamacpp-upstream', 'm')).rejects.toThrow(
      'unknown command resolve_local_session'
    )
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe('findFoundationModelsSession', () => {
  it('answers from the resolver', async () => {
    invoke.mockResolvedValueOnce({ model_id: 'apple/on-device', port: 3007 })
    await expect(findFoundationModelsSession('apple/on-device')).resolves.toMatchObject({ port: 3007 })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('resolve_local_session', {
      provider: 'foundation-models',
      modelId: 'apple/on-device',
    })
  })

  it('returns null when the core serves nothing for it', async () => {
    invoke.mockResolvedValueOnce(null)
    await expect(findFoundationModelsSession('apple/on-device')).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('propagates a resolver failure', async () => {
    invoke.mockRejectedValueOnce(new Error('core detached'))
    await expect(findFoundationModelsSession('apple/on-device')).rejects.toThrow('core detached')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
