import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const core = vi.hoisted(() => ({ checkGeniexModel: vi.fn(), geniexAccelerators: vi.fn() }))
vi.mock('@/services/geniex/core', () => core)

const installer = vi.hoisted(() => ({ installGeniexModel: vi.fn(async () => ({ modelId: 'x' })) }))
vi.mock('@/services/geniex/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/geniex/install')>()),
  ...installer,
}))

import { GeniexDownloadOptions } from '../GeniexDownloadOptions'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import type { GeniexCheckResult, GeniexHubModel, GeniexHubVariant } from '@/services/geniex/types'

const SHA = 'a'.repeat(64)
const file = { path: 'gemma-4-E4B_q4_0-it.gguf', size: 5_000_000_000, sha256: SHA }
const mmproj = { path: 'gemma-4-E4B-it-mmproj.gguf', size: 1_000_000_000, sha256: SHA }

const gguf = (extra: Partial<GeniexHubModel> = {}): GeniexHubModel => ({
  origin: 'curated',
  kind: 'gguf',
  model_id: 'gemma-4-e4b',
  name: 'Gemma 4 E4B',
  summary: '',
  license: 'apache-2.0',
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: true,
  gguf: {
    repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
    revision: 'b'.repeat(40),
    gated: false,
    file,
    mmproj,
    devices: ['npu', 'gpu', 'cpu', 'hybrid'],
    platforms: ['win-arm64'],
  },
  ...extra,
})

const variants: GeniexHubVariant[] = [
  {
    id: 'qwen3-4b-aihub-x-elite',
    chip: 'x-elite',
    bundle: { url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/q/x-elite.zip', size: 2_500_000_000, sha256: SHA },
    precision: 'w4a16',
    min_runtime_version: '0.9.3',
  },
  {
    id: 'qwen3-4b-aihub-x2-elite',
    chip: 'x2-elite',
    bundle: { url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/q/x2-elite.zip', size: 2_600_000_000, sha256: SHA },
    precision: 'w4a16',
  },
]

const bundle = (extra: Partial<GeniexHubModel> = {}): GeniexHubModel => ({
  origin: 'curated',
  kind: 'qairt',
  model_id: 'qwen3-4b-aihub',
  name: 'Qwen3 4B (AI Hub)',
  summary: '',
  license: 'apache-2.0',
  context_length: 4096,
  tools: true,
  reasoning: false,
  vision: false,
  variants,
  ...extra,
})

const model = (fields: GeniexHubModel): CatalogModel => ({
  model_name: `geniex/${fields.model_id}`,
  description: '',
  downloads: 0,
  is_geniex: true,
  geniex: fields,
})

function verdicts(map: Partial<Record<string, GeniexCheckResult['verdict']>>) {
  core.checkGeniexModel.mockImplementation(async ({ device }: { device: string }) => {
    const verdict = map[device] ?? 'ok'
    return verdict === 'ok' ? { verdict, reason: null } : { verdict, reason: `${device}: ${verdict}` }
  })
}

const option = (label: string) => screen.getByRole('radio', { name: new RegExp(label) })

beforeEach(() => {
  vi.clearAllMocks()
  useModelProvider.setState({ providers: [] })
  useDownloadStore.setState({ downloads: {}, localDownloadingModels: new Set() })
  useGeneralSetting.setState({ huggingfaceToken: '' })
  seedServiceHub({ providers: { getProviders: vi.fn(async () => []) } as unknown as ProvidersService })
})

describe('GeniexDownloadOptions — a GGUF model', () => {
  it('on a laptop with the NPU picks it by default, offers hybrid, and downloads for the picked device', async () => {
    // spec geniex-models "Ноутбук с NPU"; spec geniex-desktop "Скачивание Gemma 4 E4B".
    verdicts({})
    const user = userEvent.setup()

    render(<GeniexDownloadOptions model={model(gguf())} chip="x-elite" />)

    await waitFor(() => expect(option('hub:geniex.device.npu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(core.checkGeniexModel).toHaveBeenCalledWith({ plugin: 'llama_cpp', device: 'npu' })
    expect(core.checkGeniexModel).toHaveBeenCalledWith({ plugin: 'llama_cpp', device: 'hybrid' })
    await user.click(screen.getByRole('button', { name: 'hub:download' }))
    await waitFor(() =>
      expect(installer.installGeniexModel).toHaveBeenCalledWith(expect.objectContaining({ device: 'npu' }))
    )
    expect(useDownloadStore.getState().downloadOriginByModelId['geniex-gemma-4-e4b']).toBe(
      'Gemma 4 E4B (hub:geniex.device.npu)'
    )
  })

  it('without the NPU picks the GPU, says why the NPU is not there, and lets the person pick hybrid', async () => {
    // spec geniex-runtime "NPU не найден".
    verdicts({ npu: 'accelerator-unavailable', hybrid: 'accelerator-unavailable' })
    const user = userEvent.setup()

    render(<GeniexDownloadOptions model={model(gguf())} chip="x-elite" />)

    await waitFor(() => expect(option('hub:geniex.device.gpu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByText('npu: accelerator-unavailable')).toBeInTheDocument()
    await user.click(option('hub:geniex.device.hybrid'))
    expect(option('hub:geniex.device.hybrid')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
  })

  it('leads to installing the SDK instead of downloading when it is not installed', async () => {
    // spec geniex-desktop "Движок не установлен".
    verdicts({ npu: 'engine-not-installed', gpu: 'engine-not-installed', cpu: 'engine-not-installed', hybrid: 'engine-not-installed' })
    const user = userEvent.setup()

    render(<GeniexDownloadOptions model={model(gguf())} chip="x-elite" />)

    await user.click(await screen.findByRole('button', { name: 'hub:geniex.installEngine' }))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { providerName: 'geniex' } }))
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    expect(installer.installGeniexModel).not.toHaveBeenCalled()
  })

  it('explains a gated model without a token, links its repository and the token setting, and does not download', async () => {
    verdicts({})
    const user = userEvent.setup()
    const gated = gguf()
    gated.gguf = { ...gated.gguf!, gated: true }

    render(<GeniexDownloadOptions model={model(gated)} chip="x-elite" />)

    expect(screen.getByText('hub:geniex.gatedNoToken')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /google\/gemma-4-E4B-it-qat-q4_0-gguf/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf'
    )
    await user.click(screen.getByRole('button', { name: 'hub:geniex.setToken' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/general' })
    await waitFor(() => expect(option('hub:geniex.device.npu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByRole('button', { name: 'hub:download' })).toBeDisabled()
  })

  it('downloads a gated model with the person’s token once it is set', async () => {
    verdicts({})
    useGeneralSetting.setState({ huggingfaceToken: 'hf_x' })
    const user = userEvent.setup()
    const gated = gguf()
    gated.gguf = { ...gated.gguf!, gated: true }

    render(<GeniexDownloadOptions model={model(gated)} chip="x-elite" />)

    await waitFor(() => expect(option('hub:geniex.device.npu')).toHaveAttribute('aria-checked', 'true'))
    await user.click(screen.getByRole('button', { name: 'hub:download' }))
    await waitFor(() =>
      expect(installer.installGeniexModel).toHaveBeenCalledWith(expect.objectContaining({ device: 'npu', hfToken: 'hf_x' }))
    )
  })

  it('marks a Hugging Face model as not verified by Atomic Chat', () => {
    verdicts({})

    render(<GeniexDownloadOptions model={model(gguf({ origin: 'huggingface' }))} chip="x-elite" />)

    expect(screen.getByText('hub:geniex.notVerified')).toBeInTheDocument()
  })

  it('offers New chat on geniex and delete for a model on disk, with no download', async () => {
    verdicts({})
    useModelProvider.setState({
      providers: [{ provider: 'geniex', active: true, settings: [], models: [{ id: 'gemma-4-e4b' }] }] as never,
    })
    const user = userEvent.setup()

    render(<GeniexDownloadOptions model={model(gguf())} chip="x-elite" />)

    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'hub:newChat' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { threadModel: { id: 'gemma-4-e4b', provider: 'geniex' } } })
    )
    expect(useModelProvider.getState().selectedProvider).toBe('geniex')
  })
})

describe('GeniexDownloadOptions — an AI Hub bundle', () => {
  it('shows only the bundle for this chip with its precision, context and verdict, and downloads it', async () => {
    // spec geniex-models "Бандлы под два чипа"; spec geniex-desktop "Бандл Qwen3 4B".
    verdicts({})
    const user = userEvent.setup()

    render(<GeniexDownloadOptions model={model(bundle())} chip="x-elite" />)

    expect(await screen.findByText('hub:geniex.bundle.chip {"chip":"hub:geniex.chipLabel.x-elite"}')).toBeInTheDocument()
    expect(screen.queryByText(/x2-elite/)).not.toBeInTheDocument()
    expect(screen.getByText('hub:geniex.bundle.precision {"precision":"w4a16"}')).toBeInTheDocument()
    expect(screen.getByText('hub:geniex.bundle.context {"context":4096}')).toBeInTheDocument()
    expect(core.checkGeniexModel).toHaveBeenCalledWith({ plugin: 'qairt', device: 'npu', chip: 'x-elite', min_runtime_version: '0.9.3' })
    await waitFor(() => expect(screen.getByText('hub:geniex.runsHere')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'hub:download' }))
    await waitFor(() =>
      expect(installer.installGeniexModel).toHaveBeenCalledWith(expect.objectContaining({ variant: variants[0] }))
    )
  })

  it('says when no bundle fits this computer’s chip', () => {
    render(<GeniexDownloadOptions model={model(bundle({ variants: [variants[1]] }))} chip="x-elite" />)

    expect(screen.getByText('hub:geniex.noBundleHere')).toBeInTheDocument()
    expect(core.checkGeniexModel).not.toHaveBeenCalled()
  })

  it('leads to installing the SDK when it is not installed', async () => {
    verdicts({ npu: 'engine-not-installed' })
    const user = userEvent.setup()

    render(<GeniexDownloadOptions model={model(bundle())} chip="x-elite" />)

    await user.click(await screen.findByRole('button', { name: 'hub:geniex.installEngine' }))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { providerName: 'geniex' } }))
    expect(screen.getByText('npu: engine-not-installed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    expect(installer.installGeniexModel).not.toHaveBeenCalled()
  })

  it('offers New chat and delete for a bundle on disk', () => {
    verdicts({})
    useModelProvider.setState({
      providers: [{ provider: 'geniex', active: true, settings: [], models: [{ id: 'qwen3-4b-aihub-x-elite' }] }] as never,
    })

    render(<GeniexDownloadOptions model={model(bundle())} chip="x-elite" />)

    expect(screen.getByRole('button', { name: 'hub:newChat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
  })
})

describe('GeniexDownloadOptions — a model in Downloaded', () => {
  it('shows it by its name, with New chat and delete only', () => {
    render(
      <GeniexDownloadOptions
        model={{
          model_name: 'geniex/gemma-4-e4b',
          description: '',
          downloads: 0,
          is_geniex: true,
          geniex: { origin: 'installed', model_id: 'gemma-4-e4b', name: 'Gemma 4 E4B', summary: '', license: null },
        }}
        chip="x-elite"
      />
    )

    expect(screen.getByText('Gemma 4 E4B')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'hub:newChat' })).toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toEqual([])
    expect(core.checkGeniexModel).not.toHaveBeenCalled()
  })
})
