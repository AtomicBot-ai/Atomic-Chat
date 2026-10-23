import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  sendServedModelSelection,
  servedModelSelection,
  syncServedModelSelection,
} from '@/utils/serverModelSelection'

describe('servedModelSelection', () => {
  it('names one provider per id, the running server first and the default after', () => {
    expect(
      servedModelSelection({
        lastServerModels: [
          { model: 'qwen', provider: 'llamacpp-upstream' },
          { model: 'gemma', provider: 'mlx' },
        ],
        defaultModelLocalApiServer: {
          model: 'qwen',
          provider: 'custom-endpoint',
        },
      })
    ).toEqual([
      { model: 'qwen', provider: 'llamacpp-upstream' },
      { model: 'gemma', provider: 'mlx' },
    ])
    expect(
      servedModelSelection({
        lastServerModels: [],
        defaultModelLocalApiServer: {
          model: 'qwen',
          provider: 'custom-endpoint',
        },
      })
    ).toEqual([{ model: 'qwen', provider: 'custom-endpoint' }])
    expect(
      servedModelSelection({
        lastServerModels: [],
        defaultModelLocalApiServer: null,
      })
    ).toEqual([])
  })
})

describe('syncServedModelSelection', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    useLocalApiServer.setState({
      lastServerModels: [{ model: 'qwen', provider: 'custom-endpoint' }],
      defaultModelLocalApiServer: {
        model: 'qwen',
        provider: 'custom-endpoint',
      },
    })
  })

  it('sends the selection now and again when the user switches the model back to a local engine', () => {
    const stop = syncServedModelSelection()
    expect(invoke).toHaveBeenLastCalledWith('set_server_model_selection', {
      models: [{ model: 'qwen', provider: 'custom-endpoint' }],
    })

    // What `switchModel` records when the same id is loaded in llama.cpp.
    useLocalApiServer.getState().setDefaultModelLocalApiServer({
      model: 'qwen',
      provider: 'llamacpp-upstream',
    })
    useLocalApiServer
      .getState()
      .setLastServerModels([{ model: 'qwen', provider: 'llamacpp-upstream' }])

    expect(invoke).toHaveBeenLastCalledWith('set_server_model_selection', {
      models: [{ model: 'qwen', provider: 'llamacpp-upstream' }],
    })
    // An unrelated setting does not send it again.
    const calls = invoke.mock.calls.length
    useLocalApiServer.getState().setProxyTimeout(30)
    expect(invoke.mock.calls.length).toBe(calls)

    stop()
    useLocalApiServer
      .getState()
      .setLastServerModels([{ model: 'qwen', provider: 'mlx' }])
    expect(invoke.mock.calls.length).toBe(calls)
  })

  it('resolves, and says why, when the server refuses the selection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockRejectedValue(new Error('unknown route'))

    await expect(
      sendServedModelSelection([{ model: 'qwen', provider: 'mlx' }])
    ).resolves.toBeUndefined()
    expect(warn.mock.calls[0]?.[1]).toEqual(new Error('unknown route'))
    warn.mockRestore()
  })
})
