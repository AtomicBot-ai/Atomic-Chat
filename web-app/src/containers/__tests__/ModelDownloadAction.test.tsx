import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  pullModelWithMetadata: vi.fn(() => Promise.resolve()),
  switchToModel: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

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
    mocks.pullModelWithMetadata.mockResolvedValue(undefined)
    useModelProvider.setState({
      providers: [],
      selectedProvider: '',
      selectedModel: null,
    })
    seedServiceHub({
      models: { pullModelWithMetadata: mocks.pullModelWithMetadata } as never,
    })
  })

  it('offers Download as the primary action, like "New chat" beside it', () => {
    render(<ModelDownloadAction variant={variant} model={model} asButton />)

    expect(downloadButton()).toHaveAttribute('data-variant', 'default')
  })

  it('downloads a variant without selecting or starting it', () => {
    const selectedModel = {
      id: 'already-selected',
      capabilities: [],
      settings: {},
    } as Model
    useModelProvider.setState({
      selectedProvider: 'openai',
      selectedModel,
    })
    render(<ModelDownloadAction variant={variant} model={model} asButton />)

    fireEvent.click(downloadButton())

    expect(mocks.pullModelWithMetadata).toHaveBeenCalled()
    expect(useModelProvider.getState().selectedProvider).toBe('openai')
    expect(useModelProvider.getState().selectedModel).toBe(selectedModel)
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('warns before downloading a variant too large for the device', async () => {
    render(
      <ModelDownloadAction
        variant={variant}
        model={model}
        asButton
        warnTooLarge
      />
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
      <ModelDownloadAction
        variant={variant}
        model={model}
        asButton
        warnTooLarge
      />
    )

    fireEvent.click(downloadButton())
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
  })

  it('does not show a failure toast when an intentional cancel rejects the pull', async () => {
    mocks.pullModelWithMetadata.mockRejectedValueOnce(
      new Error('Download cancelled')
    )
    render(<ModelDownloadAction variant={variant} model={model} asButton />)

    fireEvent.click(downloadButton())

    await waitFor(() => expect(mocks.pullModelWithMetadata).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
