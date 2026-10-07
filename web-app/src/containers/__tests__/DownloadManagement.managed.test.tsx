import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadEvent } from '@janhq/core'

// Task 3.18 (manual run finding F-10): a TensorRT-LLM model download left the "Validating Model"
// toast the Rust downloader opens spinning forever, because nothing ended the download's events.

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
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ abortDownload: vi.fn() }) }),
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
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { DownloadManagement } from '../DownloadManegement'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  installManagedModel,
  managedDownloadId,
  type InstallDeps,
} from '@/services/managed-models/models'
import type { TransferItem } from '@/services/diffusion/transfer'

const REPO = 'Qwen/Qwen3-1.7B'
const SHA = 'c0ffee' + '0'.repeat(34)
/** One id for the task, its files, the panel row and every event (design D6). */
const DOWNLOAD_ID = managedDownloadId(REPO)
const VALIDATION_TOAST = `model-validation-started-${DOWNLOAD_ID}`

/** Hugging Face with one small repository: a config and one LFS weight file. */
async function hf(url: string): Promise<Response> {
  if (url.startsWith(`https://huggingface.co/api/models/${REPO}/revision/`)) {
    return Response.json({
      sha: SHA,
      siblings: [
        { rfilename: 'config.json', size: 700 },
        {
          rfilename: 'model.safetensors',
          size: 134,
          lfs: { sha256: 'a'.repeat(64), size: 4_000_000_000 },
        },
      ],
    })
  }
  if (url.endsWith('/config.json')) return Response.json({ architectures: ['Qwen3ForCausalLM'] })
  return new Response('not found', { status: 404 })
}

describe('DownloadManagement — a TensorRT-LLM model download (task 3.18)', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (name: string, payload: unknown) =>
    handlers.get(name)?.forEach((handler) => handler(payload))

  /** The Rust downloader: the files arrive, it announces validation for the items' `model_id`. */
  function downloader(outcome: 'verified' | Error) {
    return async (items: TransferItem[]) => {
      emit(DownloadEvent.onModelValidationStarted, {
        modelId: items[0].model_id,
        downloadType: 'Model',
      })
      if (outcome !== 'verified') throw outcome
    }
  }

  function install(outcome: 'verified' | Error) {
    const deps: InstallDeps = {
      fetch: hf as typeof fetch,
      check: async () => ({
        architectures: ['Qwen3ForCausalLM'],
        quantization_format: null,
        weight_bytes: 4_000_000_000,
        checked_gpu_id: 'GPU-1',
        curated: true,
        unified_memory: false,
        fits_other_gpus: [],
        verdict: { ok: true },
      }),
      location: async () => ({ root: '/data/managed-models', free_bytes: null }),
      existingSize: async () => null,
      hasPartial: async () => false,
      transfer: downloader(outcome),
      writeYaml: async () => {},
      emit,
    }
    return installManagedModel({ engineId: 'tensorrt-llm', repository: REPO }, deps)
  }

  beforeEach(() => {
    handlers.clear()
    transfer.cancelTransfer.mockClear()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      downloadOriginByModelId: {},
    })
    Object.values(toast).forEach((fn) => fn.mockClear())
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
    delete (globalThis as unknown as { core: Record<string, unknown> }).core
      .events
  })

  it('closes the "Validating Model" toast once every file is verified and says it is downloaded', async () => {
    render(<DownloadManagement />)

    await install('verified')

    const opened = toast.info.mock.calls.map(([, options]) => options?.id)
    expect(opened).toEqual([VALIDATION_TOAST])
    expect(toast.dismiss.mock.calls).toContainEqual([VALIDATION_TOAST])
    expect(toast.success.mock.calls.map(([title]) => title)).toEqual([
      'common:toast.downloadComplete.title',
    ])
    expect(toast.error.mock.calls).toEqual([])
  })

  it('closes it with the validation-failure toast when a file fails its sha256 check', async () => {
    render(<DownloadManagement />)

    await expect(
      install(new Error('Hash verification failed for model.safetensors'))
    ).rejects.toThrow('Hash verification failed')

    expect(toast.dismiss.mock.calls).toContainEqual([VALIDATION_TOAST])
    expect(toast.error.mock.calls.map(([title]) => title)).toEqual([
      'common:toast.modelValidationFailed.title',
    ])
    expect(toast.success.mock.calls).toEqual([])
  })

  describe('in the download panel (design D6)', () => {
    /** The Hub's Download: names the row after the repository, then the transfer reports bytes. */
    function downloading() {
      act(() => {
        useDownloadStore.getState().setDownloadOrigin(DOWNLOAD_ID, REPO)
        emit(DownloadEvent.onFileDownloadUpdate, {
          modelId: DOWNLOAD_ID,
          percent: 0.25,
          size: { transferred: 1_000_000_000, total: 4_000_000_000 },
          downloadType: 'Model',
        })
      })
    }

    it('shows the download as a row named after the repository, with Cancel and no Pause', () => {
      render(<DownloadManagement />)

      downloading()

      const row = screen.getByTestId(`row-${DOWNLOAD_ID}`)
      expect(row).toHaveTextContent(REPO)
      expect(row.querySelector('button')?.textContent).toBe('cancel')
      expect(screen.queryByRole('button', { name: 'pause' })).not.toBeInTheDocument()
    })

    it('stops the transfer of that same id on Cancel, and the row ends as cancelled', async () => {
      render(<DownloadManagement />)
      downloading()

      fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

      expect(transfer.cancelTransfer).toHaveBeenCalledWith(DOWNLOAD_ID)
      // The install sees the downloader's cancel and ends the row as stopped.
      act(() =>
        emit(DownloadEvent.onFileDownloadStopped, { modelId: DOWNLOAD_ID, downloadType: 'Model' })
      )
      expect(screen.queryByTestId(`row-${DOWNLOAD_ID}`)).not.toBeInTheDocument()
      expect(toast.info.mock.calls.map(([title]) => title)).toContain(
        'common:toast.downloadCancelled.title'
      )
      expect(toast.error.mock.calls).toEqual([])
    })
  })
})
