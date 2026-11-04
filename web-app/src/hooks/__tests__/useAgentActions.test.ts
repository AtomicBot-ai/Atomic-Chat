import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  start,
  settle,
  writeConfig,
  installAgent,
  openAgent,
  ensureRunning,
  detect,
  contextWindow,
} = vi.hoisted(() => ({
  start: vi.fn(),
  settle: vi.fn(),
  writeConfig: vi.fn(),
  installAgent: vi.fn(),
  openAgent: vi.fn(),
  ensureRunning: vi.fn(),
  detect: vi.fn(),
  contextWindow: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({ start }),
}))
vi.mock('@/hooks/useRemoteAccess', () => ({
  startLocalApiServerAndSettle: settle,
}))
vi.mock('@/lib/integration-agent-setup', () => ({
  writeAgentConfig: writeConfig,
}))
vi.mock('@/lib/integration-agent-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/integration-agent-run')>()),
  installIntegrationAgent: installAgent,
  openIntegrationAgent: openAgent,
}))
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgent: detect,
}))
// The window check is measured by its own tests; here it answers what
// `ensureAgentContextWindow` would, through the real message and error.
vi.mock('@/lib/agent-context-window', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/agent-context-window')>()
  return {
    ...actual,
    requireAgentContextWindow: async (
      target: IntegrationAgent,
      t: (key: string, params?: Record<string, unknown>) => string
    ) => {
      const window = await contextWindow(target)
      if (window.ok) return window.contextLength
      throw new actual.AgentContextError(
        actual.contextWindowMessage(t, target, window)
      )
    },
  }
})
vi.mock('@/utils/servedModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/servedModel')>()),
  ensureServedModelRunning: ensureRunning,
}))

import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useLaunchStore } from '@/stores/launch-store'

import { useAgentActions } from '../useAgentActions'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!
const QWEN = { provider: 'llamacpp-upstream', model: 'qwen3.5-4b' }

describe('useAgentActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settle.mockResolvedValue(true)
    ensureRunning.mockResolvedValue(undefined)
    writeConfig.mockResolvedValue(undefined)
    installAgent.mockResolvedValue(true)
    openAgent.mockResolvedValue(true)
    detect.mockResolvedValue(true)
    contextWindow.mockResolvedValue({ ok: true, contextLength: undefined })
    useAppState.setState({ serverStatus: 'running' })
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      defaultModelLocalApiServer: null,
      lastServerModels: [QWEN],
    })
    useLaunchStore.setState({ busy: {}, phase: {}, installed: {}, viaWsl: {} })
    useServerSetup.setState({ configuredAgents: [] })
  })

  it('refuses to connect an agent installed only inside WSL', async () => {
    useLaunchStore.setState({
      installed: { codex: true },
      viaWsl: { codex: true },
    })
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(toast.warning).toHaveBeenCalledWith(
      `launch:toast.wslOnly:${JSON.stringify({ name: agent('codex').name })}`,
      expect.objectContaining({
        description: `launch:toast.wslOnlyDesc:${JSON.stringify({ name: agent('codex').name })}`,
      })
    )
    // Neither the Windows config nor a Windows console is touched.
    expect(writeConfig).not.toHaveBeenCalled()
    expect(openAgent).not.toHaveBeenCalled()
    expect(useServerSetup.getState().configuredAgents).toEqual([])
    expect(useLaunchStore.getState().phase.codex).toBeUndefined()
  })

  it('connects: points the agent at the served model, then opens it', async () => {
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(settle).not.toHaveBeenCalled()
    // A running server gets its model loaded before the config names it.
    expect(ensureRunning).toHaveBeenCalledOnce()
    expect(ensureRunning.mock.invocationCallOrder[0]).toBeLessThan(
      writeConfig.mock.invocationCallOrder[0] ?? 0
    )
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' }),
      'qwen3.5-4b',
      expect.objectContaining({ serverPort: 1337 }),
      { contextLength: undefined }
    )
    expect(openAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' }),
      expect.objectContaining({ model: 'qwen3.5-4b' })
    )
    expect(useServerSetup.getState().configuredAgents).toEqual([
      expect.objectContaining({ id: 'codex' }),
    ])
    expect(useLaunchStore.getState()).toMatchObject({
      busy: { codex: false },
      phase: { codex: undefined },
    })
  })

  it('starts a stopped server first, and stops there when it does not start', async () => {
    useAppState.setState({ serverStatus: 'stopped' })
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))
    expect(settle).toHaveBeenCalledWith(start, { ensureModel: true })
    // Start loaded the model itself.
    expect(ensureRunning).not.toHaveBeenCalled()
    expect(openAgent).toHaveBeenCalledTimes(1)
    expect(useServerSetup.getState().configuredAgents).toEqual([
      expect.objectContaining({ id: 'codex' }),
    ])

    useServerSetup.setState({ configuredAgents: [] })
    settle.mockResolvedValueOnce(false)
    await act(() => result.current.connect(agent('codex')))
    // The failed start said why itself; nothing is written or opened.
    expect(writeConfig).toHaveBeenCalledTimes(1)
    expect(openAgent).toHaveBeenCalledTimes(1)
    expect(useServerSetup.getState().configuredAgents).toEqual([])
    expect(useLaunchStore.getState()).toMatchObject({
      busy: { codex: false },
      phase: { codex: undefined },
    })
  })

  it('says so when an agent that needs a model has none to use', async () => {
    useLocalApiServer.setState({ lastServerModels: [] })
    const needsModel = INTEGRATION_AGENTS.find((a) => a.requiresModel)!
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(needsModel))

    expect(toast.error).toHaveBeenCalledWith(
      `launch:noRunningModelToast:${JSON.stringify({ name: needsModel.name })}`
    )
    expect(writeConfig).not.toHaveBeenCalled()
    expect(openAgent).not.toHaveBeenCalled()
    expect(useServerSetup.getState().configuredAgents).toEqual([])
    expect(useLaunchStore.getState()).toMatchObject({
      busy: { [needsModel.id]: false },
      phase: { [needsModel.id]: undefined },
    })
  })

  it('writes no config when the served model will not load', async () => {
    ensureRunning.mockRejectedValueOnce(new Error('out of memory'))
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(toast.error).toHaveBeenCalledWith(
      'launch:toast.configureFailed:{"name":"Codex CLI"}',
      { description: 'out of memory' }
    )
    expect(writeConfig).not.toHaveBeenCalled()
    expect(openAgent).not.toHaveBeenCalled()
    expect(useServerSetup.getState().configuredAgents).toEqual([])
    expect(useLaunchStore.getState().busy.codex).toBe(false)
  })

  it('reports a config write that fails, and frees the card', async () => {
    writeConfig.mockRejectedValueOnce(new Error('permission denied'))
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(toast.error).toHaveBeenCalledWith(
      'launch:toast.configureFailed:{"name":"Codex CLI"}',
      { description: 'permission denied' }
    )
    expect(openAgent).not.toHaveBeenCalled()
    expect(useLaunchStore.getState().busy.codex).toBe(false)
  })

  it('offers Install instead of a terminal when the agent is gone, and writes nothing', async () => {
    detect.mockResolvedValueOnce(false)
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(toast.error).toHaveBeenCalledWith(
      'api:agents.missingToast:{"name":"Codex CLI"}',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'api:agents.install' }),
      })
    )
    expect(writeConfig).not.toHaveBeenCalled()
    expect(openAgent).not.toHaveBeenCalled()
    expect(useServerSetup.getState().configuredAgents).toEqual([])
    expect(useLaunchStore.getState().busy.codex).toBe(false)

    // The toast's Install installs it.
    const [, options] = vi.mocked(toast.error).mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ]
    await act(async () => options.action.onClick())
    expect(installAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' }),
      expect.anything()
    )
  })

  it('writes the window the model was reloaded with', async () => {
    contextWindow.mockResolvedValueOnce({ ok: true, contextLength: 32768 })
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' }),
      'qwen3.5-4b',
      expect.anything(),
      { contextLength: 32768 }
    )
    expect(useServerSetup.getState().configuredAgents).toEqual([
      expect.objectContaining({ id: 'codex' }),
    ])
  })

  it('stops, saying the minimum, when the window cannot be grown', async () => {
    contextWindow.mockResolvedValueOnce({
      ok: false,
      reason: 'reload',
      minimum: 65536,
      contextLength: 16384,
    })
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('hermes')))

    expect(toast.error).toHaveBeenCalledWith(
      'launch:toast.contextTooSmall:{"name":"Hermes Agent","minimum":"64K"}',
      { description: 'launch:toast.contextTooSmallMemory:{"current":"16K"}' }
    )
    expect(writeConfig).not.toHaveBeenCalled()
    expect(openAgent).not.toHaveBeenCalled()
    expect(useServerSetup.getState().configuredAgents).toEqual([])
    expect(useLaunchStore.getState().busy.hermes).toBe(false)
  })

  it('installs with the card busy until the installer is done', async () => {
    let finish: (ok: boolean) => void = () => {}
    installAgent.mockReturnValueOnce(
      new Promise<boolean>((resolve) => (finish = resolve))
    )
    const { result } = renderHook(() => useAgentActions())

    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.install(agent('codex'))
    })
    expect(useLaunchStore.getState()).toMatchObject({
      busy: { codex: true },
      phase: { codex: 'installing' },
    })
    // A second click while it installs is ignored.
    await act(() => result.current.install(agent('codex')))
    expect(installAgent).toHaveBeenCalledTimes(1)

    await act(async () => {
      finish(true)
      await pending
    })
    expect(useLaunchStore.getState()).toMatchObject({
      busy: { codex: false },
      phase: { codex: undefined },
    })
  })
})
