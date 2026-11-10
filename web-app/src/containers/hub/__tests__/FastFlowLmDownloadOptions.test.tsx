import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { atomicModelCatalogBaseline } from '@janhq/core'
import { fastFlowLmModels } from '@/services/fastflowlm/catalog'
import { checkFastFlowLmModel } from '@/services/fastflowlm/core'
import { FastFlowLmDownloadOptions } from '../FastFlowLmDownloadOptions'
import {
  fastFlowLmInstallJobs,
  installFastFlowLm,
} from '@/services/fastflowlm/install'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'

vi.mock('@/services/fastflowlm/core', () => ({ checkFastFlowLmModel: vi.fn() }))
vi.mock('@/services/fastflowlm/install', () => ({
  installFastFlowLm: vi.fn(),
  fastFlowLmInstallJobs: vi.fn(async () => []),
  fastFlowLmDownloadId: (id: string) => `fastflowlm-${id}`,
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/containers/hub/DeleteModelAction', () => ({
  DeleteModelAction: () => null,
}))
vi.mock('@/utils/switchModel', () => ({ switchToModel: vi.fn() }))
const model = {
  model_name: 'fastflowlm/qwen3',
  fastflowlm: fastFlowLmModels(atomicModelCatalogBaseline())[0]!,
  downloads: 0,
}
beforeEach(() => {
  vi.clearAllMocks()
  useModelProvider.setState({ providers: [] })
  vi.mocked(fastFlowLmInstallJobs).mockResolvedValue([])
})
it('offers setup for an available model whose engine is missing', async () => {
  vi.mocked(checkFastFlowLmModel).mockResolvedValue({
    verdict: 'engine-not-installed',
    reason: 'Install a verified build.',
  } as never)
  render(<FastFlowLmDownloadOptions model={model} />)
  expect(
    await screen.findByRole('button', { name: 'hub:fastflowlm.setup' })
  ).toBeVisible()
  expect(screen.getByText('Install a verified build.')).toBeVisible()
})
it('offers download only after core accepts the exact descriptor', async () => {
  vi.mocked(checkFastFlowLmModel).mockResolvedValue({
    verdict: 'ok',
    reason: null,
  } as never)
  render(<FastFlowLmDownloadOptions model={model} />)
  expect(
    await screen.findByRole('button', { name: 'hub:fastflowlm.install' })
  ).toBeEnabled()
  expect(checkFastFlowLmModel).toHaveBeenCalledWith({
    descriptor: model.fastflowlm,
  })
  expect(screen.getByText(model.fastflowlm.license)).toBeVisible()
})
it.each(['publishing', 'rollback-pending', 'rolled-back'])(
  'keeps Resume ahead of New chat while maintenance is unresolved (%s)',
  async (state) => {
    vi.mocked(checkFastFlowLmModel).mockResolvedValue({
      verdict: 'ok',
      reason: null,
    } as never)
    useModelProvider.setState({
      providers: [
        {
          provider: 'fastflowlm',
          models: [{ id: model.fastflowlm.variant_id }],
        },
      ] as ModelProvider[],
    })
    vi.mocked(fastFlowLmInstallJobs).mockResolvedValue([
      { model_id: model.fastflowlm.variant_id, state, plan: {} },
    ] as never)
    render(<FastFlowLmDownloadOptions model={model} />)
    expect(
      await screen.findByRole('button', { name: 'hub:fastflowlm.resume' })
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'common:newChat' })
    ).not.toBeInTheDocument()
  }
)

it('finishes accepted publication even when the current readiness probe is blocked', async () => {
  vi.mocked(checkFastFlowLmModel).mockResolvedValue({
    verdict: 'environment-not-ready',
    reason: 'Restart required',
  } as never)
  vi.mocked(fastFlowLmInstallJobs).mockResolvedValue([
    { model_id: model.fastflowlm.variant_id, state: 'accepted', plan: {} },
  ] as never)
  render(<FastFlowLmDownloadOptions model={model} />)
  expect(
    await screen.findByRole('button', { name: 'hub:fastflowlm.resume' })
  ).toBeEnabled()
})

it('shows Cancel instead of installed-model actions while an update is running', async () => {
  vi.mocked(checkFastFlowLmModel).mockResolvedValue({
    verdict: 'ok',
    reason: null,
  } as never)
  useModelProvider.setState({
    providers: [
      { provider: 'fastflowlm', models: [{ id: model.fastflowlm.variant_id }] },
    ] as ModelProvider[],
  })
  vi.mocked(installFastFlowLm).mockReturnValue(new Promise(() => {}))
  render(<FastFlowLmDownloadOptions model={model} />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'hub:fastflowlm.update' })
  )
  expect(
    await screen.findByRole('button', { name: /common:cancelDownload/ })
  ).toBeEnabled()
  expect(
    screen.queryByRole('button', { name: 'common:newChat' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'hub:fastflowlm.update' })
  ).not.toBeInTheDocument()
})

it('links the gated selected variant to its own terms even with a token already set', async () => {
  vi.mocked(checkFastFlowLmModel).mockResolvedValue({
    verdict: 'ok',
    reason: null,
  } as never)
  useGeneralSetting.setState({ huggingfaceToken: 'hf_test' })
  const selected = {
    ...model,
    fastflowlm: {
      ...model.fastflowlm,
      gated: true,
      sources: [
        {
          id: 'weights',
          repo: 'owner/selected-variant',
          revision: 'a'.repeat(40),
        },
      ],
    },
  }
  const view = render(<FastFlowLmDownloadOptions model={selected} />)
  expect(
    await screen.findByRole('link', { name: 'owner/selected-variant' })
  ).toHaveAttribute('href', 'https://huggingface.co/owner/selected-variant')
  expect(screen.getByText('hub:fastflowlm.gated')).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'hub:fastflowlm.setToken' })
  ).toBeVisible()
  view.rerender(
    <FastFlowLmDownloadOptions
      model={{
        ...selected,
        fastflowlm: {
          ...selected.fastflowlm,
          sources: [
            { ...selected.fastflowlm.sources[0], repo: 'owner/other-variant' },
          ],
        },
      }}
    />
  )
  expect(
    screen.queryByRole('link', { name: 'owner/selected-variant' })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'owner/other-variant' })
  ).toHaveAttribute('href', 'https://huggingface.co/owner/other-variant')
  view.unmount()
  useGeneralSetting.setState({ huggingfaceToken: '' })
})
