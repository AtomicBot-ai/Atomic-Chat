import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  setPending: vi.fn(),
  addLocalDownloadingModel: vi.fn(),
  clearResumableDownload: vi.fn(),
  setDownloadOrigin: vi.fn(),
  pullModelWithMetadata: vi.fn(),
  captureReminder: vi.fn(),
  localDownloadingModels: new Set<string>(),
}))

const sourcesMock = vi.hoisted(() => ({
  sources: [] as CatalogModel[],
  // What the manifest resolves to for this machine, lead first — the real
  // hook is covered in its own tests, and its store fetches at import time.
  recommended: [] as Array<{
    rec: {
      modelName: string
      descriptionKey: string
      quant?: string
      mmprojQuant?: string
    }
    model: CatalogModel | null
  }>,
}))

vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => sourcesMock.recommended,
}))

// The card reads only the lead; the Hub's picks behind the widget's full list
// share the hook module, and their store fetches at import time too.
vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: () => [],
}))

// The catalog the recommendations resolve against.
vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: () => ({
    sources: sourcesMock.sources,
    loading: false,
    error: null,
    fetchSources: vi.fn(),
  }),
}))

// Unmocked, the real store reports no RAM and no GPU on a test host.
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({ tier: 'vram_8', profile: null, ready: true }),
}))

vi.mock('@/hooks/useOnboardingModelReminder', () => ({
  useOnboardingModelReminder: () => ({ setPending: mocks.setPending }),
}))

vi.mock('@/hooks/useDownloadStore', () => ({
  useDownloadStore: () => ({
    downloads: {},
    localDownloadingModels: mocks.localDownloadingModels,
    resumableDownloads: new Set<string>(),
    addLocalDownloadingModel: mocks.addLocalDownloadingModel,
    clearResumableDownload: mocks.clearResumableDownload,
    setDownloadOrigin: mocks.setDownloadOrigin,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

vi.mock('@/lib/onboarding-telemetry', () => ({
  captureOnboardingModelReminder: mocks.captureReminder,
}))

import { PromptOnboardingModel } from '../PromptOnboardingModel'

// A manifest override for the `vram_8` tier: the bundled ladder leads that
// tier with Qwen3.5 4B, so a card that shows this one is reading the manifest.
const NINE_B_REPO = 'AtomicChat/Qwen3.5-9B-GGUF'

const nineBModel: CatalogModel = {
  model_name: NINE_B_REPO,
  developer: 'AtomicChat',
  downloads: 0,
  quants: [
    {
      model_id: 'AtomicChat/Qwen3.5-9B-Q8_0',
      path: 'https://example.test/Qwen3.5-9B-Q8_0.gguf',
      file_size: '9.5 GB',
    },
    {
      model_id: 'AtomicChat/Qwen3.5-9B-Q4_K_M',
      path: 'https://example.test/Qwen3.5-9B-Q4_K_M.gguf',
      file_size: '5.0 GB',
    },
  ],
  mmproj_models: [
    {
      model_id: 'mmproj-f16',
      path: 'https://example.test/mmproj-f16.gguf',
      file_size: '0.5 GB',
    },
  ],
}

const nineB = {
  rec: {
    modelName: NINE_B_REPO,
    descriptionKey: 'hub:recEverydayUse',
    quant: 'Q4_K_M',
  },
  model: nineBModel,
}

const QAT_REPO = 'unsloth/gemma-4-12B-it-qat-GGUF'

// Its pins are the whole point: the repo's only weights file is a UD-Q4_K_XL,
// which the house quant preference (`iq4_xs` / `q4_k_m`) does not match, and
// its projector list leads with BF16.
const qatModel: CatalogModel = {
  model_name: QAT_REPO,
  developer: 'unsloth',
  downloads: 0,
  quants: [
    {
      model_id: 'unsloth/gemma-4-12B-it-qat-UD-Q4_K_XL',
      path: 'https://example.test/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
      file_size: '6.26 GB',
    },
  ],
  mmproj_models: [
    {
      model_id: 'mmproj-BF16',
      path: 'https://example.test/mmproj-BF16.gguf',
      file_size: '0.16 GB',
    },
    {
      model_id: 'mmproj-F16',
      path: 'https://example.test/mmproj-F16.gguf',
      file_size: '0.16 GB',
    },
  ],
}

const qat = {
  rec: {
    modelName: QAT_REPO,
    descriptionKey: 'hub:recVisionKnowledge',
    quant: 'UD-Q4_K_XL',
    mmprojQuant: 'F16',
  },
  model: qatModel,
}

const headingText = () =>
  screen.getByRole('heading', { level: 2 }).textContent?.replace(/\s+/g, ' ')

describe('PromptOnboardingModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.localDownloadingModels = new Set()
    sourcesMock.sources = []
    sourcesMock.recommended = [nineB]
    seedServiceHub({
      models: {
        pullModelWithMetadata: mocks.pullModelWithMetadata,
      } as never,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers what the manifest resolves for this tier, not the bundled rung', () => {
    render(<PromptOnboardingModel />)

    expect(headingText()).toBe('Qwen3.5 9B (5.0 GB)')
    expect(
      screen.getByText(/Get started with Qwen3.5 9B, our recommended/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Qwen3.5 4B/)).not.toBeInTheDocument()
    expect(mocks.captureReminder.mock.calls).toEqual([['shown']])
  })

  it('downloads the pinned quant with its matching projector and clears the reminder', () => {
    sourcesMock.recommended = [qat]

    render(<PromptOnboardingModel />)
    expect(headingText()).toBe('Gemma 4 12B QAT (6.26 GB)')

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))

    expect(mocks.addLocalDownloadingModel.mock.calls).toEqual([
      ['unsloth/gemma-4-12B-it-qat-UD-Q4_K_XL'],
    ])
    // Not the BF16 projector, which is what the default preference returns.
    expect(mocks.pullModelWithMetadata.mock.calls).toEqual([
      [
        'unsloth/gemma-4-12B-it-qat-UD-Q4_K_XL',
        'https://example.test/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
        'https://example.test/mmproj-F16.gguf',
        '',
        true,
        false,
      ],
    ])
    expect(mocks.setPending.mock.calls).toEqual([[false]])
    expect(mocks.captureReminder.mock.calls).toEqual([['shown'], ['download']])
  })

  it('clears the reminder without downloading on Later', () => {
    render(<PromptOnboardingModel />)

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    expect(mocks.pullModelWithMetadata.mock.calls).toHaveLength(0)
    expect(mocks.setPending.mock.calls).toEqual([[false]])
    expect(mocks.captureReminder.mock.calls).toEqual([['shown'], ['later']])
  })

  it('shows the download already in flight instead of starting it again', () => {
    mocks.localDownloadingModels = new Set(['AtomicChat/Qwen3.5-9B-Q4_K_M'])

    render(<PromptOnboardingModel />)

    const button = screen.getByRole('button', { name: 'Downloading' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mocks.pullModelWithMetadata.mock.calls).toHaveLength(0)
  })

  it('renders nothing until the lead card resolves, then offers it', () => {
    sourcesMock.recommended = [{ rec: nineB.rec, model: null }]

    const { container, rerender } = render(<PromptOnboardingModel />)

    expect(container).toBeEmptyDOMElement()
    expect(mocks.captureReminder.mock.calls).toEqual([])

    sourcesMock.recommended = [nineB]
    rerender(<PromptOnboardingModel />)

    expect(headingText()).toBe('Qwen3.5 9B (5.0 GB)')
    expect(mocks.captureReminder.mock.calls).toEqual([['shown']])
  })

  it('gives up on a lead that has not resolved after 8 s', () => {
    vi.useFakeTimers()
    sourcesMock.recommended = [{ rec: nineB.rec, model: null }]

    const { container, rerender } = render(<PromptOnboardingModel />)
    act(() => {
      vi.advanceTimersByTime(8_000)
    })

    // A card that resolves later would surface as a surprise mid-session;
    // the reminder stays armed, so the next launch gets a fresh try.
    sourcesMock.recommended = [nineB]
    rerender(<PromptOnboardingModel />)

    expect(container).toBeEmptyDOMElement()
    expect(mocks.captureReminder.mock.calls).toEqual([])
    expect(mocks.setPending.mock.calls).toEqual([])
  })
})
