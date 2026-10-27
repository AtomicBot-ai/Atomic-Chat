import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { start, settle, writeConfig, installAgent, openAgent } = vi.hoisted(
  () => ({
    start: vi.fn(),
    settle: vi.fn(),
    writeConfig: vi.fn(),
    installAgent: vi.fn(),
    openAgent: vi.fn(),
  })
)

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
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
vi.mock('@/lib/integration-agent-run', () => ({
  installIntegrationAgent: installAgent,
  openIntegrationAgent: openAgent,
}))
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgent: vi.fn(),
}))

import { INTEGRATION_AGENTS } from '@/constants/integrations'
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
    writeConfig.mockResolvedValue(undefined)
    installAgent.mockResolvedValue(true)
    openAgent.mockResolvedValue(true)
    useAppState.setState({ serverStatus: 'running' })
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      defaultModelLocalApiServer: null,
      lastServerModels: [QWEN],
    })
    useLaunchStore.setState({ busy: {}, phase: {} })
    useServerSetup.setState({ configuredAgents: [] })
  })

  it('connects: points the agent at the served model, then opens it', async () => {
    const { result } = renderHook(() => useAgentActions())

    await act(() => result.current.connect(agent('codex')))

    expect(settle).not.toHaveBeenCalled()
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' }),
      'qwen3.5-4b',
      expect.objectContaining({ serverPort: 1337 })
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
    expect(openAgent).toHaveBeenCalledTimes(1)

    settle.mockResolvedValueOnce(false)
    await act(() => result.current.connect(agent('codex')))
    // The failed start said why itself; nothing is written or opened.
    expect(writeConfig).toHaveBeenCalledTimes(1)
    expect(openAgent).toHaveBeenCalledTimes(1)
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
