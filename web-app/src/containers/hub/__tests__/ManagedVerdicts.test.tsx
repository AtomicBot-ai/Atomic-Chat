import { render, renderHook, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const models = vi.hoisted(() => ({
  fetchHfRevision: vi.fn(),
  checkManagedModel: vi.fn(),
}))
vi.mock('@/services/managed-models/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-models/models')>()),
  ...models,
}))

// Which engines the Hub offers and with which descriptor: the engines' plans are another test's.
const hubStates = vi.hoisted(() => ({ value: [] as unknown[] }))
vi.mock('@/hooks/useManagedHubState', () => ({ useManagedHubStates: () => hubStates.value }))

import { EngineVerdictText } from '../ManagedVerdicts'
import { useManagedVerdicts } from '@/hooks/useManagedVerdicts'
import { TENSORRT_LLM_ENGINE, type ManagedEngine } from '@/lib/managed-engines'
import type { ManagedHubState } from '@/lib/managed-engine/hub-state'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  GatedModelError,
  IncompatibleModelError,
  InsufficientModelSpaceError,
} from '@/services/managed-models/models'
import {
  resetManagedVerdictsForTests,
  verdictFromError,
  type ManagedVerdict as Verdict,
} from '@/services/managed-models/verdict'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type { ModelCompatibility } from '@/services/managed-environment/types'
import type { CatalogModel } from '@/services/models/types'

const compatible: ModelCompatibility = {
  architectures: ['Qwen3ForCausalLM'],
  quantization_format: 'fp8',
  weight_bytes: 8e9,
  checked_gpu_id: 'GPU-1',
  curated: false,
  unified_memory: false,
  fits_other_gpus: [],
  verdict: { ok: true },
}
const incompatible: ModelCompatibility = {
  ...compatible,
  fits_other_gpus: ['GPU-2'],
  verdict: {
    ok: false,
    error: { code: 'MODEL_INCOMPATIBLE', message: 'Needs compute capability 10.0, the card has 8.9.' },
  },
}

const trt = (repository: string, revision?: string): CatalogModel => ({
  model_name: repository,
  description: '',
  downloads: 0,
  is_managed: true,
  ...(revision ? { managed: { curated: true, revision } } : {}),
})

const SECOND: ManagedEngine = { id: 'second-engine', label: 'Second', i18n: 'second' }

const hub = (overrides: Partial<ManagedHubState> = {}): ManagedHubState => ({
  visible: true,
  state: 'ready',
  blockers: [],
  descriptorId: 'tensorrt-llm-1.3.0rc29-r3',
  ...overrides,
})

/** The TensorRT-LLM verdict as the Hub card renders it. */
function Verdict({ model }: { model: CatalogModel }) {
  const verdict = useManagedVerdicts(model)[0]?.verdict
  return verdict ? <EngineVerdictText engine={TENSORRT_LLM_ENGINE} verdict={verdict} /> : <p>checking</p>
}

const trtVerdict = (model: CatalogModel) => {
  const own = useManagedVerdicts(model)[0]
  return { verdict: own?.verdict ?? null, checking: own?.checking ?? false }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedVerdictsForTests()
  hubStates.value = [{ engine: TENSORRT_LLM_ENGINE, hub: hub() }]
  useGeneralSetting.setState({ huggingfaceToken: 'hf_secret' })
  useManagedEnvironmentStore.getState().reset()
  useManagedEnvironmentStore.getState().applySnapshot({
    instance_id: 'core-a',
    environments: [
      {
        schema_version: 1,
        environment_id: 'default',
        instance_id: 'core-a',
        revision: 1,
        executor: 'linux-docker',
        availability: 'supported',
        gpus: [
          { gpu_id: 'GPU-1', name: 'RTX 4070', compute_capability: '8.9', total_vram_bytes: 12e9, free_vram_bytes: 11e9, driver_version: '590' },
          { gpu_id: 'GPU-2', name: 'RTX 5090', compute_capability: '12.0', total_vram_bytes: 32e9, free_vram_bytes: 31e9, driver_version: '590' },
        ],
        blockers: [],
        selinux: false,
        installations: [],
        active_operation_id: null,
        minimum_app_version: null,
      },
    ],
    environment_operations: [],
  })
  models.fetchHfRevision.mockImplementation(async (repository: string) => ({
    repository,
    revision: 'abc',
    config_json: {},
    hf_quant_config_json: null,
    files: [],
  }))
  models.checkManagedModel.mockResolvedValue(compatible)
})

describe('the TensorRT-LLM verdict of a Hub card (ManagedVerdicts)', () => {
  it('says why the model cannot run here, with the core numbers, and names the card it fits', async () => {
    // spec "Вставлен несовместимый репозиторий".
    models.checkManagedModel.mockResolvedValue(incompatible)
    render(<Verdict model={trt('nvidia/Qwen3-8B-NVFP4')} />)

    expect(await screen.findByText(/compute capability 10\.0, the card has 8\.9/)).toBeInTheDocument()
    expect(screen.getByText(/RTX 5090/)).toBeInTheDocument()
  })

  it('sends the person to the model page to accept its terms when access is refused', async () => {
    // spec "Gated-модель без принятых условий".
    models.fetchHfRevision.mockRejectedValue(new GatedModelError('meta-llama/Llama-3.3-70B-Instruct'))
    render(<Verdict model={trt('meta-llama/Llama-3.3-70B-Instruct')} />)

    const link = await screen.findByRole('link', { name: /hub:tensorrt.models.gated/ })
    expect(link).toHaveAttribute('href', 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct')
  })

  it('says the model fits with the size of its weights, and shows a warning of the check without refusing', async () => {
    models.checkManagedModel.mockResolvedValue({
      ...compatible,
      warnings: [
        {
          code: 'wsl-vm-memory',
          message: 'The WSL VM has 16 GB of memory and the weights take 20 GB: loading will be slow.',
        },
      ],
    })
    render(<Verdict model={trt('nvidia/Qwen3-32B-FP8')} />)

    expect(await screen.findByText(/hub:tensorrt.models.fits/)).toHaveTextContent('"size":"7.5 GB"')
    expect(screen.getByText(/The WSL VM has 16 GB of memory/)).toBeInTheDocument()
  })

  it('reads a curated model at its pinned revision with the Hugging Face token', async () => {
    const { result } = renderHook(() => trtVerdict(trt('nvidia/Qwen3-8B-FP8', 'r-fits')))

    await waitFor(() => expect(result.current.verdict?.kind).toBe('ok'))
    expect(models.fetchHfRevision).toHaveBeenCalledWith('nvidia/Qwen3-8B-FP8', 'r-fits', 'hf_secret')
  })

  it('does not ask the core again when the card is opened again', async () => {
    const first = renderHook(() => trtVerdict(trt('nvidia/Qwen3-8B-FP8')))
    await waitFor(() => expect(first.result.current.verdict?.kind).toBe('ok'))
    first.unmount()

    const again = renderHook(() => trtVerdict(trt('nvidia/Qwen3-8B-FP8')))

    // Held, so there from the first render: nothing to wait for.
    expect(again.result.current.verdict?.kind).toBe('ok')
    expect(again.result.current.checking).toBe(false)
    expect(models.checkManagedModel).toHaveBeenCalledTimes(1)
  })

  it('claims nothing for a model of another format', () => {
    const { result } = renderHook(() =>
      useManagedVerdicts({ model_name: 'Qwen/Qwen3-8B-GGUF', description: '', downloads: 0 })
    )
    expect(result.current).toEqual([])
    expect(models.fetchHfRevision).not.toHaveBeenCalled()
  })
})

describe('the verdicts of several managed engines (ManagedVerdicts)', () => {
  it('asks each visible engine with its own check, in registry order, and keeps each answer apart', async () => {
    hubStates.value = [
      { engine: SECOND, hub: hub({ state: 'not-installed', descriptorId: 'second-engine-1-r1' }) },
      { engine: TENSORRT_LLM_ENGINE, hub: hub() },
    ]
    models.checkManagedModel.mockImplementation(async (engine: string) =>
      engine === 'tensorrt-llm' ? incompatible : compatible
    )

    const { result } = renderHook(() => useManagedVerdicts(trt('casperhansen/Qwen3-8B-AWQ')))

    await waitFor(() => expect(result.current.every((entry) => !entry.checking)).toBe(true))
    expect(result.current.map((entry) => [entry.engine.id, entry.verdict?.kind])).toEqual([
      ['second-engine', 'ok'],
      ['tensorrt-llm', 'incompatible'],
    ])
    expect(models.checkManagedModel).toHaveBeenCalledTimes(2)
  })

  it('asks again when the engine checks with another descriptor, and not for an engine the Hub does not offer', async () => {
    hubStates.value = [
      { engine: SECOND, hub: hub({ visible: false }) },
      { engine: TENSORRT_LLM_ENGINE, hub: hub() },
    ]
    const view = renderHook(() => useManagedVerdicts(trt('nvidia/Qwen3-8B-FP8')))
    await waitFor(() => expect(view.result.current[0]?.verdict?.kind).toBe('ok'))
    expect(view.result.current.map((entry) => entry.engine.id)).toEqual(['tensorrt-llm'])
    expect(models.checkManagedModel).toHaveBeenCalledTimes(1)

    hubStates.value = [{ engine: TENSORRT_LLM_ENGINE, hub: hub({ descriptorId: 'tensorrt-llm-1.3.0rc29-r4' }) }]
    view.rerender()
    await waitFor(() => expect(models.checkManagedModel).toHaveBeenCalledTimes(2))
  })

  it("asks again once the engine's settings change, and not for a change to another provider", async () => {
    // The person lowered the parallel requests of the engine after it refused the model for memory.
    const withSettings = (provider: string, value: unknown) =>
      ({
        provider,
        active: true,
        models: [],
        settings: [
          { key: 'max_num_seqs', title: '', description: '', controller_type: 'input', controller_props: { value } },
        ],
      }) as never
    useModelProvider.setState({ providers: [withSettings('tensorrt-llm', 8), withSettings('llamacpp', 4)] })
    const view = renderHook(() => trtVerdict(trt('nvidia/Qwen3-8B-FP8')))
    await waitFor(() => expect(view.result.current.verdict?.kind).toBe('ok'))
    expect(models.checkManagedModel).toHaveBeenCalledTimes(1)

    useModelProvider.setState({ providers: [withSettings('tensorrt-llm', 8), withSettings('llamacpp', 1)] })
    view.rerender()
    expect(models.checkManagedModel).toHaveBeenCalledTimes(1)

    models.checkManagedModel.mockResolvedValue(incompatible)
    useModelProvider.setState({ providers: [withSettings('tensorrt-llm', 1), withSettings('llamacpp', 1)] })
    view.rerender()
    await waitFor(() => expect(view.result.current.verdict?.kind).toBe('incompatible'))
    expect(models.checkManagedModel).toHaveBeenCalledTimes(2)
  })

  it('asks an engine whose plan has not answered (or failed) too, instead of checking forever', async () => {
    // Review finding: a probe that failed left the row on "checking" for good.
    hubStates.value = [{ engine: TENSORRT_LLM_ENGINE, hub: hub({ state: 'unknown', descriptorId: null }) }]
    const { result } = renderHook(() => useManagedVerdicts(trt('nvidia/Qwen3-8B-FP8')))

    await waitFor(() => expect(result.current[0]?.verdict?.kind).toBe('ok'))
    expect(result.current[0]?.checking).toBe(false)
  })
})

describe('a download the core or the disk refused', () => {
  const show = (verdict: Verdict) => render(<EngineVerdictText engine={TENSORRT_LLM_ENGINE} verdict={verdict} />)

  it('reports an install the core refused after the files were checked again', () => {
    show(verdictFromError(new IncompatibleModelError(incompatible)))
    expect(screen.getByText(/the card has 8\.9/)).toBeInTheDocument()
  })

  it('says where the model would go, what it needs and what is free when the core has no room', () => {
    const root = '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1\\managed-models'
    show(verdictFromError(new InsufficientModelSpaceError(root, 8 * 1024 ** 3, 6 * 1024 ** 3)))

    const line = screen.getByText(/hub:tensorrt.models.noSpace/)
    expect(line).toHaveTextContent('"needed":"8.0 GB"')
    expect(line).toHaveTextContent('"free":"6.0 GB"')
    expect(line).toHaveTextContent('wsl.localhost')
  })

  it('shows any other failure in its own words', () => {
    show(verdictFromError(new Error('Hugging Face answered 500')))
    expect(screen.getByText('Hugging Face answered 500')).toBeInTheDocument()
  })
})
