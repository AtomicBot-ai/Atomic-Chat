import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
const fetchHuggingFaceRepo = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({ fetchHuggingFaceRepo, abortDownload: vi.fn() }),
  }),
}))
const engine = vi.hoisted(() => ({ import: vi.fn() }))
vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EngineManager: { instance: () => ({ get: () => engine }) },
}))
const mlxEngine = vi.hoisted(() => ({
  downloadWithMlxEngine: vi.fn((download: () => Promise<boolean>) =>
    download()
  ),
}))
vi.mock('@/lib/mlx-engine', () => mlxEngine)

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useMlxEngineInstallStore } from '@/services/engine-builds/mlx'
import type { CatalogModel } from '@/services/models/types'

import { MlxModelDownloadAction } from '../MlxModelDownloadAction'

const model = {
  model_name: 'mlx-community/Qwen3-4B-4bit',
  developer: 'mlx-community',
} as CatalogModel

const button = () =>
  document.querySelector('[data-test-id="hub-model-Qwen3-4B-4bit"]')

beforeEach(() => {
  vi.clearAllMocks()
  useMlxEngineInstallStore.setState({ installing: false, progress: null })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    resumableDownloads: new Set(),
  })
  useModelProvider.setState({ providers: [] })
})

describe('MlxModelDownloadAction', () => {
  it('downloads the model through the helper that adds a missing engine', async () => {
    fetchHuggingFaceRepo.mockResolvedValue({
      siblings: [{ rfilename: 'model.safetensors' }],
    })
    engine.import.mockResolvedValue(undefined)
    render(<MlxModelDownloadAction model={model} />)

    await act(async () => {
      fireEvent.click(screen.getByText('hub:download'))
    })

    expect(mlxEngine.downloadWithMlxEngine).toHaveBeenCalledTimes(1)
    await expect(
      mlxEngine.downloadWithMlxEngine.mock.results[0].value
    ).resolves.toBe(true)
    expect(engine.import).toHaveBeenCalledWith(
      'Qwen3-4B-4bit',
      expect.objectContaining({
        modelPath:
          'https://huggingface.co/mlx-community/Qwen3-4B-4bit/resolve/main/model.safetensors',
      })
    )
  })

  it('holds "New chat" for a downloaded model while the engine it runs on installs', () => {
    useModelProvider.setState({
      providers: [
        { provider: 'mlx', models: [{ id: 'Qwen3-4B-4bit' }] },
      ] as unknown as ModelProvider[],
    })
    useMlxEngineInstallStore.setState({ installing: true })
    render(<MlxModelDownloadAction model={model} />)

    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute(
      'title',
      'settings:mlxEngine.installingEngine'
    )

    act(() => useMlxEngineInstallStore.setState({ installing: false }))
    expect(button()).toBeEnabled()
    expect(button()).toHaveTextContent('hub:newChat')
  })
})
