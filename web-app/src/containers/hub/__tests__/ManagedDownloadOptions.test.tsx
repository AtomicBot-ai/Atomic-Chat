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

// Each engine's state in the Hub; the engines' plans are another test's.
const hubStates = vi.hoisted(() => ({ value: [] as unknown[] }))
vi.mock('@/hooks/useManagedHubState', () => ({ useManagedHubStates: () => hubStates.value }))

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

import { ManagedDownloadOptions } from '../ManagedDownloadOptions'
import { setManagedEnginesForTests, TENSORRT_LLM_ENGINE, type ManagedEngine } from '@/lib/managed-engines'
import type { ManagedHubStatus } from '@/lib/managed-engine/hub-state'
import type { ModelCompatibility } from '@/services/managed-environment/types'
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
  is_managed: true,
}

const deleteModel = vi.fn()
const getProviders = vi.fn()

/** The second managed engine of these tests; first in the registry, as vLLM is. */
const SECOND: ManagedEngine = { id: 'second-engine', label: 'Second', i18n: 'second' }

const hub = (engine: ManagedEngine, state: ManagedHubStatus) => ({
  engine,
  hub: { visible: true, state, blockers: [], descriptorId: `${engine.id}-r1` },
})

const providerOf = (name: string, ids: string[]): ModelProvider =>
  ({ active: true, provider: name, persist: true, settings: [], models: ids.map((id) => ({ id })) }) as ModelProvider

const accepts: ModelCompatibility = {
  architectures: ['Qwen3ForCausalLM'],
  quantization_format: 'autoawq_w4a16',
  weight_bytes: 5 * GB,
  checked_gpu_id: 'GPU-1',
  curated: false,
  unified_memory: false,
  fits_other_gpus: [],
  verdict: { ok: true },
}
const refuses: ModelCompatibility = {
  ...accepts,
  verdict: {
    ok: false,
    error: { code: 'MODEL_INCOMPATIBLE', message: 'tensorrt-llm does not support "autoawq_w4a16".' },
  },
}

/** Each engine's answer, by engine id. */
function answers(byEngine: Record<string, ModelCompatibility>) {
  trtModels.checkManagedModel.mockImplementation(async (engine: string) => byEngine[engine])
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedVerdictsForTests()
  setManagedEnginesForTests(undefined)
  hubStates.value = [hub(TENSORRT_LLM_ENGINE, 'ready')]
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
    render(<ManagedDownloadOptions model={card} />)

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
    render(<ManagedDownloadOptions model={card} />)

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
    hubStates.value = [hub(TENSORRT_LLM_ENGINE, 'not-installed')]
    render(<ManagedDownloadOptions model={card} />)

    expect(screen.queryByRole('button', { name: 'hub:newChat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common:deleteModel.delete' })).toBeInTheDocument()
  })
})

describe('a card under several managed engines (spec vllm-desktop)', () => {
  const notDownloaded = { ...card, model_name: 'casperhansen/Qwen3-8B-AWQ', developer: 'casperhansen' }

  beforeEach(() => {
    setManagedEnginesForTests([SECOND, TENSORRT_LLM_ENGINE])
    useModelProvider.setState({
      providers: [providerOf('second-engine', []), providerOf('tensorrt-llm', [])],
      deletedModels: [],
    })
  })

  it('AWQ model, only TensorRT-LLM installed: its refusal, Install for the engine that would take it, no download', async () => {
    hubStates.value = [hub(SECOND, 'not-installed'), hub(TENSORRT_LLM_ENGINE, 'ready')]
    answers({ 'second-engine': accepts, 'tensorrt-llm': refuses })
    render(<ManagedDownloadOptions model={notDownloaded} />)

    expect(await screen.findByText(/does not support "autoawq_w4a16"/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'hub:second.installEngine' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'hub:tensorrt.installEngine' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    // Registry order: the second engine (vLLM's place) first.
    const badges = screen.getAllByText(/^(Second|TensorRT-LLM)$/).map((badge) => badge.textContent)
    expect(badges).toEqual(['Second', 'TensorRT-LLM'])

    await userEvent.setup().click(screen.getByRole('button', { name: 'hub:second.installEngine' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { providerName: 'second-engine' } })
    )
  })

  it('model fits both installed engines: Download, checked with the first engine that takes it', async () => {
    hubStates.value = [hub(SECOND, 'ready'), hub(TENSORRT_LLM_ENGINE, 'ready')]
    answers({ 'second-engine': accepts, 'tensorrt-llm': accepts })
    render(<ManagedDownloadOptions model={notDownloaded} />)

    expect(await screen.findByRole('button', { name: 'hub:download' })).toBeInTheDocument()
    expect(screen.getAllByText(/models.fits/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /installEngine/ })).not.toBeInTheDocument()
  })

  it('only the second engine installed, TensorRT-LLM would take it too: Download, and Install beside TensorRT-LLM', async () => {
    // spec tensorrt-llm-desktop "Установлен только vLLM".
    hubStates.value = [hub(SECOND, 'ready'), hub(TENSORRT_LLM_ENGINE, 'not-installed')]
    answers({ 'second-engine': accepts, 'tensorrt-llm': accepts })
    render(<ManagedDownloadOptions model={notDownloaded} />)

    expect(await screen.findByRole('button', { name: 'hub:download' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'hub:tensorrt.installEngine' })).toBeInTheDocument()
  })

  it('both refuse: no download and no install', async () => {
    hubStates.value = [hub(SECOND, 'ready'), hub(TENSORRT_LLM_ENGINE, 'ready')]
    answers({ 'second-engine': refuses, 'tensorrt-llm': refuses })
    render(<ManagedDownloadOptions model={notDownloaded} />)

    expect(await screen.findAllByText(/does not support/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /installEngine/ })).not.toBeInTheDocument()
  })

  it('New chat with two engines: lets the person choose, the first engine chosen, and opens the chat on the chosen one', async () => {
    hubStates.value = [hub(SECOND, 'ready'), hub(TENSORRT_LLM_ENGINE, 'ready')]
    answers({ 'second-engine': accepts, 'tensorrt-llm': accepts })
    useModelProvider.setState({
      providers: [providerOf('second-engine', [REPO]), providerOf('tensorrt-llm', [REPO])],
      deletedModels: [],
    })
    const user = userEvent.setup()
    render(<ManagedDownloadOptions model={card} />)

    // The choice shows the default engine.
    const choice = await screen.findByRole('button', { name: 'Second' })
    await user.click(screen.getByRole('button', { name: 'hub:newChat' }))
    expect(switching.switchToModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: REPO, providerName: 'second-engine' })
    )

    await user.click(choice)
    await user.click(screen.getByRole('menuitem', { name: 'TensorRT-LLM' }))
    await user.click(screen.getByRole('button', { name: 'hub:newChat' }))
    expect(switching.switchToModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: REPO, providerName: 'tensorrt-llm' })
    )
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { threadModel: { id: REPO, provider: 'tensorrt-llm' } } })
    )
  })

  it('New chat with one engine that takes the model: no choice, the chat opens on it', async () => {
    hubStates.value = [hub(SECOND, 'ready'), hub(TENSORRT_LLM_ENGINE, 'ready')]
    answers({ 'second-engine': accepts, 'tensorrt-llm': refuses })
    useModelProvider.setState({
      providers: [providerOf('second-engine', [REPO]), providerOf('tensorrt-llm', [REPO])],
      deletedModels: [],
    })
    const user = userEvent.setup()
    render(<ManagedDownloadOptions model={card} />)

    await screen.findByText(/does not support/)
    expect(screen.queryByRole('button', { name: 'Second' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'hub:newChat' }))
    expect(switching.switchToModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerName: 'second-engine' })
    )
  })
})
