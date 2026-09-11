import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeStatus,
  MODELS_ROOT,
  Q4_ID,
  Q8_ID,
  Z_IMAGE,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/diffusion/arbiter', () => ({
  acquireGpuForDiffusion: vi.fn(async () => ({ evicted: [] })),
}))
vi.mock('@/lib/diffusion/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/config')>()),
  configureDiffusion: vi.fn(),
  getDiffusionPaths: vi.fn(),
}))
const transfer = vi.hoisted(() => ({ download: vi.fn(async () => undefined) }))
vi.mock('@/lib/diffusion/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/models')>()),
  downloadArtifact: transfer.download,
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

import { useImageSetting } from '@/hooks/useImageSetting'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageModelSelector } from '../ImageModelSelector'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('ImageModelSelector', () => {
  let fake: FakeDiffusion
  const catalog = makeCatalog()
  const q4Files = makeFilesFor(Z_IMAGE, 'q4_k_m')

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useImageSetting.persist.rehydrate()
    useImageSetting.setState({ selectedArtifactId: null })
    fake = makeFakeDiffusion()
    fake.listModelFiles.mockResolvedValue(q4Files)
    seedServiceHub({ diffusion: fake })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      catalog,
      modelFiles: q4Files,
      installedArtifacts: listInstalledArtifacts(catalog, q4Files),
      status: makeStatus(),
      paths: {
        dataFolder: '/data',
        modelsRoot: MODELS_ROOT,
        backendsRoot: '/data/diffusion/backends',
        imagesDir: '/data/images',
      },
    })
  })

  it('splits the family into what is on disk and what is not', () => {
    render(<ImageModelSelector />)
    const installed = screen.getByRole('heading', { name: 'images:model.installed' }).closest('section')!
    const available = screen.getByRole('heading', { name: 'images:model.available' }).closest('section')!
    expect(within(installed).getByText('Q4_K_M')).toBeInTheDocument()
    expect(within(installed).queryByText('Q8_0')).not.toBeInTheDocument()
    expect(within(available).getByText('Q8_0')).toBeInTheDocument()
    // The size shown is the whole artifact, side files included.
    expect(within(installed).getByText(/images:model.sizeGb/)).toBeInTheDocument()
  })

  it('loads an installed quant and then offers Unload instead', async () => {
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)
    await act(async () => {
      await userEvent.click(within(row).getByRole('button', { name: 'images:model.load' }))
    })
    expect(fake.loadModel.mock.calls[0][0].modelId).toBe(Q4_ID)
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`artifact-${Q4_ID}`)).getByRole('button', {
          name: 'images:model.unload',
        })
      ).toBeInTheDocument()
    )
    expect(useImageSetting.getState().selectedArtifactId).toBe(Q4_ID)
  })

  it('shows the download plan before fetching a quant that is not on disk', async () => {
    render(<ImageModelSelector />)
    await act(async () => {
      await userEvent.click(
        within(screen.getByTestId(`artifact-${Q8_ID}`)).getByRole('button', {
          name: 'images:model.pick',
        })
      )
    })

    // Only the transformer is missing: the VAE and the encoder are shared with
    // the installed Q4 and already on disk.
    const entries = await screen.findByTestId('plan-entries')
    const rows = within(entries).getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-present'))).toEqual([
      'false',
      'true',
      'true',
    ])
    expect(screen.getByTestId('plan-total')).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByTestId('plan-download'))
    })
    expect(transfer.download.mock.calls[0][1]).toBe('q8_0')
    expect(useImageSetting.getState().selectedArtifactId).toBe(Q8_ID)
  })

  it('removes an installed quant after confirmation', async () => {
    fake.listModelFiles.mockResolvedValue([])
    render(<ImageModelSelector variant="page" />)
    await act(async () => {
      await userEvent.click(
        within(screen.getByTestId(`artifact-${Q4_ID}`)).getByRole('button', {
          name: 'images:model.remove',
        })
      )
    })
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'images:model.remove' }))
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'images:model.installed' })
      ).not.toBeInTheDocument()
    )
    expect(fake.deleteModelFile).toHaveBeenCalled()
  })

  it('tells the user when the catalog has not arrived', () => {
    useImageGenerationStore.setState({ catalog: null })
    render(<ImageModelSelector />)
    expect(screen.getByTestId('image-models-loading')).toBeInTheDocument()
  })
})
