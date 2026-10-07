import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real download store, not a stub: the row's downloading and resumable
// state is what the cancel test reads back.
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'
import { DefaultModelSetupService } from '@/services/model-setup/default'
import type {
  CompatibilityVerdict,
  ModelSetup,
} from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'

const mocks = vi.hoisted(() => ({
  pullModelWithMetadata: vi.fn(() => Promise.resolve()),
  switchToModel: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
  checkCompatibility: vi.fn(),
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
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      downloadOriginByModelId: {},
    })
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
    // Silent, but not stuck: the row is back on "Download" rather than a
    // dead progress button, and the partial file is kept for a resume.
    await waitFor(() => expect(downloadButton()).toBeEnabled())
    expect(
      screen.queryByRole('button', { name: 'common:cancelDownload' })
    ).toBeNull()
    const downloads = useDownloadStore.getState()
    expect(downloads.localDownloadingModels.has(variant.model_id)).toBe(false)
    expect(downloads.downloadOriginByModelId[variant.model_id]).toBeUndefined()
    expect(downloads.resumableDownloads.has(variant.model_id)).toBe(true)
  })

  describe('a file only PrismML runs', () => {
    const bonsai = {
      model_id: 'Bonsai-8B-PQ2_0',
      path: 'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B-PQ2_0.gguf',
    }
    const bonsaiModel = {
      model_name: 'prism-ml/Bonsai-8B-gguf',
      developer: 'prism-ml',
      quants: [bonsai],
    } as unknown as CatalogModel
    const verdict = (
      outcome: CompatibilityVerdict['outcome'],
      provider: string | null = 'atomic-prism'
    ): CompatibilityVerdict => ({
      outcome,
      provider,
      requires: [],
      evidence: 'rules',
      rules_version: 1,
      reason: 'needs PQ2_0',
    })

    class FakeService extends DefaultModelSetupService {
      override isSupported() {
        return true
      }
      override checkCompatibility = mocks.checkCompatibility
      override plan = vi.fn(() => new Promise<never>(() => {}))
    }

    beforeEach(() => {
      useModelSetupStore.setState({ setups: {}, progress: {}, verdicts: {} })
      mocks.checkCompatibility.mockResolvedValue(verdict('compatible', null))
      seedServiceHub({
        models: { pullModelWithMetadata: mocks.pullModelWithMetadata } as never,
        modelSetup: new FakeService(),
      })
    })

    it('is marked "Requires PrismML" and opens the setup instead of downloading', async () => {
      useModelSetupStore.setState({
        verdicts: { [bonsai.path]: verdict('engine_required') },
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      expect(screen.getByTestId('requires-prism-badge')).toHaveTextContent(
        'hub:prismRequired'
      )
      fireEvent.click(downloadButton())

      expect(await screen.findByTestId('model-setup-sheet')).toBeInTheDocument()
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
    })

    it('asks the core on click when the verdict has not arrived yet', async () => {
      mocks.checkCompatibility.mockResolvedValue(verdict('engine_required'))
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())

      expect(await screen.findByTestId('model-setup-sheet')).toBeInTheDocument()
      expect(mocks.checkCompatibility).toHaveBeenCalledWith({
        repo: 'prism-ml/Bonsai-8B-gguf',
        file: 'Bonsai-8B-PQ2_0.gguf',
        revision: 'main',
        provider: 'llamacpp-upstream',
      })
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
    })

    it('refuses a file no engine runs and names the replacement', async () => {
      useModelSetupStore.setState({
        verdicts: {
          [bonsai.path]: {
            ...verdict('legacy_artifact', null),
            replacement: 'Bonsai-8B-PQ2_0-v2.gguf',
          },
        },
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      expect(screen.queryByTestId('requires-prism-badge')).toBeNull()
      fireEvent.click(downloadButton())

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('hub:prismRefusedTitle', {
          description: 'hub:prismRefusedReplacement',
        })
      )
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
    })

    it('downloads as before when any llama.cpp runs the file', async () => {
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())

      await waitFor(() =>
        expect(mocks.pullModelWithMetadata).toHaveBeenCalled()
      )
      expect(screen.queryByTestId('model-setup-sheet')).toBeNull()
    })

    it('shows the progress of a setup the core is running for the file', () => {
      useModelSetupStore.setState({
        setups: {
          s1: {
            setup_id: 's1',
            revision: 1,
            stage: 'downloading_model',
            request: {
              repo: 'prism-ml/Bonsai-8B-gguf',
              file: 'Bonsai-8B-PQ2_0.gguf',
            },
            plan: {
              verdict: verdict('engine_required'),
              engine: null,
              projector: null,
              model: { size: 100 },
            },
            task_ids: { model: 'tm' },
            updated_at: 1,
          } as unknown as ModelSetup,
        },
        progress: { tm: { transferred: 25, total: 100 } },
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      expect(screen.getByTestId('model-setup-progress')).toHaveTextContent(
        '25%'
      )
    })
  })
})
