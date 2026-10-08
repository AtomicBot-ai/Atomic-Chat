import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'

const mocks = vi.hoisted(() => ({
  apiSupported: true,
  arch: '',
  versionBackend: undefined as string | undefined,
  load: vi.fn(),
  getConfig: vi.fn(),
  openLogsWindow: vi.fn(),
  checkForEngineUpdate: vi.fn(),
  recheckOptimalBackend: vi.fn(),
  downloadRecommendedBackend: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, error: mocks.toastError },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
  }: {
    to: string
    search?: Record<string, string>
    children: React.ReactNode
  }) => (
    <a href={`${to}?${new URLSearchParams(search).toString()}`}>{children}</a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = () => ({
    decision: () => ({
      isSupported: () => mocks.apiSupported,
      load: mocks.load,
      getConfig: mocks.getConfig,
    }),
    window: () => ({ openLogsWindow: mocks.openLogsWindow }),
  })
  return { useServiceHub: hub, getServiceHub: hub }
})

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (
    selector: (s: { hardwareData: { cpu: { arch: string } } }) => unknown
  ) => selector({ hardwareData: { cpu: { arch: mocks.arch } } }),
}))

vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    ...actual,
    PlatformFeatures: { ...actual.PlatformFeatures, localInference: true },
  }
})

vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    checkForEngineUpdate: mocks.checkForEngineUpdate,
    recheckOptimalBackend: mocks.recheckOptimalBackend,
    downloadRecommendedBackend: mocks.downloadRecommendedBackend,
  }),
}))

vi.mock('@/hooks/useDecisionEngineReadiness', () => ({
  useEngineVersionBackend: () => mocks.versionBackend,
}))

vi.mock('@/containers/DecisionModelCard', () => ({
  default: ({
    model,
    startBlocked,
  }: {
    model: DecisionCatalogModel
    startBlocked?: boolean
  }) => (
    <span>{`actions for ${model.id}${startBlocked ? ' (start blocked)' : ''}`}</span>
  ),
  DecisionModelStatus: ({ model }: { model: DecisionCatalogModel }) => (
    <span>{`status of ${model.id}`}</span>
  ),
}))

import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'
import { DecisionModelsSection } from '../DecisionModelsSection'

const bind = vi.fn(() => () => {})

describe('DecisionModelsSection', () => {
  beforeEach(() => {
    mocks.apiSupported = true
    mocks.arch = ''
    mocks.versionBackend = undefined
    for (const fn of [
      mocks.load,
      mocks.getConfig,
      mocks.openLogsWindow,
      mocks.checkForEngineUpdate,
      mocks.recheckOptimalBackend,
      mocks.downloadRecommendedBackend,
      mocks.toastInfo,
      mocks.toastError,
    ])
      fn.mockReset()
    mocks.getConfig.mockResolvedValue({ config: null, status: null })
    bind.mockClear()
    useDecisionStore.setState({
      catalog: getBaselineDecisionCatalog(),
      installed: { laya: true },
      status: null,
      config: null,
      error: null,
      busy: null,
      bind,
    })
  })

  it('lists only the downloaded models, each with its actions', () => {
    render(<DecisionModelsSection />)

    expect(
      screen.getByRole('heading', { name: 'settings:decision.sectionTitle' })
    ).toBeVisible()
    expect(screen.getByText('actions for laya')).toBeVisible()
    expect(screen.getByText('status of laya')).toBeVisible()
    expect(
      screen.queryByText('actions for laya-multilingual')
    ).not.toBeInTheDocument()
    expect(bind).toHaveBeenCalledOnce()
  })

  it('sends to the Decision category of the Hub when none is downloaded', () => {
    useDecisionStore.setState({ installed: {} })
    render(<DecisionModelsSection />)

    expect(screen.getByText('settings:decision.noneTitle')).toBeVisible()
    expect(screen.getByRole('link', { name: 'common:hub' })).toHaveAttribute(
      'href',
      '/hub/?category=decision'
    )
  })

  it('shows the failure, with the engine install next to an engine too old', () => {
    useDecisionStore.setState({
      error: {
        code: 'DECISION_ENGINE_UNSUPPORTED',
        message: 'no --decision flag',
      },
    })
    render(<DecisionModelsSection />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:decision.errors.engineUnsupported'
    )
    expect(
      screen.getByRole('button', { name: 'settings:decision.installEngine' })
    ).toBeVisible()
  })

  it('offers a retry and the logs, not an install, when the start timed out', async () => {
    useDecisionStore.setState({
      error: {
        code: 'MODEL_LOAD_TIMED_OUT',
        message:
          'Could not check whether the installed engine serves the decision model: Timed out while probing llama.cpp backend capabilities.',
      },
    })
    mocks.load.mockResolvedValue({ state: 'ready' })
    render(<DecisionModelsSection />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:decision.errors.timedOut'
    )
    expect(
      screen.queryByRole('button', { name: 'settings:decision.installEngine' })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:decision.viewLogs' })
    )
    expect(mocks.openLogsWindow).toHaveBeenCalledOnce()

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:decision.retry' })
    )
    await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce())
    await waitFor(() => expect(useDecisionStore.getState().error).toBeNull())
  })

  it('keeps the failure of a retry that failed again', async () => {
    useDecisionStore.setState({
      error: { code: 'MODEL_LOAD_FAILED', message: 'exited while loading' },
    })
    mocks.load.mockRejectedValue({
      code: 'MODEL_LOAD_FAILED',
      message: 'exited again',
    })
    render(<DecisionModelsSection />)

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:decision.retry' })
    )
    await waitFor(() =>
      expect(useDecisionStore.getState().error).toEqual({
        code: 'MODEL_LOAD_FAILED',
        message: 'exited again',
      })
    )
  })

  it('treats an older core calling an unchecked engine unsupported as a retry', () => {
    useDecisionStore.setState({
      error: {
        code: 'DECISION_ENGINE_UNSUPPORTED',
        message:
          'No installed engine build can run the decision model. Install TurboQuant 1.7.0 or newer.',
        details:
          'b10298-2.0.0/macos-arm64: probe failed: Timed out while probing llama.cpp backend capabilities.',
      },
    })
    render(<DecisionModelsSection />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:decision.errors.engineNotChecked'
    )
    expect(
      screen.getByRole('button', { name: 'settings:decision.retry' })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'settings:decision.installEngine' })
    ).not.toBeInTheDocument()
  })

  it('says the update check failed instead of calling the engine up to date', async () => {
    useDecisionStore.setState({
      error: { code: 'DECISION_ENGINE_UNSUPPORTED', message: 'no --decision' },
    })
    mocks.checkForEngineUpdate.mockRejectedValue(new Error('offline'))
    render(<DecisionModelsSection />)

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:decision.installEngine' })
    )
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'settings:decision.engineUpdateCheckFailed',
        { description: 'offline' }
      )
    )
    expect(mocks.toastInfo).not.toHaveBeenCalled()
    expect(mocks.recheckOptimalBackend).not.toHaveBeenCalled()
    // Nothing is left installing: the button can be pressed again.
    expect(
      screen.getByRole('button', { name: 'settings:decision.installEngine' })
    ).toBeEnabled()
  })

  it('names the check as the evidence when the newest engine cannot run the model', async () => {
    useDecisionStore.setState({
      error: { code: 'DECISION_ENGINE_UNSUPPORTED', message: 'no --decision' },
    })
    mocks.checkForEngineUpdate.mockResolvedValue({
      updateAvailable: false,
      targetBackend: null,
    })
    mocks.recheckOptimalBackend.mockResolvedValue(null)
    render(<DecisionModelsSection />)

    fireEvent.click(
      screen.getByRole('button', { name: 'settings:decision.installEngine' })
    )
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith(
        'settings:decision.engineLatestUnsupported'
      )
    )
    expect(mocks.downloadRecommendedBackend).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'settings:decision.installEngine' })
    ).toBeEnabled()
  })

  it('renders nothing where decision models cannot run', () => {
    mocks.apiSupported = false
    const { container } = render(<DecisionModelsSection />)

    expect(container).toBeEmptyDOMElement()
    expect(bind).not.toHaveBeenCalled()
  })

  it("lists each engine's models on its own page", () => {
    useDecisionStore.setState({ installed: { 'laya': true, 'julia-1': true } })
    const { unmount } = render(
      <DecisionModelsSection provider="llamacpp-upstream" />
    )
    expect(screen.getByText('actions for julia-1')).toBeVisible()
    expect(screen.queryByText('actions for laya')).not.toBeInTheDocument()
    unmount()

    render(<DecisionModelsSection provider="llamacpp" />)
    expect(screen.getByText('actions for laya')).toBeVisible()
    expect(screen.queryByText('actions for julia-1')).not.toBeInTheDocument()
  })

  it('asks for a newer llama.cpp before a model too new for it can start', () => {
    mocks.versionBackend = 'b11344/macos-arm64'
    useDecisionStore.setState({
      installed: { 'julia-1': true, 'clef-flash': true },
    })
    render(<DecisionModelsSection provider="llamacpp-upstream" />)

    expect(
      screen.getByText('actions for julia-1 (start blocked)')
    ).toBeVisible()
    expect(
      screen.getByText('actions for clef-flash (start blocked)')
    ).toBeVisible()
    expect(
      screen.getAllByText('settings:decision.requiresEngine')
    ).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:decision.requiresEngineNotice'
    )
    expect(
      screen.getByRole('button', { name: 'settings:decision.updateEngine' })
    ).toBeVisible()
  })

  it('starts as usual once the configured build reaches the floor', () => {
    mocks.versionBackend = 'b11436/macos-arm64'
    useDecisionStore.setState({ installed: { 'clef-flash': true } })
    render(<DecisionModelsSection provider="llamacpp-upstream" />)

    expect(screen.getByText('actions for clef-flash')).toBeVisible()
    expect(screen.getByText('status of clef-flash')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a failure on the page of the engine whose model failed', () => {
    useDecisionStore.setState({
      installed: { 'julia-1': true, 'laya': true },
      config: {
        model_path: 'decision/models/julia-1/Julia-1-Q8_0.gguf',
      } as never,
      error: {
        code: 'DECISION_ENGINE_UNSUPPORTED',
        message: 'Update llama.cpp to b11370',
      },
    })
    const { unmount } = render(<DecisionModelsSection provider="llamacpp" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    unmount()

    render(<DecisionModelsSection provider="llamacpp-upstream" />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'settings:decision.errors.engineUnsupported'
    )
    expect(
      screen.getByRole('button', { name: 'settings:decision.updateEngine' })
    ).toBeVisible()
  })
})
