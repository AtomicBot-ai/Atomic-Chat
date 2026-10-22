import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'
import { useServerSetup } from '@/hooks/useServerSetup'
import {
  useOnboardingStore,
  type OnboardingGuide,
} from '@/stores/onboarding-store'
import { ServerControlPanel } from '../ServerControlPanel'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/utils', () => ({
  getProviderTitle: (provider: string) => `title:${provider}`,
}))

// The downloaded models, where a model's nickname lives.
const installed = vi.hoisted(() => ({
  providers: [] as { provider: string; models: Partial<Model>[] }[],
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (state: unknown) => unknown) =>
    selector({
      getProviderByName: (name: string) =>
        installed.providers.find((p) => p.provider === name),
    }),
}))

const control = vi.hoisted(() => ({
  status: 'stopped' as 'stopped' | 'pending' | 'running',
  isRunning: false,
  isBusy: false,
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
}))
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => control,
}))

const server = vi.hoisted(() => ({
  defaultModelLocalApiServer: null as null | {
    model: string
    provider: string
  },
  lastServerModels: [] as { model: string; provider: string }[],
}))
vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: (selector: (state: typeof server) => unknown) =>
    selector(server),
}))

const setStatus = (status: typeof control.status) => {
  control.status = status
  control.isRunning = status !== 'stopped'
  control.isBusy = status === 'pending'
}

describe('ServerControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setStatus('stopped')
    server.defaultModelLocalApiServer = null
    server.lastServerModels = []
    installed.providers = []
    control.start.mockResolvedValue(undefined)
    control.stop.mockResolvedValue(undefined)
    control.toggle.mockResolvedValue(undefined)
    useServerSetup.setState({
      setupDone: true,
      guide: null,
      guideActive: false,
      configuredAgents: [],
      endpointConfigured: false,
    })
  })

  it('starts a stopped server', async () => {
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStart')
    await userEvent.click(power)

    expect(control.toggle).toHaveBeenCalledTimes(1)
  })

  it('offers only Stop while running: saving a change applies it, so there is no Restart', async () => {
    setStatus('running')
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStop')
    expect(
      screen.queryByRole('button', { name: /restart/i })
    ).not.toBeInTheDocument()
    await userEvent.click(power)

    // The control's stop is the turn-off that also unloads the models.
    expect(control.toggle).toHaveBeenCalledTimes(1)
  })

  it('opens Engine & model from the engine and model, and Connections below them', () => {
    render(<ServerControlPanel />)

    expect(
      screen.getByText('common:navigation.engine').closest('a')
    ).toHaveAttribute('href', '/api/model')
    expect(
      screen.getByText('common:navigation.model').closest('a')
    ).toHaveAttribute('href', '/api/model')
    expect(
      screen.getByText('common:navigation.connections').closest('a')
    ).toHaveAttribute('href', '/api/connections')
  })

  it('locks the power button while the server is starting', () => {
    setStatus('pending')
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStarting')
    expect(power).toBeDisabled()
  })

  it('shows the model the next start will load', () => {
    server.defaultModelLocalApiServer = {
      model: 'qwen3.5-4b',
      provider: 'llamacpp-upstream',
    }
    render(<ServerControlPanel />)

    expect(screen.getByText('title:llamacpp-upstream')).toBeInTheDocument()
    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
  })

  it('shows what a running server actually loaded', () => {
    setStatus('running')
    server.defaultModelLocalApiServer = {
      model: 'qwen3.5-4b',
      provider: 'llamacpp-upstream',
    }
    server.lastServerModels = [{ model: 'gemma-4-e2b', provider: 'mlx' }]
    render(<ServerControlPanel />)

    expect(screen.getByText('title:mlx')).toBeInTheDocument()
    expect(screen.getByText('Gemma 4 E2B')).toBeInTheDocument()
  })

  it('names the model once, with its quant apart and its full id on the row', () => {
    server.defaultModelLocalApiServer = {
      model: 'AtomicChat/Muse-Glimmer-30B-AD-IQ4_XS',
      provider: 'llamacpp-upstream',
    }
    render(<ServerControlPanel />)

    const row = screen.getByTestId('server-panel-model')
    expect(row).toHaveAttribute(
      'title',
      'AtomicChat/Muse-Glimmer-30B-AD-IQ4_XS'
    )
    expect(row).toHaveAttribute('href', '/api/model')
    expect(within(row).getByText('Muse Glimmer 30B AD').tagName).toBe('STRONG')
    expect(within(row).getByText('IQ4_XS').tagName).toBe('SMALL')
    expect(row).not.toHaveTextContent('AtomicChat')
  })

  it("shows the model's nickname, and its quant only when the name lacks it", () => {
    server.defaultModelLocalApiServer = {
      model: 'AtomicChat/Muse-Glimmer-30B-AD-IQ4_XS',
      provider: 'llamacpp-upstream',
    }
    installed.providers = [
      {
        provider: 'llamacpp-upstream',
        models: [
          {
            id: 'AtomicChat/Muse-Glimmer-30B-AD-IQ4_XS',
            displayName: 'Muse for code',
          },
        ],
      },
    ]
    const { unmount } = render(<ServerControlPanel />)

    let row = screen.getByTestId('server-panel-model')
    expect(within(row).getByText('Muse for code')).toBeInTheDocument()
    expect(within(row).getByText('IQ4_XS')).toBeInTheDocument()
    unmount()

    // A nickname that spells the quant already reads it.
    installed.providers[0].models[0].displayName = 'Muse IQ4_XS'
    render(<ServerControlPanel />)
    row = screen.getByTestId('server-panel-model')
    expect(within(row).getByText('Muse IQ4_XS')).toBeInTheDocument()
    expect(row.querySelector('small')).toBeNull()
  })

  it('shows no quant for an id that names none', () => {
    server.defaultModelLocalApiServer = {
      model: 'qwen3.5-4b',
      provider: 'llamacpp-upstream',
    }
    render(<ServerControlPanel />)

    expect(
      screen.getByTestId('server-panel-model').querySelector('small')
    ).toBeNull()
  })

  it('says when no model is chosen', () => {
    render(<ServerControlPanel />)

    expect(screen.getAllByText('common:navigation.notSelected')).toHaveLength(2)
  })

  it('opens the setup guide on Overview instead of starting a server never set up', async () => {
    useServerSetup.setState({ setupDone: false })
    render(<ServerControlPanel />)

    await userEvent.click(screen.getByTestId('server-panel-power'))

    expect(control.toggle).not.toHaveBeenCalled()
    expect(useServerSetup.getState().guideActive).toBe(true)
    expect(navigate).toHaveBeenCalledWith({ to: '/api/' })
  })

  it('counts the tools set up to use the server', () => {
    useServerSetup.setState({
      configuredAgents: [
        { id: 'codex', at: 1 },
        { id: 'claude-code', at: 2 },
      ],
      endpointConfigured: true,
    })
    render(<ServerControlPanel />)

    expect(
      screen.getByText('common:navigation.connectionsCount')
    ).toBeInTheDocument()
  })

  describe('during first-run setup', () => {
    /** A run handed off to the server, on `guide`, its model downloading or not. */
    const handedOff = (guide: OnboardingGuide, downloading: boolean) => {
      const store = useOnboardingStore.getState()
      store.reset()
      store.begin('full', 'server')
      store.enqueue({
        key: 'chat',
        kind: 'chat',
        title: 'Qwen3.5 4B',
        taskId: 'Qwen3.5-4B-Q4_K_M',
        phase: downloading ? 'running' : 'done',
      })
      store.handOff(guide.path)
      store.setGuide(guide)
    }
    const guideHint = () =>
      screen.queryByRole('region', { name: 'onboarding-server:guide.label' })

    beforeEach(() => {
      vi.mocked(posthog.capture).mockClear()
      useServerSetup.setState({ setupDone: false, setupDismissed: true })
    })

    it('shows the Start hint, and holds Start until the model has downloaded', () => {
      handedOff({ path: 'endpoint', hint: 2 }, true)
      render(<ServerControlPanel />)

      expect(guideHint()).toHaveTextContent(
        'onboarding-server:guide.start.title'
      )
      const power = screen.getByTestId('server-panel-power')
      expect(power).toBeDisabled()
      expect(power).toHaveAttribute(
        'title',
        'onboarding-server:guide.stillDownloading'
      )

      act(() => useOnboardingStore.getState().setJobPhase('chat', 'done'))

      expect(power).toBeEnabled()
      expect(power).not.toHaveAttribute('title')
    })

    it('holds Start on the earlier endpoint hints too, where the hint itself is not shown', () => {
      handedOff({ path: 'endpoint', hint: 0 }, true)
      render(<ServerControlPanel />)

      expect(guideHint()).toBeNull()
      expect(screen.getByTestId('server-panel-power')).toBeDisabled()
    })

    it('starts the server directly instead of opening the setup guide, and ends the hints', async () => {
      handedOff({ path: 'endpoint', hint: 1 }, false)
      render(<ServerControlPanel />)

      await userEvent.click(screen.getByTestId('server-panel-power'))

      expect(control.toggle).toHaveBeenCalledTimes(1)
      expect(navigate).not.toHaveBeenCalled()
      expect(useServerSetup.getState()).toMatchObject({
        guideActive: false,
        setupDone: true,
        endpointConfigured: true,
      })
      expect(useOnboardingStore.getState().guide).toBeNull()
      expect(
        vi
          .mocked(posthog.capture)
          .mock.calls.filter(([name]) => name === 'onboarding_guide')
          .map(([, props]) => props)
      ).toEqual([
        expect.objectContaining({
          guide_path: 'endpoint',
          hint: 1,
          guide_action: 'done',
        }),
      ])
    })

    it('leaves Start as it is on the agents hints', async () => {
      handedOff({ path: 'agents', hint: 0 }, true)
      render(<ServerControlPanel />)

      const power = screen.getByTestId('server-panel-power')
      expect(power).toBeEnabled()
      await userEvent.click(power)

      // A server never set up still opens the setup guide.
      expect(control.toggle).not.toHaveBeenCalled()
      expect(useServerSetup.getState().guideActive).toBe(true)
      expect(useOnboardingStore.getState().guide).toEqual({
        path: 'agents',
        hint: 0,
      })
    })

    it('lets a running server stop while the model downloads', () => {
      setStatus('running')
      handedOff({ path: 'endpoint', hint: 2 }, true)
      render(<ServerControlPanel />)

      expect(screen.getByTestId('server-panel-power')).toBeEnabled()
    })
  })
})
