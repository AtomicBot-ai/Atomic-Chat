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

const core = vi.hoisted(() => ({ checkLiteRtLmModel: vi.fn() }))
vi.mock('@/services/litert-lm/core', () => core)

const installer = vi.hoisted(() => ({ installLiteRtLmVariant: vi.fn(async () => ({ modelId: 'x' })) }))
vi.mock('@/services/litert-lm/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/litert-lm/install')>()),
  ...installer,
}))

import { LiteRtLmDownloadOptions } from '../LiteRtLmDownloadOptions'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import type { LiteRtLmCheckResult, LiteRtLmHubModel, LiteRtLmHubVariant } from '@/services/litert-lm/types'

const ALL = ['macos-arm64', 'linux-x64', 'linux-arm64', 'win-x64']
const file = { path: 'gemma-4-E2B-it.litertlm', size: 2_588_147_712, sha256: 'a'.repeat(64) }

const variants: LiteRtLmHubVariant[] = [
  { id: 'gemma-4-e2b-cpu', backend: 'cpu', platforms: ALL, file },
  { id: 'gemma-4-e2b-gpu', backend: 'gpu', platforms: ALL, file },
  { id: 'gemma-4-e2b-npu-lnl', backend: 'npu', npu: 'intel-lnl', platforms: ['win-x64'], file },
]

const fields = (extra: Partial<LiteRtLmHubModel> = {}): LiteRtLmHubModel => ({
  origin: 'curated',
  model_id: 'gemma-4-e2b',
  name: 'Gemma 4 E2B',
  summary: '',
  license: 'apache-2.0',
  repo: 'litert-community/gemma-4-E2B-it-litert-lm',
  revision: 'b'.repeat(40),
  gated: false,
  context_length: 32003,
  tools: true,
  reasoning: true,
  vision: true,
  variants,
  ...extra,
})

const model = (extra: Partial<LiteRtLmHubModel> = {}): CatalogModel => ({
  model_name: 'litert-lm/gemma-4-e2b',
  description: '',
  downloads: 0,
  is_litert_lm: true,
  litert_lm: fields(extra),
})

function verdicts(map: Partial<Record<string, LiteRtLmCheckResult['verdict']>>) {
  core.checkLiteRtLmModel.mockImplementation(async ({ backend }: { backend: string }) => {
    const verdict = map[backend] ?? 'ok'
    return verdict === 'ok' ? { verdict, reason: null } : { verdict, reason: `${backend}: ${verdict}` }
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

describe('LiteRtLmDownloadOptions', () => {
  it('on macOS picks the GPU variant and does not show the NPU one', async () => {
    // spec litert-lm-models "Mac".
    verdicts({})

    render(<LiteRtLmDownloadOptions model={model()} platform="macos-arm64" />)

    await waitFor(() => expect(option('gemma-4-e2b-gpu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByRole('radio', { name: /npu/ })).not.toBeInTheDocument()
    expect(core.checkLiteRtLmModel).toHaveBeenCalledWith({ backend: 'gpu' })
    expect(screen.getByRole('button', { name: 'hub:download' })).toBeEnabled()
  })

  it('on a Lunar Lake laptop picks the NPU variant and leads to preparing OpenVINO', async () => {
    // spec litert-lm-models "Ноутбук на Lunar Lake".
    verdicts({ npu: 'accelerator-not-prepared' })
    const user = userEvent.setup()

    render(<LiteRtLmDownloadOptions model={model()} platform="win-x64" />)

    await waitFor(() => expect(option('gemma-4-e2b-npu-lnl')).toHaveAttribute('aria-checked', 'true'))
    expect(core.checkLiteRtLmModel).toHaveBeenCalledWith({ backend: 'npu', npu: 'intel-lnl' })
    expect(screen.getByText('npu: accelerator-not-prepared')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'hub:liteRtLm.prepareAccelerator' }))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { providerName: 'litert-lm' } }))
    expect(installer.installLiteRtLmVariant).not.toHaveBeenCalled()
  })

  it('passes over a variant that cannot run here, and lets the person pick another', async () => {
    verdicts({ npu: 'accelerator-unavailable' })
    const user = userEvent.setup()

    render(<LiteRtLmDownloadOptions model={model()} platform="win-x64" />)

    await waitFor(() => expect(option('gemma-4-e2b-gpu')).toHaveAttribute('aria-checked', 'true'))
    await user.click(option('gemma-4-e2b-cpu'))
    expect(option('gemma-4-e2b-cpu')).toHaveAttribute('aria-checked', 'true')
  })

  it('leads to installing the engine instead of downloading when it is not installed', async () => {
    // spec litert-lm-desktop "Движок не установлен".
    verdicts({ cpu: 'engine-not-installed', gpu: 'engine-not-installed' })
    const user = userEvent.setup()

    render(<LiteRtLmDownloadOptions model={model()} platform="linux-x64" />)

    await user.click(await screen.findByRole('button', { name: 'hub:liteRtLm.installEngine' }))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { providerName: 'litert-lm' } }))
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
  })

  it('explains a gated model without a token, links its repository and the token setting, and does not download', async () => {
    // spec litert-lm-desktop "Закрытая модель".
    verdicts({})
    const user = userEvent.setup()

    render(<LiteRtLmDownloadOptions model={model({ gated: true })} platform="macos-arm64" />)

    expect(screen.getByText('hub:liteRtLm.gatedNoToken')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /litert-community\/gemma-4-E2B-it-litert-lm/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm'
    )
    await user.click(screen.getByRole('button', { name: 'hub:liteRtLm.setToken' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/general' })
    await waitFor(() => expect(option('gemma-4-e2b-gpu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByRole('button', { name: 'hub:download' })).toBeDisabled()
  })

  it('downloads a gated model with the person’s token once it is set', async () => {
    verdicts({})
    useGeneralSetting.setState({ huggingfaceToken: 'hf_x' })
    const user = userEvent.setup()

    render(<LiteRtLmDownloadOptions model={model({ gated: true })} platform="macos-arm64" />)

    expect(screen.queryByText('hub:liteRtLm.gatedNoToken')).not.toBeInTheDocument()
    await waitFor(() => expect(option('gemma-4-e2b-gpu')).toHaveAttribute('aria-checked', 'true'))
    await user.click(screen.getByRole('button', { name: 'hub:download' }))
    await waitFor(() =>
      expect(installer.installLiteRtLmVariant).toHaveBeenCalledWith(
        expect.objectContaining({ variant: variants[1], hfToken: 'hf_x' })
      )
    )
    expect(useDownloadStore.getState().downloadOriginByModelId['litert-lm-gemma-4-e2b-gpu']).toBe('Gemma 4 E2B (GPU)')
  })

  it('marks a Hugging Face model as not verified by Atomic Chat', () => {
    verdicts({})

    render(<LiteRtLmDownloadOptions model={model({ origin: 'huggingface' })} platform="macos-arm64" />)

    expect(screen.getByText('hub:liteRtLm.notVerified')).toBeInTheDocument()
  })

  it('says when no variant runs on this platform', () => {
    render(
      <LiteRtLmDownloadOptions model={model({ variants: [variants[2]] })} platform="macos-arm64" />
    )

    expect(screen.getByText('hub:liteRtLm.noVariantHere')).toBeInTheDocument()
  })

  it('offers New chat on litert-lm and delete for a variant on disk, with no download', async () => {
    verdicts({})
    useModelProvider.setState({
      providers: [
        { provider: 'litert-lm', active: true, settings: [], models: [{ id: 'gemma-4-e2b-gpu' }] },
      ] as never,
    })
    const user = userEvent.setup()

    render(<LiteRtLmDownloadOptions model={model()} platform="macos-arm64" />)

    await waitFor(() => expect(option('gemma-4-e2b-gpu')).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByRole('button', { name: 'hub:download' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'hub:newChat' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { threadModel: { id: 'gemma-4-e2b-gpu', provider: 'litert-lm' } } })
    )
    expect(useModelProvider.getState().selectedProvider).toBe('litert-lm')
  })

  it('shows a variant listed in Downloaded by its name, with New chat and delete only', () => {
    render(
      <LiteRtLmDownloadOptions
        model={{
          model_name: 'litert-lm/gemma-4-e4b-gpu',
          description: '',
          downloads: 0,
          is_litert_lm: true,
          litert_lm: {
            origin: 'installed',
            model_id: 'gemma-4-e4b-gpu',
            name: 'Gemma 4 E4B (GPU)',
            summary: '',
            license: null,
            repo: '',
            revision: '',
            gated: false,
            variants: [],
          },
        }}
        platform="macos-arm64"
      />
    )

    expect(screen.getByText('Gemma 4 E4B (GPU)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'hub:newChat' })).toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toEqual([])
    expect(core.checkLiteRtLmModel).not.toHaveBeenCalled()
  })
})
