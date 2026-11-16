import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { engineBuildCatalog } from '@/services/engine-builds/core'
import { checkStrataModel } from '@/services/strata/core'
import { installStrata, listStrataJobs } from '@/services/strata/install'
import { strataCatalogRows } from '@/services/strata/catalog'
import fixture from '@/services/strata/__tests__/fixtures/catalog.json'
import { useModelProvider } from '@/hooks/useModelProvider'
import { StrataDownloadOptions } from '../StrataDownloadOptions'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('@/utils/switchModel', () => ({ switchToModel: vi.fn() }))
vi.mock('@/containers/hub/DeleteModelAction', () => ({
  DeleteModelAction: () => null,
}))
vi.mock('@/services/engine-builds/core', () => ({
  engineBuildCatalog: vi.fn(),
}))
vi.mock('@/services/strata/core', () => ({
  checkStrataModel: vi.fn(),
  syncStrataSettings: vi.fn(),
}))
vi.mock('@/services/strata/install', () => ({
  cancelStrata: vi.fn(),
  installStrata: vi.fn(),
  listStrataJobs: vi.fn(),
  resumeStrata: vi.fn(),
  strataTaskId: (id: string) => `strata-model-${id}`,
}))
vi.mock('@/i18n/react-i18next-compat', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})

it('checks and downloads the selected Strata quant independently', async () => {
  const user = userEvent.setup()
  const alternative = { ...descriptor, name: 'Qwen3.8 Q2_0', variant_id: 'q2-0-dflash2' }
  vi.mocked(engineBuildCatalog).mockResolvedValue({} as never)
  vi.mocked(checkStrataModel).mockResolvedValue({ verdict: 'ok', warnings: [] } as never)
  vi.mocked(listStrataJobs).mockResolvedValue([])
  render(<StrataDownloadOptions descriptor={descriptor} variants={[descriptor, alternative]} />)

  await user.selectOptions(screen.getByRole('combobox', { name: 'hub:strata.quantization' }), alternative.variant_id)
  await vi.waitFor(() => expect(checkStrataModel).toHaveBeenLastCalledWith({ descriptor: alternative }))
  const button = screen.getByRole('button', { name: 'hub:strata.install' })
  await vi.waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
  expect(installStrata).toHaveBeenCalledWith(alternative, undefined, undefined)
})

const [row] = strataCatalogRows(fixture)
const descriptor = row.strata!
afterEach(() => {
  cleanup()
  useModelProvider.setState({ providers: [] })
  vi.resetAllMocks()
})

it('shows the refusal from core and disables acquisition for this model and backend', async () => {
  vi.mocked(engineBuildCatalog).mockResolvedValue({
    host_backend_id: 'macos-arm64-metal',
  } as never)
  vi.mocked(checkStrataModel).mockResolvedValue({
    verdict: 'platform-unsupported',
    reason: 'This variant requires CUDA or HIP.',
    warnings: [],
  } as never)
  vi.mocked(listStrataJobs).mockResolvedValue([])
  render(<StrataDownloadOptions descriptor={descriptor} />)
  expect(
    await screen.findByText('This variant requires CUDA or HIP.')
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'hub:strata.install' })
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'hub:strata.import' })
  ).toBeDisabled()
})

it('offers Resume when source acquisition finished but preparation was interrupted', async () => {
  vi.mocked(engineBuildCatalog).mockResolvedValue({
    active: { tag: 'local' },
  } as never)
  vi.mocked(checkStrataModel).mockResolvedValue({
    verdict: 'ok',
    reason: null,
    warnings: [],
  } as never)
  vi.mocked(listStrataJobs).mockResolvedValue([
    { model_id: descriptor.variant_id, state: 'files-ready' } as never,
  ])
  render(<StrataDownloadOptions descriptor={descriptor} />)
  expect(
    await screen.findByRole('button', { name: 'hub:strata.resume' })
  ).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'hub:strata.chat' })).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'hub:strata.install' })
  ).toBeNull()
})
