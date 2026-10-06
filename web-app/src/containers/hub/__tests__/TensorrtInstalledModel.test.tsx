import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const tensorrtHub = vi.hoisted(() => ({ state: 'ready' as string }))
vi.mock('@/hooks/useManagedHubState', () => ({
  useManagedHubState: () => ({
    visible: true,
    state: tensorrtHub.state,
    blockers: [],
    descriptorId: 'tensorrt-llm-1.3.0rc29-r2',
  }),
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const switching = vi.hoisted(() => ({ switchToModel: vi.fn(async () => {}) }))
vi.mock('@/utils/switchModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/switchModel')>()),
  ...switching,
}))

const trtModels = vi.hoisted(() => ({ fetchHfRevision: vi.fn(), checkManagedModel: vi.fn() }))
vi.mock('@/services/managed-models/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-models/models')>()),
  ...trtModels,
}))

import { TensorrtDownloadOptions } from '../TensorrtDownloadOptions'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { resetManagedVerdictsForTests } from '@/services/managed-models/verdict'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'

const REPO = 'nvidia/Qwen3-8B-FP8'
const GB = 1024 ** 3

const tensorrt = (ids: string[]): ModelProvider =>
  ({
    active: true,
    provider: 'tensorrt-llm',
    persist: true,
    settings: [],
    models: ids.map((id) => ({ id })),
  }) as ModelProvider

/** A downloaded model as the Hub's Downloaded list carries it (`collectInstalledModels`). */
const card: CatalogModel = {
  model_name: REPO,
  developer: 'nvidia',
  description: '',
  downloads: 0,
  is_tensorrt_llm: true,
}

const deleteModel = vi.fn()
const getProviders = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedVerdictsForTests()
  tensorrtHub.state = 'ready'
  deleteModel.mockResolvedValue({ freedBytes: 8 * GB })
  getProviders.mockResolvedValue([tensorrt([])])
  seedServiceHub({
    models: { deleteModel, stopModel: vi.fn() } as unknown as ModelsService,
    providers: { getProviders } as unknown as ProvidersService,
  })
  useModelProvider.setState({ providers: [tensorrt([REPO])], deletedModels: [] })
  useAppState.setState({ activeModels: [] })
  trtModels.fetchHfRevision.mockImplementation(async (repository: string) => ({
    repository,
    revision: 'sha',
    config_json: {},
    hf_quant_config_json: null,
    files: [],
  }))
  trtModels.checkManagedModel.mockResolvedValue({
    architectures: ['Qwen3ForCausalLM'],
    quantization_format: 'fp8',
    weight_bytes: 8 * GB,
    checked_gpu_id: 'GPU-1',
    curated: true,
    unified_memory: false,
    fits_other_gpus: [],
    verdict: { ok: true },
  })
})

describe('a downloaded TensorRT-LLM model in the Hub', () => {
  it('opens a new chat with the model on the TensorRT-LLM provider', async () => {
    const user = userEvent.setup()
    render(<TensorrtDownloadOptions model={card} />)

    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'hub:newChat' }))

    expect(useModelProvider.getState().selectedProvider).toBe('tensorrt-llm')
    expect(switching.switchToModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: REPO, providerName: 'tensorrt-llm' })
    )
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { threadModel: { id: REPO, provider: 'tensorrt-llm' } },
      })
    )
  })

  it('deletes it through the core, says how much was freed, and offers the download again', async () => {
    // spec "Удаление из Hub".
    const user = userEvent.setup()
    render(<TensorrtDownloadOptions model={card} />)

    await user.click(screen.getByRole('button', { name: 'common:deleteModel.delete' }))
    const confirm = await screen.findAllByRole('button', { name: 'common:deleteModel.delete' })
    await user.click(confirm[confirm.length - 1])

    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith(REPO, 'tensorrt-llm'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.success.mock.calls[0][1].description).toBe(
      `common:deleteModel.successFreed {"modelId":"${REPO}","size":"8.0 GB"}`
    )
    expect(await screen.findByRole('button', { name: 'hub:download' })).toBeInTheDocument()
  })

  it('without the engine, can still be deleted but opens no chat', () => {
    tensorrtHub.state = 'not-installed'
    render(<TensorrtDownloadOptions model={card} />)

    expect(screen.queryByRole('button', { name: 'hub:newChat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common:deleteModel.delete' })).toBeInTheDocument()
  })
})
