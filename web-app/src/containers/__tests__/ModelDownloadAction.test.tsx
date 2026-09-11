import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  pullModelWithMetadata: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

vi.mock('@/hooks/useDownloadStore', () => {
  const state = {
    downloads: {},
    localDownloadingModels: new Set<string>(),
    resumableDownloads: new Set<string>(),
    downloadOriginByModelId: {},
    addLocalDownloadingModel: vi.fn(),
    removeLocalDownloadingModel: vi.fn(),
    markResumableDownload: vi.fn(),
    clearResumableDownload: vi.fn(),
    setDownloadOrigin: vi.fn(),
    clearDownloadOrigin: vi.fn(),
  }
  const useDownloadStore = (selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state
  useDownloadStore.getState = () => state
  return { useDownloadStore }
})

import { ModelDownloadAction } from '../ModelDownloadAction'

const variant = {
  model_id: 'Qwen3.8-27B-Q8_0',
  path: 'https://example.test/Qwen3.8-27B-Q8_0.gguf',
}

const model = {
  model_name: 'AtomicChat/Qwen3.8-27B-GGUF',
  developer: 'AtomicChat',
  quants: [variant],
} as unknown as CatalogModel

const downloadButton = () =>
  screen.getByRole('button', { name: 'hub:download' })

describe('ModelDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelProvider.setState({ providers: [] })
    seedServiceHub({
      models: { pullModelWithMetadata: mocks.pullModelWithMetadata } as never,
    })
  })

  it('offers Download as the primary action, like "New chat" beside it', () => {
    render(<ModelDownloadAction variant={variant} model={model} asButton />)

    expect(downloadButton()).toHaveAttribute('data-variant', 'default')
  })

  it('downloads a variant that fits without asking', () => {
    render(<ModelDownloadAction variant={variant} model={model} asButton />)

    fireEvent.click(downloadButton())

    expect(mocks.pullModelWithMetadata).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('warns before downloading a variant too large for the device', async () => {
    render(
      <ModelDownloadAction variant={variant} model={model} asButton warnTooLarge />
    )

    // The button is live, not disabled: the fit estimate is a guess.
    expect(downloadButton()).toBeEnabled()
    fireEvent.click(downloadButton())

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('hub:tooLargeTitle')
    expect(dialog).toHaveTextContent('hub:tooLargeDescription')
    expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'hub:downloadAnyway' }))

    expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
      'Qwen3.8-27B-Q8_0',
      'https://example.test/Qwen3.8-27B-Q8_0.gguf',
      undefined,
      '',
      true,
      false
    )
  })

  it('downloads nothing when the warning is cancelled', async () => {
    render(
      <ModelDownloadAction variant={variant} model={model} asButton warnTooLarge />
    )

    fireEvent.click(downloadButton())
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
  })
})
