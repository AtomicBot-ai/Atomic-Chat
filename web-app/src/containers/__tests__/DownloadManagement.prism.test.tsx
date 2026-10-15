import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A Bonsai file downloads under PrismML with the app's own downloader, so it
// pauses and resumes in the panel like any GGUF. A resume finishes the way the
// Hub's download does: the core reads the file on disk, and a file PrismML
// does not run is removed.

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
const hub = vi.hoisted(() => {
  const models = {
    abortDownload: vi.fn(),
    pullModelWithMetadata: vi.fn(),
    deleteModel: vi.fn(),
    stopModel: vi.fn(),
  }
  const modelSetup = { checkCompatibility: vi.fn() }
  const providers = { getProviders: vi.fn(async () => []) }
  const serviceHub = {
    models: () => models,
    modelSetup: () => modelSetup,
    providers: () => providers,
  }
  return { models, modelSetup, serviceHub }
})
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => hub.serviceHub,
  getServiceHub: () => hub.serviceHub,
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

const MODEL_ID = 'prism-ml/Bonsai-8B-PQ2_0'
const ROW = `row-${MODEL_ID}`
const URL =
  'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/b072e1d/Bonsai-8B-PQ2_0.gguf'

const verdict = (outcome: string, reason = 'r') => ({
  outcome,
  provider: 'atomic-prism',
  requires: [],
  evidence: 'header',
  rules_version: 1,
  reason,
})

describe('DownloadManagement — a Bonsai download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hub.models.pullModelWithMetadata.mockResolvedValue(undefined)
    hub.models.deleteModel.mockResolvedValue(undefined)
    useDownloadStore.setState({
      downloads: {
        [MODEL_ID]: { name: MODEL_ID, progress: 0.5, current: 50, total: 100 },
      },
      localDownloadingModels: new Set(),
      pausedDownloads: new Set([MODEL_ID]),
      resumableDownloads: new Set([MODEL_ID]),
      resumeParams: {
        [MODEL_ID]: {
          modelPath: URL,
          skipVerification: true,
          provider: 'atomic-prism',
          modelSha256: 'a'.repeat(64),
          modelSize: 100,
        },
      },
    } as never)
  })

  it('resumes under PrismML with the hashes it started with, and keeps a file PrismML runs', async () => {
    hub.modelSetup.checkCompatibility.mockResolvedValue(verdict('compatible'))
    render(<DownloadManagement />)

    fireEvent.click(within(screen.getByTestId(ROW)).getByText('resume'))

    await waitFor(() =>
      expect(hub.models.pullModelWithMetadata).toHaveBeenCalledWith(
        MODEL_ID,
        URL,
        undefined,
        undefined,
        true,
        true,
        expect.objectContaining({
          provider: 'atomic-prism',
          modelSha256: 'a'.repeat(64),
          modelSize: 100,
        })
      )
    )
    await waitFor(() =>
      expect(hub.modelSetup.checkCompatibility).toHaveBeenCalledWith({
        model_id: MODEL_ID,
        provider: 'atomic-prism',
      })
    )
    expect(hub.models.deleteModel).not.toHaveBeenCalled()
  })

  it('removes a resumed file PrismML does not run and says why', async () => {
    hub.modelSetup.checkCompatibility.mockResolvedValue(
      verdict('engine_required', 'Another packing.')
    )
    render(<DownloadManagement />)

    fireEvent.click(within(screen.getByTestId(ROW)).getByText('resume'))

    await waitFor(() =>
      expect(hub.models.deleteModel).toHaveBeenCalledWith(
        MODEL_ID,
        'atomic-prism'
      )
    )
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('hub:prismModelRejected', {
        description: 'Another packing.',
      })
    )
  })

  it('leaves an ordinary GGUF resume unchecked', async () => {
    useDownloadStore.setState({
      resumeParams: { [MODEL_ID]: { modelPath: URL, skipVerification: true } },
    } as never)
    render(<DownloadManagement />)

    fireEvent.click(within(screen.getByTestId(ROW)).getByText('resume'))

    await waitFor(() =>
      expect(hub.models.pullModelWithMetadata).toHaveBeenCalled()
    )
    await act(async () => {})
    expect(hub.modelSetup.checkCompatibility).not.toHaveBeenCalled()
  })
})
