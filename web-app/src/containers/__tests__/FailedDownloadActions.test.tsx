import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFailedDownloadsStore } from '@/stores/failed-downloads-store'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  import: vi.fn(),
  install: vi.fn(),
  getProviders: vi.fn(),
}))
vi.mock('@janhq/core', async (original) => ({
  ...(await original<typeof import('@janhq/core')>()),
  EngineManager: {
    instance: () => ({ get: () => ({ import: mocks.import }) }),
  },
}))
vi.mock('@/services/managed-models/models', async (original) => ({
  ...(await original<typeof import('@/services/managed-models/models')>()),
  installManagedModel: mocks.install,
  managedDownloadId: (repo: string) => `managed-${repo.replace('/', '_')}`,
}))
vi.mock('@/containers/hub/EngineVerdictText', () => ({
  EngineVerdictText: () => <p>Download failed</p>,
}))
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
import { MlxModelDownloadAction } from '../MlxModelDownloadAction'
import { ManagedModelDownloadAction } from '../ManagedModelDownloadAction'

const model = {
  model_name: 'mlx-community/chat',
  developer: 'mlx-community',
  description: '',
  downloads: 0,
  is_mlx: true,
} satisfies CatalogModel
beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProviders.mockResolvedValue([])
  useFailedDownloadsStore.setState({ failures: [] })
  useModelProvider.setState({
    providers: [],
    selectedProvider: '',
    selectedModel: null,
  })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    resumableDownloads: new Set(),
    downloadOriginByModelId: {},
  })
  seedServiceHub({
    models: {
      fetchHuggingFaceRepo: vi
        .fn()
        .mockResolvedValue({ siblings: [{ rfilename: 'model.safetensors' }] }),
    } as never,
    providers: { getProviders: mocks.getProviders } as never,
  })
})
describe('failed download action recovery', () => {
  it.each([false, true])(
    'records MLX import failures but excludes cancellation (%s)',
    async (cancelled) => {
      mocks.import.mockRejectedValueOnce(
        new Error(cancelled ? 'Download cancelled' : 'Network unavailable')
      )
      render(<MlxModelDownloadAction model={model} />)
      fireEvent.click(screen.getByRole('button', { name: 'hub:download' }))
      await waitFor(() =>
        expect(useDownloadStore.getState().resumableDownloads.has('chat')).toBe(
          true
        )
      )
      expect(
        useDownloadStore.getState().localDownloadingModels.has('chat')
      ).toBe(false)
      const failures = useFailedDownloadsStore.getState().failures
      if (cancelled) expect(failures).toEqual([])
      else
        expect(failures).toEqual([
          expect.objectContaining({
            modelId: 'chat',
            repo: model.model_name,
            isMlx: true,
          }),
        ])
    }
  )
  it('does not mark an installed model failed when the provider refresh rejects', async () => {
    const repo = 'owner/managed-chat'
    useFailedDownloadsStore
      .getState()
      .record('managed-owner_managed-chat', repo, false)
    mocks.install.mockResolvedValueOnce(undefined)
    mocks.getProviders.mockRejectedValueOnce(new Error('Core list unavailable'))
    render(
      <ManagedModelDownloadAction
        engineId="vllm"
        model={{ ...model, model_name: repo }}
        revision="revision"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'hub:download' }))
    await waitFor(() =>
      expect(
        useDownloadStore
          .getState()
          .localDownloadingModels.has('managed-owner_managed-chat')
      ).toBe(false)
    )
    expect(useFailedDownloadsStore.getState().failures).toEqual([])
  })

  it('clears a managed failure after successful finalization with no new transfer event', async () => {
    const repo = 'owner/managed-chat'
    useFailedDownloadsStore
      .getState()
      .record('managed-owner_managed-chat', repo, false)
    mocks.install.mockResolvedValueOnce(undefined)
    render(
      <ManagedModelDownloadAction
        engineId="vllm"
        model={{ ...model, model_name: repo }}
        revision="revision"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'hub:download' }))
    await waitFor(() =>
      expect(useFailedDownloadsStore.getState().failures).toEqual([])
    )
    expect(
      useDownloadStore
        .getState()
        .localDownloadingModels.has('managed-owner_managed-chat')
    ).toBe(false)
  })
})
