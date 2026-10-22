import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServerSetup } from '@/hooks/useServerSetup'
import type { StepContext } from '@/lib/onboarding/steps'
import {
  useOnboardingStore,
  type OnboardingChoice,
} from '@/stores/onboarding-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  context: {
    winOrLinux: false,
    backendStepDone: false,
    permissionRows: 0,
    cloudProviders: 0,
    mediaCards: 0,
    localApiServer: true,
  } as StepContext,
  helper: {
    supported: false,
    options: [] as { value: string; label: string }[],
    active: 'none',
    apply: vi.fn(),
  },
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({
    children,
    to,
    hash,
    className,
    ...rest
  }: {
    children: React.ReactNode
    to: string
    hash?: string
    className?: string
  }) => (
    <a href={hash ? `${to}#${hash}` : to} className={className} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('../useStepContext', () => ({
  useStepContext: () => mocks.context,
}))
vi.mock('../steps/ModelStep', () => ({
  ModelStep: () => <h1 tabIndex={-1}>model step</h1>,
}))
// The real hook loads models and talks to the proxy. This stand-in keeps its
// contract: `status` follows the app state, which toggling moves.
vi.mock('@/hooks/useLocalApiServerControl', async () => {
  const { useAppState: appState } = await import('@/hooks/useAppState')
  const setStatus = (status: 'running' | 'stopped') =>
    appState.getState().setServerStatus(status)
  return {
    useLocalApiServerControl: () => {
      const status = appState((state) => state.serverStatus)
      return {
        status,
        isRunning: status !== 'stopped',
        isModelLoading: false,
        isBusy: status === 'pending',
        start: async () => setStatus('running'),
        stop: async () => setStatus('stopped'),
        toggle: async () =>
          setStatus(
            appState.getState().serverStatus === 'stopped'
              ? 'running'
              : 'stopped'
          ),
        refreshStatus: vi.fn(),
      }
    },
  }
})
// The embedding and decision stores talk to the core.
vi.mock('@/containers/server/useServedHelperModels', () => ({
  NO_HELPER_MODEL: 'none',
  useServedEmbeddingModels: () => mocks.helper,
  useServedDecisionModels: () => mocks.helper,
}))
// The request channel and the agent probe are the shell's.
vi.mock('@/hooks/useApiServerLogFeed', () => ({
  useApiServerLogFeed: () => ({ clear: vi.fn(), hydrate: vi.fn() }),
}))
vi.mock('@/hooks/useApiServerModelNotices', () => ({
  useApiServerModelNotices: () => {},
}))
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: vi.fn(),
}))

import { ServerControlPanel } from '@/containers/ServerControlPanel'
import { ServerOverviewPage } from '@/routes/api/index'
import { ServerModelPage } from '@/routes/api/model'
import { ServerConfigurationPage } from '@/routes/settings/local-api-server'

import { Onboarding } from '../Onboarding'

const QWEN_ID = 'Qwen3.5-4B-Q4_K_M'
const QWEN: OnboardingChoice = {
  source: 'download',
  provider: 'llamacpp-upstream',
  modelId: QWEN_ID,
  title: 'Qwen3.5 4B',
  matchIds: [QWEN_ID],
}

const GUIDE = 'onboarding-server:guide.label'
const click = (name: RegExp | string) =>
  fireEvent.click(screen.getByRole('button', { name }))
const hint = () => screen.getByRole('region', { name: GUIDE })
const noHint = () => screen.queryByRole('region', { name: GUIDE }) === null
const named = (event: string) =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === event)
    .map(([, props]) => props as Record<string, unknown>)

/** The server step with Qwen chosen: downloading, or already on disk. */
function atServerStep(downloaded: boolean) {
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp-upstream',
        active: true,
        persist: true,
        settings: [],
        models: downloaded ? [{ id: QWEN_ID }] : [],
      },
    ],
  } as never)
  const store = useOnboardingStore.getState()
  store.begin('full', 'server')
  store.choose(QWEN)
  store.enqueue({
    key: 'chat',
    kind: 'chat',
    title: QWEN.title,
    taskId: QWEN_ID,
    phase: downloaded ? 'done' : 'running',
  })
  render(<Onboarding />)
}

describe('server handoff from first-run setup', () => {
  beforeEach(() => {
    vi.mocked(posthog.capture).mockClear()
    mocks.navigate.mockClear()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useAppState.setState({ serverStatus: 'stopped' })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: null,
      lastServerModels: [],
    })
    useServerSetup.setState({
      setupDone: false,
      setupDismissed: false,
      configuredAgents: [],
      endpointConfigured: false,
      guide: null,
      guideActive: false,
      guideRevision: 0,
    })
  })

  it('endpoint handoff opens actual settings, stays stopped and offers contextual hints', () => {
    atServerStep(false)
    click(/onboarding-server:server\.endpoint/)
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: '/settings/local-api-server' })
    )
    cleanup()

    render(<ServerConfigurationPage />)
    expect(
      within(hint()).getByText('onboarding-server:guide.settings.title')
    ).toBeInTheDocument()
    expect(
      within(hint()).getByText('onboarding-server:guide.downloading')
    ).toBeInTheDocument()
    click('onboarding-server:guide.next')
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/api/model' })
    expect(noHint()).toBe(true)
    cleanup()

    render(<ServerModelPage />)
    expect(
      within(hint()).getByText('onboarding-server:guide.model.title')
    ).toBeInTheDocument()
    click('onboarding-server:guide.next')
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/api/' })
    cleanup()

    render(
      <>
        <ServerControlPanel />
        <ServerOverviewPage />
      </>
    )
    // The first-visit guide stays closed, so Overview does not compete with
    // the Start hint.
    expect(
      screen.queryByRole('region', { name: 'api:guide.label' })
    ).not.toBeInTheDocument()
    expect(
      within(hint()).getByText('onboarding-server:guide.start.title')
    ).toBeInTheDocument()
    const start = screen.getByTestId('server-panel-power')
    expect(start).toBeDisabled()
    expect(start).toHaveAttribute(
      'title',
      'onboarding-server:guide.stillDownloading'
    )

    act(() => useOnboardingStore.getState().setJobPhase('chat', 'done'))

    expect(start).toBeEnabled()
    expect(start).not.toHaveAttribute('title')
    expect(
      within(hint()).queryByText('onboarding-server:guide.downloading')
    ).not.toBeInTheDocument()
    // Nothing on the way started the server.
    expect(useAppState.getState().serverStatus).toBe('stopped')
    expect(named('onboarding_guide')).toEqual([
      expect.objectContaining({
        guide_path: 'endpoint',
        hint: 0,
        guide_action: 'next',
      }),
      expect.objectContaining({
        guide_path: 'endpoint',
        hint: 1,
        guide_action: 'next',
      }),
    ])
  })

  it('agent handoff opens agents without auto-starting the server', () => {
    atServerStep(true)
    click(/onboarding-server:server\.agents/)
    expect(mocks.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: '/api/' })
    )
    cleanup()

    render(<ServerOverviewPage />)
    expect(
      screen.queryByRole('region', { name: 'api:guide.label' })
    ).not.toBeInTheDocument()
    expect(
      within(hint()).getByText('onboarding-server:guide.pick.title')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'api:agents.title' })
    ).toHaveClass('ob-agent-pick')

    click('api:agents.configureAgent Codex CLI')

    const guide = screen.getByRole('region', { name: 'api:guide.label' })
    expect(
      within(guide).getByText('onboarding-server:guide.connect.title')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('onboarding-server:guide.pick.title')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'api:agents.title' })
    ).not.toHaveClass('ob-agent-pick')

    click('onboarding-server:guide.skip')

    expect(noHint()).toBe(true)
    expect(useOnboardingStore.getState()).toMatchObject({
      guide: null,
      panelDismissed: true,
    })
    // The setup guide the user opened stays; only the hints went.
    expect(
      screen.getByRole('region', { name: 'api:guide.label' })
    ).toBeVisible()
    expect(useAppState.getState().serverStatus).toBe('stopped')
  })

  it('download-ready model carries through endpoint handoff and enables Start', () => {
    atServerStep(true)
    click(/onboarding-server:server\.endpoint/)
    cleanup()
    mocks.navigate.mockClear()

    render(<ServerControlPanel />)
    const start = screen.getByTestId('server-panel-power')
    expect(start).toBeEnabled()

    act(() => {
      fireEvent.click(start)
    })

    expect(useAppState.getState().serverStatus).toBe('running')
    // Started directly: the setup guide was not opened on Overview.
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(useServerSetup.getState()).toMatchObject({
      guideActive: false,
      setupDone: true,
      endpointConfigured: true,
    })
    expect(useOnboardingStore.getState().guide).toBeNull()
    expect(named('onboarding_guide')).toEqual([
      expect.objectContaining({
        guide_path: 'endpoint',
        hint: 0,
        guide_action: 'done',
      }),
    ])
  })

  it('Everyday use opens the workspace directly when the model is already downloaded', () => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          persist: true,
          settings: [],
          models: [{ id: QWEN_ID }],
        },
      ],
    } as never)
    const store = useOnboardingStore.getState()
    store.begin('full', 'purpose')
    store.choose({ ...QWEN, source: 'library' })
    render(<Onboarding />)

    click(/onboarding-server:purpose\.everyday/)

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/',
      replace: true,
      search: {
        threadModel: { id: QWEN_ID, provider: 'llamacpp-upstream' },
      },
    })
    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'chat',
      guide: null,
    })
    expect(useModelProvider.getState().selectedModel?.id).toBe(QWEN_ID)
  })
})
