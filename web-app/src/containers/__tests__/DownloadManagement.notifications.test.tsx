import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadEvent } from '@janhq/core'

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
// The key, and the model's name when the string carries one.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}|${options.name}` : key,
  }),
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
// What was offered to the OS, in order, with whether it counts as on screen.
// The focus and Settings gates live in `notifyUnlessWatching` itself and are
// covered by its own test.
const sent = vi.hoisted(
  () => [] as Array<{ watching: boolean; title: string; body: string }>
)
vi.mock('@/lib/notifications', () => ({
  notifyUnlessWatching: (watching: boolean, title: string, body: string) => {
    sent.push({ watching, title, body })
    return true
  },
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { managedDownloadId } from '@/lib/managed-engine/download-id'
import { DownloadManagement } from '../DownloadManegement'

const MODEL = 'bartowski/Kimi-K3-Q4_K_M'
const ENGINE = 'llamacpp-backend-b6500/macos-arm64'
const MODEL_READY = {
  watching: false,
  title: 'common:desktopNotification.modelReadyTitle',
  body: 'common:desktopNotification.modelReadyBody|Kimi-K3-Q4_K_M',
}

describe('DownloadManagement — desktop notification when a download finishes', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const dispatch = (name: string, payload: unknown) =>
    handlers.get(name)?.forEach((handler) => handler(payload))
  const emit = (name: string, payload: unknown) =>
    act(() => dispatch(name, payload))
  const progress = (modelId: string, downloadType: string) =>
    emit(DownloadEvent.onFileDownloadUpdate, {
      modelId,
      downloadType,
      percent: 0.5,
      size: { transferred: 50, total: 100 },
    })

  beforeEach(() => {
    handlers.clear()
    sent.length = 0
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
      emit: dispatch,
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { core: Record<string, unknown> }).core
      .events
  })

  it('announces a model once, focused or not, even when both success events arrive', () => {
    render(<DownloadManagement />)
    progress(MODEL, 'Model')
    emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })
    emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })

    expect(sent).toEqual([MODEL_READY])
    expect(useDownloadStore.getState().downloads).toEqual({})
  })

  it('leaves an engine install to its toast in a focused window', () => {
    render(<DownloadManagement />)
    progress(ENGINE, 'Backend')
    emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
      modelId: ENGINE,
      downloadType: 'Backend',
    })

    expect(sent).toEqual([
      {
        watching: true,
        title: 'common:desktopNotification.engineReadyTitle',
        body: 'common:desktopNotification.chatEngineReadyBody',
      },
    ])
  })

  it('announces a first-run download, whose row the setup screen does not draw', () => {
    useDownloadStore.getState().addLocalDownloadingModel(MODEL)
    render(<DownloadManagement hidePanel />)
    progress(MODEL, 'Model')
    emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })

    expect(sent).toEqual([MODEL_READY])
  })

  it('announces a download whose row was closed before its success arrived', () => {
    render(<DownloadManagement />)
    progress(MODEL, 'Model')
    act(() => useDownloadStore.getState().removeDownload(MODEL))
    emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })
    emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })

    expect(sent).toEqual([MODEL_READY])
  })

  it('names a model by its row: a managed one by its repository', () => {
    const id = managedDownloadId('meta-llama/Llama-3.1-8B')
    useDownloadStore.getState().setDownloadOrigin(id, 'meta-llama/Llama-3.1-8B')
    render(<DownloadManagement />)
    progress(id, 'Model')
    emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: id,
      downloadType: 'Model',
    })

    expect(sent.map((entry) => entry.body)).toEqual([
      'common:desktopNotification.modelReadyBody|meta-llama/Llama-3.1-8B',
    ])
  })

  it('says nothing is ready when a download is cancelled or fails', () => {
    render(<DownloadManagement />)
    progress(MODEL, 'Model')
    emit(DownloadEvent.onFileDownloadStopped, {
      modelId: MODEL,
      downloadType: 'Model',
    })
    progress(ENGINE, 'Backend')
    emit(DownloadEvent.onFileDownloadError, {
      modelId: ENGINE,
      downloadType: 'Backend',
      error: 'HTTP status 500',
    })
    // A late success for either finds nothing running.
    emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })

    expect(sent).toEqual([])
  })

  it('announces a download that has not reported bytes yet', () => {
    useDownloadStore.getState().addLocalDownloadingModel(MODEL)
    render(<DownloadManagement />)
    emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })

    expect(sent).toHaveLength(1)
    expect(useDownloadStore.getState().localDownloadingModels.has(MODEL)).toBe(
      false
    )
  })

  it('stays quiet for a success the panel never showed', () => {
    render(<DownloadManagement />)
    emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: MODEL,
      downloadType: 'Model',
    })

    expect(sent).toEqual([])
  })
})
