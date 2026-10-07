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
  ModelSetupPlan,
} from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'

const mocks = vi.hoisted(() => ({
  pullModelWithMetadata: vi.fn(() => Promise.resolve()),
  switchToModel: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
  checkCompatibility: vi.fn(),
  plan: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
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

    const plan = (engineInstalled: boolean): ModelSetupPlan => ({
      digest: 'digest-1',
      model_id: 'prism-ml/Bonsai-8B-PQ2_0',
      provider: 'atomic-prism',
      verdict: verdict(engineInstalled ? 'compatible' : 'engine_required'),
      engine: {
        provider: 'atomic-prism',
        version: 'prism-b9000-abcdef0',
        backend: 'macos-arm64',
        installed: engineInstalled,
        download_size: engineInstalled ? 0 : 20_000_000,
      },
      model: {
        repo: 'prism-ml/Bonsai-8B-gguf',
        file: 'Bonsai-8B-PQ2_0.gguf',
        revision: 'main',
        size: 100,
      },
      projector: null,
      total_download_bytes: 100,
      free_bytes: null,
      blockers: [],
    })

    const running = (engineInstalled: boolean, stage = 'downloading_model') =>
      ({
        setup_id: 's1',
        revision: 1,
        stage,
        request: {
          repo: 'prism-ml/Bonsai-8B-gguf',
          file: 'Bonsai-8B-PQ2_0.gguf',
        },
        plan: plan(engineInstalled),
        task_ids: { model: 'tm' },
        updated_at: 1,
      }) as unknown as ModelSetup

    class FakeService extends DefaultModelSetupService {
      override isSupported() {
        return true
      }
      override checkCompatibility = mocks.checkCompatibility
      override plan = mocks.plan
      override start = mocks.start
      override cancel = mocks.cancel
    }

    beforeEach(() => {
      useModelSetupStore.setState({ setups: {}, progress: {}, verdicts: {} })
      mocks.checkCompatibility.mockResolvedValue(verdict('compatible', null))
      mocks.plan.mockResolvedValue(plan(false))
      mocks.start.mockResolvedValue(running(true, 'queued'))
      mocks.cancel.mockResolvedValue({
        ...running(true),
        stage: 'cancelled',
        revision: 2,
      })
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

    it('downloads without the sheet when PrismML is already installed', async () => {
      useModelSetupStore.setState({
        verdicts: { [bonsai.path]: verdict('compatible') },
      })
      mocks.plan.mockResolvedValue(plan(true))
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())

      await waitFor(() => expect(mocks.start).toHaveBeenCalled())
      const [request] = mocks.start.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ]
      expect(request).toMatchObject({
        repo: 'prism-ml/Bonsai-8B-gguf',
        file: 'Bonsai-8B-PQ2_0.gguf',
        include_projector: true,
        plan_digest: 'digest-1',
      })
      expect(await screen.findByTestId('model-setup-progress')).toBeEnabled()
      expect(screen.queryByTestId('model-setup-sheet')).toBeNull()
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
    })

    it('says so when the setup cannot start, as a failed download does', async () => {
      useModelSetupStore.setState({
        verdicts: { [bonsai.path]: verdict('compatible') },
      })
      mocks.plan.mockResolvedValue(plan(true))
      mocks.start.mockRejectedValue({ code: 'X', message: 'core is down' })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('hub:downloadFailed', {
          description: 'core is down',
        })
      )
      expect(
        await screen.findByRole('button', { name: 'hub:download' })
      ).toBeEnabled()
      expect(screen.queryByTestId('model-setup-sheet')).toBeNull()
    })

    it('cancels a running download-only setup from the row, like a download', async () => {
      useModelSetupStore.setState({
        setups: { s1: running(true) },
        progress: { tm: { transferred: 25, total: 100 } },
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      const progress = screen.getByTestId('model-setup-progress')
      expect(progress).toHaveTextContent('25%')
      expect(progress).toHaveAccessibleName('common:cancelDownload')
      fireEvent.click(progress)

      await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('s1'))
      expect(screen.queryByTestId('model-setup-sheet')).toBeNull()
    })

    it('opens the sheet from the progress of a setup that installs the engine', async () => {
      useModelSetupStore.setState({
        setups: { s1: running(false) },
        progress: { tm: { transferred: 25, total: 100 } },
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      const progress = screen.getByTestId('model-setup-progress')
      expect(progress).toHaveAccessibleName('hub:prismSetupOpen')
      fireEvent.click(progress)

      expect(await screen.findByTestId('model-setup-sheet')).toBeInTheDocument()
      expect(mocks.cancel).not.toHaveBeenCalled()
    })
  })
})
