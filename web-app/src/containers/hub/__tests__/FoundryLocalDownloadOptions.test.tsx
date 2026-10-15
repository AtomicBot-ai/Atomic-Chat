import { render, screen, waitFor, within } from '@testing-library/react'
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

const core = vi.hoisted(() => ({ checkFoundryLocalVariant: vi.fn() }))
vi.mock('@/services/foundry-local/core', () => core)

const installer = vi.hoisted(() => ({ installFoundryLocalVariant: vi.fn(async () => ({ modelId: 'x' })) }))
vi.mock('@/services/foundry-local/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/foundry-local/install')>()),
  ...installer,
}))

const curatedList = vi.hoisted(() => ({
  fetchFoundryLocalList: vi.fn(async () => ({
    list: { schema_version: 1, updated_at: '', resolver: { url_template: 'https://{region}/{asset_id}', regions: ['eastus'] }, catalog: { url: 'https://c' }, models: [] },
    source: 'cache',
    fetchedAt: 1,
  })),
}))
vi.mock('@/services/foundry-local/curated', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/foundry-local/curated')>()),
  ...curatedList,
}))

import { FoundryLocalDownloadOptions } from '../FoundryLocalDownloadOptions'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { seedServiceHub } from '@/test/service-hub'
import type { ProvidersService } from '@/services/providers/types'
import type { CatalogModel } from '@/services/models/types'
import type { FoundryLocalCheckResult, FoundryLocalHubVariant } from '@/services/foundry-local/types'

const v = (
  id: string,
  execution_provider: FoundryLocalHubVariant['execution_provider'],
  device: FoundryLocalHubVariant['device'],
  platforms: string[]
): FoundryLocalHubVariant => ({
  id,
  execution_provider,
  device,
  platforms,
  asset_id: `azureml://registries/azureml/models/${id}/versions/1`,
  version: '1',
  size_bytes: 4 * 1024 ** 3,
})

const WIN = ['win-x64']
const MAC_AND_WIN = ['win-x64', 'win-arm64', 'macos-arm64']
const ALL = ['win-x64', 'win-arm64', 'macos-arm64', 'linux-x64', 'linux-arm64']

const qwenVariants = [
  v('qwen2.5-7b-instruct-cuda-gpu', 'cuda', 'gpu', ['win-x64', 'linux-x64']),
  v('qwen2.5-7b-instruct-generic-gpu', 'webgpu', 'gpu', MAC_AND_WIN),
  v('qwen2.5-7b-instruct-generic-cpu', 'cpu', 'cpu', ALL),
  v('qwen2.5-7b-instruct-openvino-npu', 'openvino', 'npu', WIN),
  v('qwen2.5-7b-instruct-qnn-npu', 'qnn', 'npu', ['win-arm64']),
]

const model = (origin: 'curated' | 'microsoft' = 'curated'): CatalogModel => ({
  model_name: 'foundry-local/qwen2.5-7b-instruct',
  description: '',
  downloads: 0,
  is_foundry_local: true,
  foundry_local: {
    origin,
    model_id: 'qwen2.5-7b-instruct',
    name: 'Qwen2.5 7B Instruct',
    summary: '',
    license: 'apache-2.0',
    variants: qwenVariants,
  },
})

const ok: FoundryLocalCheckResult = { verdict: 'ok', reason: null, accelerator: null }

function verdicts(map: Record<string, FoundryLocalCheckResult['verdict']>) {
  core.checkFoundryLocalVariant.mockImplementation(async ({ execution_provider }: { execution_provider: string }) => {
    const verdict = map[execution_provider] ?? 'ok'
    return verdict === 'ok' ? ok : { verdict, reason: `${execution_provider}: ${verdict}`, accelerator: 'X' }
  })
}

const option = (id: string) => screen.getByRole('radio', { name: new RegExp(id) })

beforeEach(() => {
  vi.clearAllMocks()
  useModelProvider.setState({ providers: [] })
  useDownloadStore.setState({ downloads: {}, localDownloadingModels: new Set() })
  seedServiceHub({ providers: { getProviders: vi.fn(async () => []) } as unknown as ProvidersService })
})

describe('FoundryLocalDownloadOptions', () => {
  it('on Windows x64 with a prepared NPU picks the OpenVINO NPU variant and hides the arm64 one', async () => {
    verdicts({})

    render(<FoundryLocalDownloadOptions model={model()} platform="win-x64" />)

    await waitFor(() => expect(option('openvino-npu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByRole('radio', { name: /qnn-npu/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'hub:download' })).toBeEnabled()
  })

  it('on macOS picks the WebGPU variant and shows neither NPU nor CUDA variants', async () => {
    verdicts({})

    render(<FoundryLocalDownloadOptions model={model()} platform="macos-arm64" />)

    await waitFor(() => expect(option('generic-gpu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('generic-gpu'),
      expect.stringContaining('generic-cpu'),
    ])
  })

  it('passes over a variant whose accelerator is missing here, and lets the person pick another', async () => {
    verdicts({ openvino: 'accelerator-unavailable' })
    const user = userEvent.setup()

    render(<FoundryLocalDownloadOptions model={model()} platform="win-x64" />)

    await waitFor(() => expect(option('cuda-gpu')).toHaveAttribute('aria-checked', 'true'))
    await user.click(option('generic-cpu'))
    expect(option('generic-cpu')).toHaveAttribute('aria-checked', 'true')
  })

  it('leads to the provider page instead of downloading when the engine is not installed', async () => {
    verdicts({ cpu: 'engine-not-installed', cuda: 'engine-not-installed', webgpu: 'engine-not-installed', openvino: 'engine-not-installed' })
    const user = userEvent.setup()

    render(<FoundryLocalDownloadOptions model={model()} platform="win-x64" />)

    const install = await screen.findByRole('button', { name: 'hub:foundryLocal.installEngine' })
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    await user.click(install)
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { providerName: 'foundry-local' } })
    )
  })

  it('leads to the provider page to prepare the accelerator of the chosen variant', async () => {
    verdicts({ openvino: 'accelerator-not-prepared' })

    render(<FoundryLocalDownloadOptions model={model()} platform="win-x64" />)

    // Not prepared still counts for the default: the NPU variant is the one to prepare for.
    await waitFor(() => expect(option('openvino-npu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByRole('button', { name: 'hub:foundryLocal.prepareAccelerator' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
  })

  it('marks a model from Microsoft’s catalog as not verified by Atomic Chat', async () => {
    verdicts({})

    render(<FoundryLocalDownloadOptions model={model('microsoft')} platform="win-x64" />)

    expect(screen.getByText('hub:foundryLocal.notVerified')).toBeInTheDocument()
  })

  it('downloads the chosen variant through the installer and names the panel’s row', async () => {
    verdicts({})
    const user = userEvent.setup()

    render(<FoundryLocalDownloadOptions model={model()} platform="win-x64" />)
    await waitFor(() => expect(option('openvino-npu')).toHaveAttribute('aria-checked', 'true'))
    await user.click(screen.getByRole('button', { name: 'hub:download' }))

    await waitFor(() => expect(installer.installFoundryLocalVariant).toHaveBeenCalled())
    const [request] = installer.installFoundryLocalVariant.mock.calls[0] as unknown as [
      { variant: { id: string }; model: { model_id: string } },
    ]
    expect(request.variant.id).toBe('qwen2.5-7b-instruct-openvino-npu')
    expect(request.model.model_id).toBe('qwen2.5-7b-instruct')
    expect(useDownloadStore.getState().downloadOriginByModelId['foundry-local-qwen2_5-7b-instruct-openvino-npu']).toBe(
      'Qwen2.5 7B Instruct (OpenVINO NPU)'
    )
  })

  it('offers no download for a variant already on disk', async () => {
    verdicts({})
    useModelProvider.setState({
      providers: [
        {
          active: true,
          provider: 'foundry-local',
          settings: [],
          models: [{ id: 'qwen2.5-7b-instruct-generic-cpu' }],
        } as unknown as ModelProvider,
      ],
    })

    render(<FoundryLocalDownloadOptions model={model()} platform="win-x64" />)

    await waitFor(() => expect(option('generic-cpu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    expect(within(screen.getByTestId('foundry-local-actions')).getByRole('button', { name: /hub:newChat|common:newChat/ })).toBeInTheDocument()
  })
})
