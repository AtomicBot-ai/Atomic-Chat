import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadEvent } from '@janhq/core'
import { Toaster, toast } from 'sonner'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ abortDownload: vi.fn() }) }),
  getServiceHub: () => ({}),
}))
// One object for every render: the component mirrors it into state from an
// effect keyed on its identity.
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
  DownloadPanel: () => null,
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { DownloadManagement } from '../DownloadManegement'

const TASK = 'diffusion-model-flux_1_q4_k_m'
const FINISHING = 'images:download.finishingModel'

// The real sonner toaster: the assertions are on what the user sees.
const renderWithToaster = () =>
  render(
    <>
      <Toaster />
      <DownloadManagement />
    </>
  )

describe('DownloadManagement — the "verifying…" toast', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (name: string, payload: unknown) =>
    handlers.get(name)?.forEach((handler) => handler(payload))

  beforeEach(() => {
    handlers.clear()
    const core = ((globalThis as unknown as { core?: Record<string, unknown> })
      .core ??= {})
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
    vi.useRealTimers()
    toast.dismiss()
    delete (globalThis as unknown as { core: Record<string, unknown> }).core
      .events
  })

  it('opens without a timeout for an image model, so something must close it', () => {
    vi.useFakeTimers()
    renderWithToaster()
    act(() =>
      emit(DownloadEvent.onModelValidationStarted, {
        modelId: TASK,
        downloadType: 'Model',
      })
    )
    // sonner hands the toast to <Toaster /> on the next macrotask.
    act(() => vi.advanceTimersByTime(0))
    expect(screen.getByText(FINISHING)).toBeInTheDocument()

    // Well past sonner's default lifetime: only a terminal event closes it.
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText(FINISHING)).toBeInTheDocument()
  })

  it.each([
    [
      'a transfer error',
      DownloadEvent.onFileDownloadError,
      { error: 'Failed to verify file integrity: Input/output error' },
    ],
    ['a stopped transfer', DownloadEvent.onFileDownloadStopped, {}],
    [
      'a failed integrity check',
      DownloadEvent.onModelValidationFailed,
      { error: 'Size verification failed.', reason: 'validation_failed' },
    ],
  ])('is closed by %s', async (_label, event, extra) => {
    renderWithToaster()
    act(() =>
      emit(DownloadEvent.onModelValidationStarted, {
        modelId: TASK,
        downloadType: 'Model',
      })
    )
    expect(await screen.findByText(FINISHING)).toBeInTheDocument()

    act(() => emit(event, { modelId: TASK, downloadType: 'Model', ...extra }))

    await waitFor(() =>
      expect(screen.queryByText(FINISHING)).not.toBeInTheDocument()
    )
  })
})
