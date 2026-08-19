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
  hardwareTier: { tier: 'standard' as 'low' | 'standard', ready: true },
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
  useGeneralSetting: (selector: (state: { huggingfaceToken: string }) => unknown) =>
    selector({ huggingfaceToken: '' }),
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
  const VL_REPO = 'LiquidAI/LFM2.5-VL-450M-GGUF'

  // Mirrors the real repo: it ships a Q4_K_M alongside the Q8_0 the manifest
  // pins, and a BF16 projector ahead of the Q8_0 one.
  const vlModel: CatalogModel = {
    model_name: VL_REPO,
    developer: 'LiquidAI',
    downloads: 0,
    quants: [
      {
        model_id: 'LiquidAI/LFM2_5-VL-450M-Q4_K_M',
        path: 'https://example.test/LFM2.5-VL-450M-Q4_K_M.gguf',
        file_size: '279.0 MB',
      },
      {
        model_id: 'LiquidAI/LFM2_5-VL-450M-Q8_0',
        path: 'https://example.test/LFM2.5-VL-450M-Q8_0.gguf',
        file_size: '361.6 MB',
      },
    ],
    mmproj_models: [
      {
        model_id: 'mmproj-LFM2_5-VL-450m-BF16',
        path: 'https://example.test/mmproj-BF16.gguf',
        file_size: '181.0 MB',
      },
      {
        model_id: 'mmproj-LFM2_5-VL-450m-Q8_0',
        path: 'https://example.test/mmproj-Q8_0.gguf',
        file_size: '98.0 MB',
      },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.localDownloadingModels = new Set()
    mocks.hardwareTier.tier = 'low'
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: VL_REPO })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(vlModel)
    seedServiceHub({
      models: {
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
  })

  it('offers the small model on a weak device', async () => {
    render(<PromptOnboardingModel />)

    // Nudging a low-spec machine toward Qwen3.5 4B would undo the whole point
    // of the low-spec onboarding tier.
    const heading = await screen.findByRole('heading', { level: 2 })
    expect(heading.textContent?.replace(/\s+/g, ' ')).toBe(
      'LFM2.5 VL 450M (361.6 MB)'
    )
    expect(screen.queryByText(/Qwen3.5 4B/)).not.toBeInTheDocument()
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledWith(VL_REPO, '')
  })

  it('downloads the pinned quant and its matching projector', async () => {
    render(<PromptOnboardingModel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))

    const [modelId, path, mmprojPath] =
      mocks.pullModelWithMetadata.mock.calls[0]
    expect(modelId).toBe('LiquidAI/LFM2_5-VL-450M-Q8_0')
    expect(path).toContain('Q8_0.gguf')
    // Not the BF16 projector, which is what the default preference returns.
    expect(mmprojPath).toBe('https://example.test/mmproj-Q8_0.gguf')
  })
})
