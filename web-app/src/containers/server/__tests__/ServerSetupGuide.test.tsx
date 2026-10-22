import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { control, hub, settle, restart, writeConfig } = vi.hoisted(() => ({
  control: {
    status: 'stopped' as 'running' | 'stopped' | 'pending',
    isRunning: false,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  },
  hub: { tag: 'hub' },
  settle: vi.fn(),
  restart: vi.fn(),
  writeConfig: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    hash,
    className,
  }: {
    children: React.ReactNode
    to: string
    hash?: string
    className?: string
  }) => (
    <a href={hash ? `${to}#${hash}` : to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => control,
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => hub }))
vi.mock('@/hooks/useRemoteAccess', () => ({
  startLocalApiServerAndSettle: settle,
  restartLocalApiServer: restart,
}))
vi.mock('@/lib/integration-agent-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/integration-agent-setup')>()),
  writeAgentConfig: writeConfig,
}))

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useLaunchStore } from '@/stores/launch-store'
import {
  useOnboardingStore,
  type OnboardingDestination,
} from '@/stores/onboarding-store'

import { ServerSetupGuide } from '../ServerSetupGuide'

const QWEN = { provider: 'llamacpp-upstream', model: 'qwen3.5-4b' }

const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }))
const configure = async () => {
  await act(async () => {
    click('api:guide.configure')
  })
}

describe('Server setup guide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settle.mockResolvedValue(true)
    restart.mockResolvedValue(true)
    writeConfig.mockResolvedValue(undefined)
    useAppState.setState({ serverStatus: 'stopped' })
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: 'sk-atomic-key',
      defaultModelLocalApiServer: null,
      lastServerModels: [],
    })
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          persist: true,
          settings: [],
          models: [{ id: 'qwen3.5-4b' }, { id: 'gemma-4' }],
        } as unknown as ModelProvider,
      ],
    })
    useLaunchStore.setState({ installed: { codex: true } })
    useServerSetup.setState({
      setupDone: false,
      setupDismissed: false,
      configuredAgents: [],
      endpointConfigured: false,
      guide: null,
      guideRevision: 0,
      guideActive: false,
    })
    useOnboardingStore.getState().reset()
  })

  it('connects an agent: saves the model, starts the server with it, writes the agent config', async () => {
    render(<ServerSetupGuide entry={{ path: 'choose' }} />)

    click(/api:guide\.agentChoice/)
    click(/Codex CLI/)
    expect(
      screen.getByText('api:guide.reviewAgentTitle:{"name":"Codex CLI"}')
    ).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:1337/v1')).toBeInTheDocument()

    await configure()

    expect(
      await screen.findByText('api:guide.doneAgentTitle:{"name":"Codex CLI"}')
    ).toBeInTheDocument()
    expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual(
      QWEN
    )
    expect(settle).toHaveBeenCalledWith(control.start, { ensureModel: true })
    expect(restart).not.toHaveBeenCalled()
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' }),
      'qwen3.5-4b',
      expect.objectContaining({ serverPort: 1337, apiKey: 'sk-atomic-key' })
    )
    expect(useServerSetup.getState()).toMatchObject({
      setupDone: true,
      configuredAgents: [expect.objectContaining({ id: 'codex' })],
    })
  })

  it('leaves a running server alone when it already serves the chosen model', async () => {
    useAppState.setState({ serverStatus: 'running' })
    useLocalApiServer.setState({ lastServerModels: [QWEN] })
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    await configure()

    expect(
      await screen.findByText(/api:guide\.doneAgentTitle/)
    ).toBeInTheDocument()
    expect(settle).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    // The agent still counts as set up, against the model already loaded.
    expect(useServerSetup.getState()).toMatchObject({
      setupDone: true,
      configuredAgents: [expect.objectContaining({ id: 'codex' })],
    })
  })

  it('restarts a running server to load another model', async () => {
    useAppState.setState({ serverStatus: 'running' })
    // The guide opens on the saved model; the server still runs another.
    useLocalApiServer.setState({
      defaultModelLocalApiServer: QWEN,
      lastServerModels: [{ provider: 'llamacpp-upstream', model: 'gemma-4' }],
    })
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    await configure()

    expect(
      await screen.findByText(/api:guide\.doneAgentTitle/)
    ).toBeInTheDocument()
    expect(restart).toHaveBeenCalledWith(hub, control, { ensureModel: true })
    // The restart serves the model the guide was set to, not the old one.
    expect(useLocalApiServer.getState().defaultModelLocalApiServer).toEqual(
      QWEN
    )
  })

  it('says which step failed and retries from there', async () => {
    settle.mockResolvedValueOnce(false)
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    await configure()

    expect(screen.getByText('api:guide.errorTitle')).toBeInTheDocument()
    expect(screen.getByText('api:guide.serverFailed')).toBeInTheDocument()
    expect(screen.getByText('api:guide.taskServer').closest('li')).toHaveClass(
      'failed'
    )
    expect(writeConfig).not.toHaveBeenCalled()

    await act(async () => {
      click('api:guide.retry')
    })

    await screen.findByText(/api:guide\.doneAgentTitle/)
    expect(settle).toHaveBeenCalledTimes(2)
    expect(writeConfig).toHaveBeenCalledTimes(1)
  })

  it('prepares an endpoint on the port the user picked', async () => {
    render(<ServerSetupGuide entry={{ path: 'endpoint' }} />)

    fireEvent.change(screen.getByLabelText('api:guide.port'), {
      target: { value: '70000' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('api:guide.portInvalid')
    expect(
      screen.getByRole('button', { name: /api:guide\.continue/ })
    ).toBeDisabled()

    fireEvent.change(screen.getByLabelText('api:guide.port'), {
      target: { value: '8080' },
    })
    click(/api:guide\.continue/)
    await configure()

    await screen.findByText('api:guide.doneEndpointTitle')
    expect(useLocalApiServer.getState().serverPort).toBe(8080)
    expect(useServerSetup.getState().endpointConfigured).toBe(true)
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('says when the chosen agent is not installed yet, with the way to install it', () => {
    useLaunchStore.setState({ installed: { codex: false } })
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    expect(
      screen.getByText('api:guide.notInstalled:{"name":"Codex CLI"}')
    ).toBeInTheDocument()
    expect(
      screen.getByText('api:agents.allIntegrations').closest('a')
    ).toHaveAttribute('href', '/launch/#codex')
  })

  it('stays out of the way once closed on a first visit', () => {
    render(<ServerSetupGuide entry={{ path: 'choose' }} />)

    click('api:guide.close')

    expect(useServerSetup.getState()).toMatchObject({
      guideActive: false,
      setupDismissed: true,
    })
  })

  it('sends the user to the Hub when no engine has a model', () => {
    useModelProvider.setState({ providers: [] })
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    expect(screen.getByText('api:model.emptyBody')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /api:guide\.configure/ })
    ).toBeDisabled()
  })
})

describe('Server setup guide during first-run setup', () => {
  const guideHint = () =>
    screen.queryByRole('region', { name: 'onboarding-server:guide.label' })

  /** A run handed off to `destination`, its chat model downloading or not. */
  const handedOff = (
    destination: OnboardingDestination,
    downloading: boolean
  ) => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'server')
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'qwen3.5-4b',
      phase: downloading ? 'running' : 'done',
    })
    store.handOff(destination)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    settle.mockResolvedValue(true)
    writeConfig.mockResolvedValue(undefined)
    useAppState.setState({ serverStatus: 'stopped' })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: null,
      lastServerModels: [],
    })
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          persist: true,
          settings: [],
          models: [{ id: 'qwen3.5-4b' }],
        } as unknown as ModelProvider,
      ],
    })
    useServerSetup.setState({
      setupDone: false,
      configuredAgents: [],
      guide: null,
      guideActive: false,
    })
    useOnboardingStore.getState().reset()
  })

  it('shows "Connect your tool" until the work starts, and ends the hints once connected', async () => {
    handedOff('agents', false)
    useOnboardingStore.getState().setGuide({ path: 'agents', hint: 1 })
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    expect(guideHint()).toHaveTextContent(
      'onboarding-server:guide.connect.title'
    )

    await configure()

    expect(
      await screen.findByText(/api:guide\.doneAgentTitle/)
    ).toBeInTheDocument()
    expect(guideHint()).toBeNull()
    expect(useOnboardingStore.getState().guide).toBeNull()
    expect(useServerSetup.getState().setupDone).toBe(true)
  })

  it('waits for the model first-run setup is downloading for the server', () => {
    handedOff('agents', true)
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    const configureButton = screen.getByRole('button', {
      name: /onboarding-server:guide\.waitingForModel/,
    })
    expect(configureButton).toBeDisabled()

    act(() => useOnboardingStore.getState().setJobPhase('chat', 'done'))

    expect(
      screen.getByRole('button', { name: /api:guide\.configure/ })
    ).toBeEnabled()
  })

  it('does not wait when setup handed off to chat', () => {
    handedOff('chat', true)
    render(<ServerSetupGuide entry={{ path: 'agent', agentId: 'codex' }} />)

    expect(
      screen.getByRole('button', { name: /api:guide\.configure/ })
    ).toBeEnabled()
    expect(guideHint()).toBeNull()
  })
})

describe('Server setup guide holds itself open', () => {
  it('marks itself on screen when shown', async () => {
    useServerSetup.setState({ guideActive: false })
    render(<ServerSetupGuide entry={{ path: 'choose' }} />)
    await waitFor(() =>
      expect(useServerSetup.getState().guideActive).toBe(true)
    )
  })
})
