import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedServiceHub } from '@/test/service-hub'
import { ONBOARDING_REMINDER_MODEL_HF_REPO } from '@/constants/models'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  setPending: vi.fn(),
  addLocalDownloadingModel: vi.fn(),
  clearResumableDownload: vi.fn(),
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
  pullModelWithMetadata: vi.fn(),
  localDownloadingModels: new Set<string>(),
  hardwareTier: { tier: 'vram_8' as string, profile: null, ready: true },
}))

// Unmocked, the real store reports no RAM and no GPU on a test host.
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => mocks.hardwareTier,
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
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

import { PromptOnboardingModel } from '../PromptOnboardingModel'

const catalogModel: CatalogModel = {
  model_name: ONBOARDING_REMINDER_MODEL_HF_REPO,
  developer: 'AtomicChat',
  downloads: 0,
  quants: [
    {
      model_id: 'AtomicChat/Qwen3.5-4B-Q8_0',
      path: 'https://example.test/Qwen3.5-4B-Q8_0.gguf',
      file_size: '8.0 GB',
    },
    {
      model_id: 'AtomicChat/Qwen3.5-4B-Q4_K_M',
      path: 'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
      file_size: '2.5 GB',
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

describe('PromptOnboardingModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.localDownloadingModels = new Set()
    mocks.fetchHuggingFaceRepo.mockResolvedValue({
      id: ONBOARDING_REMINDER_MODEL_HF_REPO,
    })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(catalogModel)
    seedServiceHub({
      models: {
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
  })

  it('offers the recommended model at its q4_k_m quant', async () => {
    render(<PromptOnboardingModel />)

    const heading = await screen.findByRole('heading', { level: 2 })
    expect(heading.textContent?.replace(/\s+/g, ' ')).toBe(
      'Qwen3.5 4B (2.5 GB)'
    )
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledWith(
      ONBOARDING_REMINDER_MODEL_HF_REPO,
      ''
    )
  })

  it('downloads the quant with its mmproj and clears the reminder', async () => {
    render(<PromptOnboardingModel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))

    expect(mocks.addLocalDownloadingModel.mock.calls).toEqual([
      ['AtomicChat/Qwen3.5-4B-Q4_K_M'],
    ])
    expect(mocks.pullModelWithMetadata.mock.calls).toEqual([
      [
        'AtomicChat/Qwen3.5-4B-Q4_K_M',
        'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
        'https://example.test/mmproj-f16.gguf',
        '',
        true,
        false,
      ],
    ])
    expect(mocks.setPending.mock.calls).toEqual([[false]])
  })

  it('clears the reminder without downloading on Later', async () => {
    render(<PromptOnboardingModel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))

    expect(mocks.pullModelWithMetadata.mock.calls).toHaveLength(0)
    expect(mocks.setPending.mock.calls).toEqual([[false]])
  })

  it('renders nothing until the repo lookup settles', () => {
    mocks.fetchHuggingFaceRepo.mockReturnValue(new Promise(() => {}))

    const { container } = render(<PromptOnboardingModel />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('PromptOnboardingModel hardware tiers', () => {
  const LFM_REPO = 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF'

  // Mirrors the real repo: several quants, of which the ladder pins one.
  const lfmModel: CatalogModel = {
    model_name: LFM_REPO,
    developer: 'LiquidAI',
    downloads: 0,
    quants: [
      {
        model_id: 'LiquidAI/LFM2.5-1.2B-Instruct-Q8_0',
        path: 'https://example.test/LFM2.5-1.2B-Instruct-Q8_0.gguf',
        file_size: '1.3 GB',
      },
      {
        model_id: 'LiquidAI/LFM2.5-1.2B-Instruct-Q4_K_M',
        path: 'https://example.test/LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
        file_size: '0.68 GB',
      },
    ],
    mmproj_models: [],
  }

  const QAT_REPO = 'unsloth/gemma-4-12B-it-qat-GGUF'

  // The top rung. Its pin is the whole point: the repo's only weights file is
  // a UD-Q4_K_XL, which the house quant preference (`iq4_xs` / `q4_k_m`) does
  // not match, and its projector list leads with BF16.
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

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.localDownloadingModels = new Set()
    seedServiceHub({
      models: {
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
  })

  it('offers the lightest model on a card with under 2.5 GB of VRAM', async () => {
    // 741 Windows devices sit in this bucket. Nudging one toward the default
    // rung's Qwen3.5 4B is the mis-recommendation the ladder exists to remove.
    mocks.hardwareTier.tier = 'vram_2'
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: LFM_REPO })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(lfmModel)

    render(<PromptOnboardingModel />)

    const heading = await screen.findByRole('heading', { level: 2 })
    expect(heading.textContent?.replace(/\s+/g, ' ')).toBe(
      'LFM2.5 1.2B Instruct (0.68 GB)'
    )
    expect(screen.queryByText(/Qwen3.5 4B/)).not.toBeInTheDocument()
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledWith(LFM_REPO, '')
  })

  it('downloads the pinned quant and its matching projector', async () => {
    mocks.hardwareTier.tier = 'unified_32_plus'
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: QAT_REPO })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(qatModel)

    render(<PromptOnboardingModel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))

    const [modelId, path, mmprojPath] =
      mocks.pullModelWithMetadata.mock.calls[0]
    expect(modelId).toBe('unsloth/gemma-4-12B-it-qat-UD-Q4_K_XL')
    expect(path).toContain('UD-Q4_K_XL.gguf')
    // Not the BF16 projector, which is what the default preference returns.
    expect(mmprojPath).toBe('https://example.test/mmproj-F16.gguf')
  })
})
