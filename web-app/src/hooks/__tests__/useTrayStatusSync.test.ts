import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  router: {
    state: { matches: [] as { routeId: string }[] },
    navigate: vi.fn(async () => {}),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      return () => mocks.listeners.delete(name)
    }
  ),
}))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => mocks.router }))
// Start/stop talk to the core; these cases only click the model rows.
vi.mock('@/utils/localApiServerControl', () => ({
  setLocalApiServerRunning: vi.fn(),
}))
vi.mock('@/utils/turnOffLocalApiServer', () => ({
  resumeServedHelperModels: vi.fn(),
  turnOffLocalApiServer: vi.fn(),
}))

import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useServerPickerRequest } from '@/stores/server-picker-request-store'

import { trayRuntimeLabel, useTrayStatusSync } from '../useTrayStatusSync'

/** An engine's versions answer with `version` as its active build. */
const activeBuild = (version: string) =>
  ({ active: { version, variant: 'macos-arm64' } }) as EngineVersions

const session = (provider: string, model_id: string, is_embedding = false) => ({
  pid: 1,
  port: 3000,
  model_id,
  model_path: `/models/${model_id}.gguf`,
  is_embedding,
  api_key: '',
  provider,
})

/** The payload of the last `update_tray_status` call. */
const lastPush = () =>
  mocks.invoke.mock.calls
    .filter(([command]) => command === 'update_tray_status')
    .at(-1)?.[1]?.payload

describe('trayRuntimeLabel', () => {
  it('names the engine and its active build', () => {
    expect(
      trayRuntimeLabel(['llamacpp-upstream'], {
        'llamacpp-upstream': activeBuild('b11463'),
      })
    ).toBe('llama.cpp · b11463')
  })

  it('names the engine alone until the core says which build is active', () => {
    expect(trayRuntimeLabel(['mlx'], {})).toBe('MLX')
  })

  it('counts the engines when the loaded models run on several', () => {
    expect(trayRuntimeLabel(['mlx', 'llamacpp-upstream', 'mlx'], {})).toBe(
      '2 runtimes'
    )
    // Two models on one engine are still one runtime.
    expect(
      trayRuntimeLabel(['atomic-prism', 'atomic-prism'], {
        'atomic-prism': activeBuild('b10777'),
      })
    ).toBe('PrismML llama.cpp · b10777')
  })

  it('is empty with nothing loaded', () => {
    expect(trayRuntimeLabel([], {})).toBe('')
  })
})

describe('useTrayStatusSync', () => {
  let sessions: ReturnType<typeof session>[] = []

  beforeEach(() => {
    vi.stubGlobal('IS_TAURI', true)
    vi.stubGlobal('IS_MACOS', true)
    mocks.listeners.clear()
    mocks.router.state.matches = [{ routeId: '/api/' }]
    mocks.router.navigate.mockClear()
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_local_sessions') return sessions
      if (command === 'plugin:hardware|get_system_usage')
        return { cpu: 0, used_memory: 8192, total_memory: 16384 }
      return undefined
    })
    sessions = []
    useAppState.setState({ activeModels: [], serverStatus: 'running' })
    useModelProvider.setState({ providers: [] })
    useEngineVersionsStore.setState({ engines: {} })
    useServerPickerRequest.setState({ target: null, nonce: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushes the engine and build the served chat model runs on', async () => {
    sessions = [
      session('llamacpp-upstream', 'qwen3.5-4b'),
      session('llamacpp', 'bge-m3', true),
    ]
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': activeBuild('b11463'),
        'llamacpp': activeBuild('b9000'),
      },
    })
    const { unmount } = renderHook(() => useTrayStatusSync())

    await waitFor(() =>
      expect(lastPush()).toMatchObject({
        model_label: 'qwen3.5-4b',
        // The embedding model's engine does not count.
        runtime_label: 'llama.cpp · b11463',
      })
    )
    unmount()
  })

  it('falls back to the engine holding an active model the core does not list', async () => {
    useAppState.setState({ activeModels: ['bonsai-9b'] })
    useModelProvider.setState({
      providers: [
        {
          provider: 'atomic-prism',
          models: [{ id: 'bonsai-9b' }],
        } as unknown as ModelProvider,
      ],
    })
    const { unmount } = renderHook(() => useTrayStatusSync())

    await waitFor(() =>
      expect(lastPush()).toMatchObject({
        model_label: 'bonsai-9b',
        runtime_label: 'PrismML llama.cpp',
      })
    )
    unmount()
  })

  it('pushes an empty runtime with nothing loaded', async () => {
    const { unmount } = renderHook(() => useTrayStatusSync())

    await waitFor(() =>
      expect(lastPush()).toMatchObject({ model_label: '', runtime_label: '' })
    )
    unmount()
  })

  it('opens Engine & model with the engine picker for the Runtime row, the model picker for the Model row', async () => {
    const { unmount } = renderHook(() => useTrayStatusSync())
    await waitFor(() =>
      expect(mocks.listeners.has('tray-open-model-config')).toBe(true)
    )
    const click = mocks.listeners.get('tray-open-model-config')!

    click({ payload: 'runtime' })
    expect(useServerPickerRequest.getState().target).toBe('engine')
    expect(mocks.router.navigate).toHaveBeenLastCalledWith({
      to: '/api/model',
    })

    click({ payload: 'model' })
    expect(useServerPickerRequest.getState()).toMatchObject({
      target: 'model',
      nonce: 2,
    })
    expect(mocks.router.navigate).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('leaves the first-run flow on screen and asks for no picker', async () => {
    mocks.router.state.matches = [{ routeId: '/onboarding' }]
    const { unmount } = renderHook(() => useTrayStatusSync())
    await waitFor(() =>
      expect(mocks.listeners.has('tray-open-model-config')).toBe(true)
    )

    mocks.listeners.get('tray-open-model-config')!({ payload: 'model' })

    expect(useServerPickerRequest.getState().target).toBeNull()
    expect(mocks.router.navigate).not.toHaveBeenCalled()
    unmount()
  })
})
