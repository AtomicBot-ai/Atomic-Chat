import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HuggingFaceAction,
  HuggingFacePicks,
  ModelPickerEmptyState,
  resetModelPickerDownloadsForTest,
} from '../ModelPickerDownloads'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import type { CatalogModel, ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

const searchHuggingFaceCandidates = vi.fn()

const candidate = (repo: string, isMlx = false): CatalogModel =>
  ({
    model_name: repo,
    developer: repo.split('/')[0],
    description: '',
    downloads: 1,
    is_mlx: isMlx,
  }) as CatalogModel

describe('ModelPickerDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_MACOS', true)
    resetModelPickerDownloadsForTest()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      resumeParams: {},
    })
    searchHuggingFaceCandidates.mockResolvedValue([])
    seedServiceHub({
      models: { searchHuggingFaceCandidates } as unknown as ModelsService,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders concise empty and installed-search no-results copy', () => {
    const view = render(<ModelPickerEmptyState query="" />)
    expect(screen.getByTestId('model-picker-empty')).toHaveTextContent(
      'No installed models yet.'
    )

    view.rerender(<ModelPickerEmptyState query="mistral" />)
    expect(screen.getByTestId('model-picker-empty')).toHaveTextContent(
      'common:noModelsFoundFor:{"searchValue":"mistral"}'
    )
  })

  it('renders one compact branded Hugging Face action', () => {
    const onClick = vi.fn()
    render(<HuggingFaceAction onClick={onClick} />)

    const action = screen.getByRole('button', {
      name: 'Download models from Hugging Face',
    })
    expect(action).toHaveClass('h-9')
    expect(
      within(action).getByRole('img', { name: 'Hugging Face' })
    ).toHaveAttribute('src', '/images/model-provider/huggingface.svg')
    fireEvent.click(action)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not search Hugging Face until an eligible explicit-mode query exists', async () => {
    const view = render(<HuggingFacePicks query="" localEmpty />)
    expect(searchHuggingFaceCandidates).not.toHaveBeenCalled()

    view.rerender(<HuggingFacePicks query="qw" localEmpty />)
    expect(searchHuggingFaceCandidates).not.toHaveBeenCalled()

    view.rerender(<HuggingFacePicks query="qwen" localEmpty />)
    await waitFor(() => expect(searchHuggingFaceCandidates).toHaveBeenCalled())
  })

  it('shows compatible GGUF and MLX results in explicit Hugging Face mode', async () => {
    const repo = 'community/Qwen3-8B'
    searchHuggingFaceCandidates.mockImplementation(
      (_query: string, _token: string, _limit: number, format: string) =>
        Promise.resolve([candidate(repo, format === 'mlx')])
    )

    render(<HuggingFacePicks query="qwen" localEmpty />)

    const rows = await screen.findAllByTestId('model-picker-download-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('GGUF')).toBeVisible()
    expect(within(rows[1]).getByText('MLX')).toBeVisible()
  })
})
