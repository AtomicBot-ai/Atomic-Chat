import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { seedServiceHub } from '@/test/service-hub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelSetupStore } from '@/stores/model-setup-store'
import { DefaultModelSetupService } from '@/services/model-setup/default'
import type {
  CompatibilityVerdict,
  ModelSetup,
  ModelSetupPlan,
} from '@/services/model-setup/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

import { ModelSetupSheet } from '../ModelSetupSheet'

const file = {
  repo: 'prism-ml/Bonsai-8B-gguf',
  file: 'Bonsai-8B-PQ2_0.gguf',
  revision: 'main',
}

const verdict = (
  outcome: CompatibilityVerdict['outcome'] = 'engine_required'
): CompatibilityVerdict => ({
  outcome,
  provider: 'atomic-prism',
  requires: ['PQ2_0'],
  evidence: 'rules',
  rules_version: 1,
  reason: 'r',
})

const plan = (overrides: Partial<ModelSetupPlan> = {}): ModelSetupPlan => ({
  digest: 'digest-1',
  model_id: 'prism-ml/Bonsai-8B-PQ2_0',
  provider: 'atomic-prism',
  verdict: verdict(),
  engine: {
    provider: 'atomic-prism',
    version: 'prism-b9000-abcdef0',
    backend: 'macos-arm64',
    installed: false,
    download_size: 20_000_000,
  },
  model: { ...file, size: 2_000_000_000 },
  projector: { ...file, file: 'mmproj.gguf', size: 500_000_000 },
  total_download_bytes: 2_520_000_000,
  free_bytes: 100_000_000_000,
  blockers: [],
  ...overrides,
})

const setup = (overrides: Partial<ModelSetup> = {}): ModelSetup => ({
  setup_id: 's1',
  request_id: 'r1',
  revision: 1,
  stage: 'downloading_model',
  request: file,
  plan: plan(),
  task_ids: { engine: 'te', model: 'tm', projector: 'tp' },
  created_at: 1,
  updated_at: 1,
  ...overrides,
})

class FakeService extends DefaultModelSetupService {
  plan = vi.fn(async () => plan())
  start = vi.fn(async () => setup({ stage: 'queued' }))
  cancel = vi.fn(async () => setup({ stage: 'cancelled', revision: 9 }))
  resume = vi.fn(async () => setup({ stage: 'downloading_model', revision: 9 }))
  override isSupported() {
    return true
  }
}

let service: FakeService
const onReady = vi.fn()

const renderSheet = ({ installed = false } = {}) =>
  render(
    <ModelSetupSheet
      open
      onOpenChange={() => {}}
      file={file}
      modelName="Bonsai 8B"
      modelId="prism-ml/Bonsai-8B-PQ2_0"
      installed={installed}
      onReady={onReady}
    />
  )

describe('ModelSetupSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelSetupStore.setState({ setups: {}, progress: {}, verdicts: {} })
    useModelProvider.setState({ deletedModels: [] })
    service = new FakeService()
    seedServiceHub({ modelSetup: service })
  })

  it('shows what the setup downloads and starts it against the plan it showed', async () => {
    renderSheet()

    expect(await screen.findByTestId('model-setup-engine')).toHaveTextContent(
      'hub:prismSetupEngineDownload'
    )
    expect(service.plan).toHaveBeenCalledWith({
      ...file,
      model_id: 'prism-ml/Bonsai-8B-PQ2_0',
      include_projector: true,
    })
    expect(screen.getByText(/mmproj\.gguf/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('model-setup-start'))
    await waitFor(() => expect(service.start).toHaveBeenCalled())
    const [request] = service.start.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ]
    expect(request).toMatchObject({
      ...file,
      include_projector: true,
      plan_digest: 'digest-1',
    })
    expect(request.request_id).toEqual(expect.any(String))
    expect(await screen.findByTestId('model-setup-stage')).toHaveTextContent(
      'hub:prismStage_queued'
    )
  })

  it('plans again without the projector when image support is turned off', async () => {
    renderSheet()
    const toggle = await screen.findByTestId('model-setup-vision')
    service.plan.mockResolvedValue(plan({ projector: null }))

    fireEvent.click(toggle)

    await waitFor(() =>
      expect(service.plan).toHaveBeenLastCalledWith(
        expect.objectContaining({ include_projector: false })
      )
    )
    await waitFor(() => expect(screen.queryByText(/mmproj\.gguf/)).toBeNull())
  })

  it('reviews a plan that went stale instead of starting a different one', async () => {
    service.start.mockRejectedValueOnce({
      code: 'MODEL_SETUP_PLAN_STALE',
      message: 'stale',
    })
    renderSheet()
    await screen.findByTestId('model-setup-engine')

    fireEvent.click(screen.getByTestId('model-setup-start'))

    expect(
      await screen.findByText('hub:prismSetupPlanChanged')
    ).toBeInTheDocument()
    expect(service.plan).toHaveBeenCalledTimes(2)
    expect(service.start).toHaveBeenCalledTimes(1)
  })

  it('cannot start a plan with blockers and says why', async () => {
    service.plan.mockResolvedValue(
      plan({
        blockers: [
          {
            code: 'insufficient_disk_space',
            message: 'Not enough disk space.',
          },
        ],
      })
    )
    renderSheet()

    expect(
      await screen.findByText('Not enough disk space.')
    ).toBeInTheDocument()
    expect(screen.getByTestId('model-setup-start')).toBeDisabled()
  })

  it('says a newer engine is coming next to the current one', async () => {
    service.plan.mockResolvedValue(
      plan({ verdict: verdict('engine_update_required') })
    )
    renderSheet()

    expect(
      await screen.findByTestId('model-setup-engine-update')
    ).toHaveTextContent('hub:prismEngineUpdateRequired')
  })

  it('follows a running setup and cancels it', async () => {
    useModelSetupStore.setState({
      setups: { s1: setup() },
      progress: { tm: { transferred: 1_000_000_000, total: 2_000_000_000 } },
    })
    renderSheet()

    expect(screen.getByTestId('model-setup-stage')).toHaveTextContent(
      'hub:prismStage_downloading_model'
    )
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(service.plan).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))
    await waitFor(() => expect(service.cancel).toHaveBeenCalledWith('s1'))
  })

  it('resumes a setup the app closed on', async () => {
    useModelSetupStore.setState({
      setups: {
        s1: setup({ stage: 'interrupted', stopped_at: 'downloading_model' }),
      },
    })
    renderSheet()

    expect(screen.getByText('hub:prismSetupInterrupted')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'hub:prismSetupResume' })
    )
    await waitFor(() => expect(service.resume).toHaveBeenCalledWith('s1'))
  })

  it('offers another try after a failure', async () => {
    useModelSetupStore.setState({
      setups: {
        s1: setup({
          stage: 'failed',
          error: { code: 'DOWNLOAD_FAILED', message: 'network down' },
        }),
      },
    })
    renderSheet()

    expect(screen.getByText(/hub:prismSetupFailed/)).toHaveTextContent(
      'network down'
    )
    expect(await screen.findByTestId('model-setup-start')).toHaveTextContent(
      'hub:prismSetupRetry'
    )
  })

  it('opens a chat once the model is ready', async () => {
    renderSheet()
    await screen.findByTestId('model-setup-engine')

    // Ready just now: the providers are still being read again, so the model
    // is not listed yet.
    act(() => {
      useModelSetupStore.getState().apply({
        type: 'changed',
        setup: setup({ stage: 'ready', revision: 5, updated_at: Date.now() }),
      })
    })

    expect(screen.getByTestId('model-setup-stage')).toHaveTextContent(
      'hub:prismStage_ready'
    )
    fireEvent.click(screen.getByTestId('model-setup-new-chat'))
    expect(onReady).toHaveBeenCalledWith('prism-ml/Bonsai-8B-PQ2_0')
  })

  it('keeps offering the chat of an installed model set up before this launch', () => {
    useModelSetupStore.setState({ setups: { s1: setup({ stage: 'ready' }) } })
    renderSheet({ installed: true })

    expect(screen.getByTestId('model-setup-new-chat')).toBeInTheDocument()
    expect(service.plan).not.toHaveBeenCalled()
  })

  it('sets the model up again once it was deleted, instead of a chat with nothing', async () => {
    useModelSetupStore.setState({
      setups: { s1: setup({ stage: 'ready', updated_at: Date.now() }) },
    })
    useModelProvider.setState({ deletedModels: ['prism-ml/Bonsai-8B-PQ2_0'] })
    renderSheet()

    expect(await screen.findByTestId('model-setup-start')).toHaveTextContent(
      'hub:prismSetupStart'
    )
    expect(screen.queryByTestId('model-setup-new-chat')).toBeNull()
    expect(screen.queryByTestId('model-setup-stage')).toBeNull()

    await screen.findByTestId('model-setup-engine')
    fireEvent.click(screen.getByTestId('model-setup-start'))
    await waitFor(() => expect(service.start).toHaveBeenCalled())
  })

  it('sets the model up again when a setup from before this launch left no model', async () => {
    useModelSetupStore.setState({ setups: { s1: setup({ stage: 'ready' }) } })
    renderSheet()

    expect(await screen.findByTestId('model-setup-engine')).toBeInTheDocument()
    expect(screen.queryByTestId('model-setup-new-chat')).toBeNull()
    expect(screen.getByTestId('model-setup-start')).toHaveTextContent(
      'hub:prismSetupStart'
    )
  })
})
