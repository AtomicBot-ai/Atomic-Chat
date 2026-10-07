import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A PrismML model setup runs its downloads in the core, which sends the app no
// download events: the panel lists the setup itself, so a closed setup sheet
// does not hide a multi-gigabyte download.

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const setupService = vi.hoisted(() => ({
  cancel: vi.fn(),
  resume: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({ abortDownload: vi.fn() }),
    modelSetup: () => setupService,
  }),
  getServiceHub: () => ({}),
}))
const appUpdater = vi.hoisted(() => ({
  updateState: {
    isDownloading: false,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  },
}))
vi.mock('@/hooks/useAppUpdater', () => ({ useAppUpdater: () => appUpdater }))
// The panel's rows as plain markup: what the person reads and the buttons each row offers.
vi.mock('@/containers/downloads/DownloadPanel', () => ({
  DownloadPanel: ({
    items,
  }: {
    items: Array<{
      id: string
      name?: string
      current: number
      total: number
      bytesPerSecond?: number
      paused?: boolean
      pausable?: boolean
      onResume?: () => void
      onCancel?: () => void
    }>
  }) => (
    <ul>
      {items.map((item) => (
        <li key={item.id} data-testid={`row-${item.id}`}>
          <span>{item.name ?? item.id}</span>
          <span data-testid="bytes">{`${item.current}/${item.total}`}</span>
          <span data-testid="speed">{item.bytesPerSecond ?? 0}</span>
          {item.pausable &&
            (item.paused ? (
              <button type="button" onClick={item.onResume}>
                resume
              </button>
            ) : (
              <button type="button">pause</button>
            ))}
          <button type="button" onClick={item.onCancel}>
            cancel
          </button>
        </li>
      ))}
    </ul>
  ),
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { DownloadManagement } from '../DownloadManegement'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelSetupStore } from '@/stores/model-setup-store'
import type { ModelSetup } from '@/services/model-setup/types'

const MODEL_ID = 'prism-ml/Bonsai-8B-PQ2_0'
const ROW = `row-${MODEL_ID}`

const setup = (overrides: Partial<ModelSetup> = {}): ModelSetup =>
  ({
    setup_id: 's1',
    request_id: 'r1',
    revision: 1,
    stage: 'downloading_model',
    request: { repo: 'prism-ml/Bonsai-8B-gguf', file: 'Bonsai-8B-PQ2_0.gguf' },
    plan: {
      model_id: MODEL_ID,
      engine: {
        provider: 'atomic-prism',
        version: 'prism-b9000-abcdef0',
        backend: 'macos-arm64',
        installed: false,
        download_size: 100,
      },
      model: { size: 1000 },
      projector: null,
    },
    task_ids: { engine: 'te', model: 'tm' },
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }) as ModelSetup

describe('DownloadManagement — a PrismML model setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      downloadOriginByModelId: {},
    })
    useModelSetupStore.setState({
      setups: {},
      progress: {},
      speeds: {},
      verdicts: {},
    })
    const core = ((
      globalThis as unknown as { core?: Record<string, unknown> }
    ).core ??= {})
    core.events = { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
  })

  it('lists a running setup under its model with the bytes of every download, Cancel and no Pause', () => {
    useModelSetupStore.setState({
      setups: { s1: setup() },
      progress: { tm: { transferred: 400, total: 1000 } },
      speeds: { tm: { bytesPerSecond: 250, atBytes: 400, atTime: 0 } },
    })
    render(<DownloadManagement />)

    const row = screen.getByTestId(ROW)
    expect(row).toHaveTextContent(MODEL_ID)
    // The engine (100) is installed by now, and 400 of the model's 1000 came.
    expect(screen.getByTestId('bytes')).toHaveTextContent('500/1100')
    expect(screen.getByTestId('speed')).toHaveTextContent('250')
    expect(screen.queryByRole('button', { name: 'pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'resume' })).toBeNull()
  })

  it('cancels the setup in the core, and the row ends with the cancelled toast', async () => {
    useModelSetupStore.setState({ setups: { s1: setup() } })
    setupService.cancel.mockResolvedValue(
      setup({
        stage: 'cancelled',
        revision: 2,
        stopped_at: 'downloading_model',
      })
    )
    render(<DownloadManagement />)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(setupService.cancel).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(screen.queryByTestId(ROW)).toBeNull())
    expect(useModelSetupStore.getState().setups.s1.stage).toBe('cancelled')
  })

  it('shows a setup the app closed on as paused, and Resume continues it in the core', async () => {
    useModelSetupStore.setState({
      setups: {
        s1: setup({ stage: 'interrupted', stopped_at: 'downloading_model' }),
      },
    })
    setupService.resume.mockResolvedValue(
      setup({ stage: 'queued', revision: 2 })
    )
    render(<DownloadManagement />)

    fireEvent.click(screen.getByRole('button', { name: 'resume' }))

    expect(setupService.resume).toHaveBeenCalledWith('s1')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'resume' })).toBeNull()
    )
    expect(screen.getByTestId(ROW)).toBeInTheDocument()
  })

  it('says so when the core refuses the cancel, and keeps the row', async () => {
    useModelSetupStore.setState({ setups: { s1: setup() } })
    setupService.cancel.mockRejectedValue({
      code: 'MODEL_SETUP_NOT_FOUND',
      message: 'No such model setup.',
    })
    render(<DownloadManagement />)

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'common:toast.downloadFailed.title',
        expect.objectContaining({ description: 'No such model setup.' })
      )
    )
    expect(screen.getByTestId(ROW)).toBeInTheDocument()
  })

  it('drops the row once the setup ends, and lists only the newest setup of a file', () => {
    const failed = setup({ setup_id: 's0', stage: 'failed', updated_at: 0 })
    useModelSetupStore.setState({ setups: { s0: failed, s1: setup() } })
    render(<DownloadManagement />)
    expect(screen.getAllByTestId(ROW)).toHaveLength(1)

    act(() =>
      useModelSetupStore.getState().apply({
        type: 'changed',
        setup: setup({ stage: 'ready', revision: 2, updated_at: 2 }),
      })
    )
    expect(screen.queryByTestId(ROW)).toBeNull()
  })
})
