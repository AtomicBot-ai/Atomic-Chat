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
