import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const models = vi.hoisted(() => ({
  abortDownload: vi.fn(async () => {}),
  pullModelWithMetadata: vi.fn(async () => undefined),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => models }),
  getServiceHub: () => ({}),
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))
const transfers = vi.hoisted(() => ({
  downloadArtifact: vi.fn(async () => ({})),
}))
vi.mock('@/lib/diffusion/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/models')>()),
  downloadArtifact: transfers.downloadArtifact,
}))

import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { artifactId, diffusionDownloadTaskId } from '@/lib/diffusion/models'
import { getBaselineDiffusionCatalog } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { DownloadManagement } from '../DownloadManegement'

const catalog = getBaselineDiffusionCatalog()
const family = catalog.families.find((entry) => entry.modality === 'image')!
const quant = family.transformer.quants[0]
const CHECKPOINT = diffusionDownloadTaskId(artifactId(family.id, quant.id))
const MODEL = 'unsloth/Qwen3-4B-GGUF-Q4_K_M'
const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf'

/**
 * QA 2.2.23 (AC-10): a paused image-model download was gone from the download
 * panel after the app restarted. What the last session left is in storage;
 * the panel, mounted at launch, lists it again with Resume.
 */
describe('DownloadManagement after a relaunch', () => {
  beforeEach(() => {
    localStorage.setItem(
      localStorageKey.interruptedDownloads,
      JSON.stringify([
        {
          id: CHECKPOINT,
          name: CHECKPOINT,
          current: 420,
          total: 1000,
          progress: 0.42,
        },
        {
          id: MODEL,
          name: MODEL,
          current: 100,
          total: 1000,
          progress: 0.1,
          resume: { modelPath: MODEL_URL, provider: 'llamacpp-upstream' },
        },
      ])
    )
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      pausedDownloads: new Set(),
      resumeParams: {},
    })
    useGeneralSetting.setState({ huggingfaceToken: 'hf_from_settings' })
    useImageGenerationStore.setState({
      catalog,
      refreshModelFiles: vi.fn(async () => {}),
    })
    ;(globalThis as unknown as { core: Record<string, unknown> }).core.events =
      { on: () => {}, off: () => {}, emit: () => {} }
  })

  afterEach(() => {
    localStorage.removeItem(localStorageKey.interruptedDownloads)
  })

  it('lists the interrupted downloads as paused and resumes each from the panel', () => {
    render(<DownloadManagement />)

    const panel = screen.getByRole('region', { name: 'common:downloads' })
    const rows = within(panel).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    for (const item of rows) {
      expect(item).toHaveTextContent('common:downloadPanel.paused')
    }

    // The checkpoint resumes through its catalog entry, from the bytes on disk.
    const checkpointRow = rows.find((item) =>
      within(item).queryByTitle(CHECKPOINT)
    )!
    fireEvent.click(
      within(checkpointRow).getByRole('button', {
        name: 'common:resumeDownload',
      })
    )
    expect(transfers.downloadArtifact).toHaveBeenCalledWith(
      family,
      quant.id,
      expect.objectContaining({ resume: true })
    )
    expect(useDownloadStore.getState().pausedDownloads.has(CHECKPOINT)).toBe(
      false
    )

    // The chat model resumes with its stored parameters and the token from
    // Settings, which was never stored with them.
    const modelRow = rows.find((item) => within(item).queryByTitle(MODEL))!
    fireEvent.click(
      within(modelRow).getByRole('button', { name: 'common:resumeDownload' })
    )
    expect(models.pullModelWithMetadata).toHaveBeenCalledWith(
      MODEL,
      MODEL_URL,
      undefined,
      'hf_from_settings',
      false,
      true,
      expect.objectContaining({ provider: 'llamacpp-upstream' })
    )
    expect(useDownloadStore.getState().pausedDownloads.has(MODEL)).toBe(true)
  })
})
