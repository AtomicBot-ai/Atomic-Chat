import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadEvent } from '@janhq/core'

// Task 5.3 of move-sdcpp-mlx-install-to-core: the core downloads the media
// engine, so the panel's Cancel stops that download in the core, under the
// same task id, and offers no Pause (a cancelled install starts over).

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
const abortDownload = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ abortDownload }) }),
  getServiceHub: () => ({}),
}))
// One object for every render: the panel's effects depend on it.
const appUpdater = vi.hoisted(() => ({
  updateState: {
    isDownloading: false,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  },
}))
vi.mock('@/hooks/useAppUpdater', () => ({ useAppUpdater: () => appUpdater }))
vi.mock('@/containers/downloads/DownloadPanel', () => ({
  DownloadPanel: ({
    items,
  }: {
    items: Array<{ id: string; name: string; pausable?: boolean; onCancel?: () => void }>
  }) => (
    <ul>
      {items.map((item) => (
        <li key={item.id} data-testid={`row-${item.id}`}>
          <span>{item.name}</span>
          {item.pausable && <button type="button">pause</button>}
          <button type="button" onClick={item.onCancel}>
            cancel
          </button>
        </li>
      ))}
    </ul>
  ),
}))
const transfer = vi.hoisted(() => ({ cancelTransfer: vi.fn(async () => {}) }))
vi.mock('@/services/diffusion/transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion/transfer')>()),
  ...transfer,
}))
const core = vi.hoisted(() => ({
  cancelEngineBuildDownload: vi.fn(async () => {}),
}))
vi.mock('@/services/engine-builds/core', () => core)
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { DownloadManagement } from '../DownloadManegement'
import { useDownloadStore } from '@/hooks/useDownloadStore'

/** `diffusionBackendTaskId(tag, backendId)` for the fork's 883 build on Apple Silicon. */
const TASK = 'diffusion-backend-master-883-137f740-a36f1b1a-macos-arm64'

describe('DownloadManagement — the media engine install (task 5.3)', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (name: string, payload: unknown) =>
    handlers.get(name)?.forEach((handler) => handler(payload))

  /** The core's progress, as the engine install hands it to the panel. */
  const installing = () =>
    act(() =>
      emit(DownloadEvent.onFileDownloadUpdate, {
        modelId: TASK,
        percent: 0.25,
        size: { transferred: 50_000_000, total: 200_000_000 },
        downloadType: 'Backend',
      })
    )

  beforeEach(() => {
    handlers.clear()
    transfer.cancelTransfer.mockClear()
    core.cancelEngineBuildDownload.mockClear()
    abortDownload.mockClear()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      downloadOriginByModelId: {},
    })
    Object.values(toast).forEach((fn) => fn.mockClear())
    const app = ((globalThis as unknown as { core?: Record<string, unknown> })
      .core ??= {})
    app.events = {
      on: (name: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(handler)
      },
      off: (name: string, handler: (payload: unknown) => void) => {
        handlers.get(name)?.delete(handler)
      },
      emit,
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { core: Record<string, unknown> }).core
      .events
  })

  it('shows the install with Cancel and no Pause', () => {
    render(<DownloadManagement />)
    installing()

    expect(screen.getByTestId(`row-${TASK}`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pause' })).not.toBeInTheDocument()
  })

  it('cancels the download in the core under the same id, and the row ends as cancelled, not failed', () => {
    render(<DownloadManagement />)
    installing()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(core.cancelEngineBuildDownload).toHaveBeenCalledWith(TASK)
    expect(transfer.cancelTransfer).not.toHaveBeenCalled()
    expect(abortDownload).not.toHaveBeenCalled()
    // The core answers the install with CANCELLED; the install closes the row as stopped.
    act(() =>
      emit(DownloadEvent.onFileDownloadStopped, { modelId: TASK, downloadType: 'Backend' })
    )
    expect(screen.queryByTestId(`row-${TASK}`)).not.toBeInTheDocument()
    expect(toast.info.mock.calls.map(([title]) => title)).toContain(
      'common:toast.downloadCancelled.title'
    )
    expect(toast.error.mock.calls).toEqual([])
  })

  it('cancels an MLX engine install in the core too, with no Pause', () => {
    const MLX_TASK = 'engine-build-mlx-mlxvlm-macos-arm64-abc1234'
    render(<DownloadManagement />)
    act(() =>
      emit(DownloadEvent.onFileDownloadUpdate, {
        modelId: MLX_TASK,
        percent: 0.1,
        size: { transferred: 21_000_000, total: 210_000_000 },
        downloadType: 'Backend',
      })
    )
    expect(screen.queryByRole('button', { name: 'pause' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(core.cancelEngineBuildDownload).toHaveBeenCalledWith(MLX_TASK)
    expect(abortDownload).not.toHaveBeenCalled()
  })
})
