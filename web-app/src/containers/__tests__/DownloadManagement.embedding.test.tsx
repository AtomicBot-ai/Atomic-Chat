import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadEvent } from '@janhq/core'

// A catalog embedding model (`embedding-<id>`) downloads its GGUF and projector as one plain
// transfer, like a decision model: the panel offers Cancel only, and Cancel stops that transfer.

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
// One object for every render: a fresh one each time re-runs the panel's effects forever.
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
      name: string
      pausable?: boolean
      onCancel?: () => void
    }>
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
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { DownloadManagement } from '../DownloadManegement'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { embeddingDownloadTaskId } from '@/lib/embedding/models'

const DOWNLOAD_ID = embeddingDownloadTaskId('embeddinggemma-2')

describe('DownloadManagement — a catalog embedding model download', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (name: string, payload: unknown) =>
    handlers.get(name)?.forEach((handler) => handler(payload))

  beforeEach(() => {
    handlers.clear()
    transfer.cancelTransfer.mockClear()
    abortDownload.mockClear()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      downloadOriginByModelId: {},
    })
    const core = ((
      globalThis as unknown as { core?: Record<string, unknown> }
    ).core ??= {})
    core.events = {
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

  function downloading() {
    act(() => {
      emit(DownloadEvent.onFileDownloadUpdate, {
        modelId: DOWNLOAD_ID,
        percent: 0.25,
        size: { transferred: 200_000_000, total: 800_000_000 },
        downloadType: 'Model',
      })
    })
  }

  it('offers Cancel and no Pause', () => {
    render(<DownloadManagement />)
    downloading()

    const row = screen.getByTestId(`row-${DOWNLOAD_ID}`)
    expect(row.querySelector('button')?.textContent).toBe('cancel')
    expect(
      screen.queryByRole('button', { name: 'pause' })
    ).not.toBeInTheDocument()
  })

  it('stops the transfer of that same id on Cancel, not a chat-model download', () => {
    render(<DownloadManagement />)
    downloading()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(transfer.cancelTransfer).toHaveBeenCalledWith(DOWNLOAD_ID)
    expect(abortDownload).not.toHaveBeenCalled()
    expect(
      useDownloadStore.getState().resumableDownloads.has(DOWNLOAD_ID)
    ).toBe(true)
  })
})
