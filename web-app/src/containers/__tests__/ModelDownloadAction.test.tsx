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
  PrismCatalog,
  PrismFamiliesResponse,
} from '@/services/model-setup/types'
import { useModelCompatibilityStore } from '@/stores/model-compatibility-store'

const mocks = vi.hoisted(() => ({
  pullModelWithMetadata: vi.fn(() => Promise.resolve()),
  switchToModel: vi.fn(() => Promise.resolve()),
  toastError: vi.fn(),
  checkCompatibility: vi.fn(),
  prismCatalog: vi.fn(),
  installPrismBuild: vi.fn(),
  activatePrismBuild: vi.fn(),
  deleteModel: vi.fn(),
  abortDownload: vi.fn(),
  getProviders: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
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
      pausedDownloads: new Set(),
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

  it('reopens a restored paused download without cancelling or creating a job', () => {
    useDownloadStore.setState({
      pausedDownloads: new Set([variant.model_id]),
    })
    useDownloadStore.getState().updateProgress(variant.model_id, 0.4, variant.model_id, 40, 100)
    const open = vi.fn()
    window.addEventListener('atomic-open-download-panel', open)
    render(<ModelDownloadAction variant={variant} model={model} asButton />)
    fireEvent.click(screen.getByRole('button', { name: 'common:showDownloadProgress' }))
    expect(open).toHaveBeenCalledTimes(1)
    const state = useDownloadStore.getState()
    expect(Object.keys(state.downloads)).toEqual([variant.model_id])
    expect(state.pausedDownloads.has(variant.model_id)).toBe(true)
    expect(state.downloads[variant.model_id]).toMatchObject({
      progress: 0.4,
      current: 40,
      total: 100,
    })
    expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
    expect(mocks.abortDownload).not.toHaveBeenCalled()
    window.removeEventListener('atomic-open-download-panel', open)
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
    /** The id the Bonsai file registers under. */
    const prismId = 'prism-ml/Bonsai-8B-PQ2_0'
    const pinned = (file: string) =>
      `https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/b072e1d/${file}`
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
    const families: PrismFamiliesResponse = {
      rules_version: 1,
      families: [
        {
          id: 'bonsai-8b',
          title: 'Bonsai 8B',
          repo: 'prism-ml/Bonsai-8B-gguf',
          revision: 'b072e1d',
          files: [
            {
              file: 'Bonsai-8B-PQ2_0.gguf',
              size: 100,
              sha256: 'a'.repeat(64),
              treatment: 'prism_required',
              default: true,
            },
          ],
          projectors: [
            {
              file: 'mmproj-Q8_0.gguf',
              size: 10,
              sha256: 'c'.repeat(64),
              default: true,
            },
          ],
        },
      ],
    }
    const prismBuild = { version: 'prism-b9000-abcdef0', backend: 'macos-arm64' }
    const catalog = (installed: boolean): PrismCatalog => ({
      installed: installed ? [prismBuild] : [],
      available: [prismBuild],
      recommended: 'prism-b9000-abcdef0/macos-arm64',
      releases: [
        { tag: prismBuild.version, variants: [{ id: prismBuild.backend, size: 20 }] },
      ],
    })

    /** The verdicts: the Hub row's, the plan's, and the one on the file on disk. */
    let rowVerdict: CompatibilityVerdict
    let planVerdict: CompatibilityVerdict
    let diskVerdict: CompatibilityVerdict

    class FakeService extends DefaultModelSetupService {
      override isSupported() {
        return true
      }
      override checkCompatibility = mocks.checkCompatibility
      override families = async () => families
      override prismCatalog = mocks.prismCatalog
      override diskAvailable = async () => null
      override installPrismBuild = mocks.installPrismBuild
      override activatePrismBuild = mocks.activatePrismBuild
    }

    beforeEach(() => {
      useModelCompatibilityStore.setState({ verdicts: {} })
      rowVerdict = verdict('compatible', null)
      planVerdict = verdict('engine_required')
      diskVerdict = verdict('compatible')
      mocks.checkCompatibility.mockImplementation(
        async (request: { model_id?: string; inspect_remote?: boolean }) =>
          request.model_id
            ? diskVerdict
            : request.inspect_remote
              ? planVerdict
              : rowVerdict
      )
      mocks.prismCatalog.mockResolvedValue(catalog(false))
      mocks.installPrismBuild.mockResolvedValue(undefined)
      mocks.activatePrismBuild.mockResolvedValue(undefined)
      mocks.deleteModel.mockResolvedValue(undefined)
      mocks.abortDownload.mockResolvedValue(undefined)
      mocks.getProviders.mockResolvedValue([])
      seedServiceHub({
        models: {
          pullModelWithMetadata: mocks.pullModelWithMetadata,
          deleteModel: mocks.deleteModel,
          abortDownload: mocks.abortDownload,
        } as never,
        providers: { getProviders: mocks.getProviders } as never,
        modelSetup: new FakeService(),
      })
    })

    /** The row's verdict as the Hub already asked it. */
    const known = (outcome: CompatibilityVerdict['outcome']) =>
      useModelCompatibilityStore.setState({
        verdicts: { [bonsai.path]: verdict(outcome) },
      })

    it('is marked "Requires PrismML" and opens the setup when the engine is missing', async () => {
      known('engine_required')
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      expect(screen.getByTestId('requires-prism-badge')).toHaveTextContent(
        'hub:prismRequired'
      )
      fireEvent.click(downloadButton())

      expect(await screen.findByTestId('model-setup-sheet')).toBeInTheDocument()
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
      expect(mocks.installPrismBuild).not.toHaveBeenCalled()
    })

    it('asks the core on click when the verdict has not arrived yet', async () => {
      rowVerdict = verdict('engine_required')
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
      useModelCompatibilityStore.setState({
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
        expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
          'Bonsai-8B-PQ2_0',
          bonsai.path,
          undefined,
          '',
          true,
          false
        )
      )
      expect(screen.queryByTestId('model-setup-sheet')).toBeNull()
    })

    it('downloads under PrismML with the app\'s own downloader when the build is installed, and keeps a file PrismML runs', async () => {
      known('compatible')
      planVerdict = verdict('compatible')
      mocks.prismCatalog.mockResolvedValue(catalog(true))
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())

      await waitFor(() =>
        expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
          prismId,
          pinned('Bonsai-8B-PQ2_0.gguf'),
          pinned('mmproj-Q8_0.gguf'),
          '',
          true,
          false,
          {
            provider: 'atomic-prism',
            modelSha256: 'a'.repeat(64),
            modelSize: 100,
            mmprojSha256: 'c'.repeat(64),
            mmprojSize: 10,
          }
        )
      )
      await waitFor(() =>
        expect(mocks.checkCompatibility).toHaveBeenCalledWith({
          model_id: prismId,
          provider: 'atomic-prism',
        })
      )
      expect(screen.queryByTestId('model-setup-sheet')).toBeNull()
      expect(mocks.installPrismBuild).not.toHaveBeenCalled()
      expect(mocks.activatePrismBuild).not.toHaveBeenCalled()
      expect(mocks.deleteModel).not.toHaveBeenCalled()
    })

    it('removes a downloaded file PrismML cannot run, so it is not listed, and says why', async () => {
      known('compatible')
      planVerdict = verdict('compatible')
      mocks.prismCatalog.mockResolvedValue(catalog(true))
      diskVerdict = {
        ...verdict('engine_required', 'llamacpp-upstream'),
        reason: 'The header names another packing.',
      }
      // The import lists the model, as the providers' refresh after a download does.
      mocks.pullModelWithMetadata.mockImplementationOnce(async () => {
        useModelProvider.setState({
          providers: [
            { provider: 'atomic-prism', settings: [], models: [{ id: prismId }] } as never,
          ],
        })
      })
      mocks.getProviders.mockResolvedValue([
        { provider: 'atomic-prism', settings: [], models: [{ id: prismId }] },
      ])
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())

      await waitFor(() =>
        expect(mocks.deleteModel).toHaveBeenCalledWith(prismId, 'atomic-prism')
      )
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith(
          'hub:prismModelRejected',
          { description: 'The header names another packing.' }
        )
      )
      const listed = useModelProvider
        .getState()
        .providers.flatMap((provider) => provider.models.map((m) => m.id))
      expect(listed).not.toContain(prismId)
    })

    it('installs the engine, makes it active and only then downloads, from the sheet', async () => {
      known('engine_required')
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())
      const start = await screen.findByTestId('model-setup-start')
      await waitFor(() => expect(start).toBeEnabled())
      fireEvent.click(start)

      await waitFor(() =>
        expect(mocks.pullModelWithMetadata).toHaveBeenCalled()
      )
      expect(mocks.installPrismBuild).toHaveBeenCalledWith(
        expect.objectContaining(prismBuild),
        'engine-build-atomic-prism-prism-b9000-abcdef0'
      )
      expect(mocks.activatePrismBuild).toHaveBeenCalledWith(
        expect.objectContaining(prismBuild)
      )
      const [installed] = mocks.installPrismBuild.mock.invocationCallOrder
      const [activated] = mocks.activatePrismBuild.mock.invocationCallOrder
      const [pulled] = mocks.pullModelWithMetadata.mock.invocationCallOrder
      expect(installed).toBeLessThan(activated)
      expect(activated).toBeLessThan(pulled)
    })

    it('shows a refused engine install and downloads nothing', async () => {
      known('engine_required')
      mocks.installPrismBuild.mockRejectedValue({
        code: 'ENGINE_INSTALL_IN_PROGRESS',
        message: 'Another install of atomic-prism is running.',
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )
      fireEvent.click(downloadButton())
      const start = await screen.findByTestId('model-setup-start')
      await waitFor(() => expect(start).toBeEnabled())
      fireEvent.click(start)

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('hub:downloadFailed', {
          description: 'Another install of atomic-prism is running.',
        })
      )
      expect(mocks.activatePrismBuild).not.toHaveBeenCalled()
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
      expect(await screen.findByRole('button', { name: 'hub:download' })).toBeEnabled()
    })

    it('keeps following a running Bonsai download when the verdict is forgotten', async () => {
      // A new core generation cleared the verdicts; the download goes on.
      useDownloadStore.setState({
        localDownloadingModels: new Set([prismId]),
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'common:cancelDownload' })
      )

      await waitFor(() =>
        expect(mocks.abortDownload).toHaveBeenCalledWith(prismId)
      )
      expect(screen.queryByRole('button', { name: 'hub:download' })).toBeNull()
    })

    it('cancels a running Bonsai download from the row, like any download', async () => {
      known('compatible')
      useDownloadStore.setState({
        localDownloadingModels: new Set([prismId]),
      })
      render(
        <ModelDownloadAction variant={bonsai} model={bonsaiModel} asButton />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'common:cancelDownload' })
      )

      await waitFor(() =>
        expect(mocks.abortDownload).toHaveBeenCalledWith(prismId)
      )
      expect(useDownloadStore.getState().resumableDownloads.has(prismId)).toBe(
        true
      )
    })
  })
})
