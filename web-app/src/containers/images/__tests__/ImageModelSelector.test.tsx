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
// Unknown hardware unless a test measures a machine: every quant is a "maybe".
const hardware = vi.hoisted(() => ({
  profile: null as import('@/lib/hardware-tier').HardwareProfile | null,
}))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({ tier: 'vram_8', profile: hardware.profile, ready: true }),
}))

const gpuWith = (budgetMib: number) => ({
  tier: 'vram_8' as const,
  memoryKind: 'vram' as const,
  budgetMib,
  systemRamMib: 32 * 1024,
  vramMib: budgetMib,
  hardCeiling: false,
})

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useImageSetting } from '@/hooks/useImageSetting'
import {
  diffusionDownloadTaskId,
  listInstalledArtifacts,
} from '@/lib/diffusion/models'
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
    hardware.profile = null
    localStorage.clear()
    await useImageSetting.persist.rehydrate()
    useImageSetting.setState({ selectedArtifactId: null })
    useDownloadStore.setState({ downloads: {} })
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

  it('marks the families that cannot run the picked workflow and lists them last', () => {
    const klein = { ...Z_IMAGE, id: 'flux.2-klein' as const, name: 'FLUX.2 Klein 4B' }
    useImageGenerationStore.setState({ catalog: makeCatalog([Z_IMAGE, klein]) })
    render(<ImageModelSelector workflow="edit" />)

    // Z-Image sits in both sections (Q4 on disk, Q8 not); both copies are marked.
    const installed = screen.getByRole('heading', { name: 'images:model.installed' }).closest('section')!
    const available = screen.getByRole('heading', { name: 'images:model.available' }).closest('section')!
    for (const zImage of screen.getAllByTestId('family-z-image')) {
      expect(zImage).toHaveAttribute('data-unsupported', 'edit')
      expect(within(zImage).getByText('images:model.notForWorkflow')).toBeInTheDocument()
      expect(within(zImage).getAllByRole('button', { name: 'images:model.pick' })[0]).toBeDisabled()
    }
    // Neither the installed quant's Run nor an available quant's Download.
    expect(within(installed).getByRole('button', { name: 'images:model.load' })).toBeDisabled()
    expect(
      within(within(available).getByTestId('family-z-image')).queryByRole('button', {
        name: /images:model.download/,
      })
    ).not.toBeInTheDocument()

    const kleinBlock = screen.getByTestId('family-flux.2-klein')
    expect(kleinBlock).not.toHaveAttribute('data-unsupported')
    const blocks = within(available).getAllByTestId(/^family-/)
    expect(blocks[0]).toHaveAttribute('data-testid', 'family-flux.2-klein')
  })

  it('offers every family for a workflow they all run', () => {
    render(<ImageModelSelector workflow="inpaint" />)
    for (const zImage of screen.getAllByTestId('family-z-image')) {
      expect(zImage).not.toHaveAttribute('data-unsupported')
    }
    expect(screen.getByRole('button', { name: 'images:model.load' })).toBeEnabled()
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

  it("badges the catalog's pick when this machine can run it", () => {
    // 16 GiB: Q4 needs ~7.8 GiB with its encoder and activations (ok), Q8 ~11.6 (maybe).
    hardware.profile = gpuWith(16 * 1024)
    render(<ImageModelSelector />)
    expect(
      within(screen.getByTestId(`artifact-${Q4_ID}`)).getByText('images:model.recommended')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId(`artifact-${Q8_ID}`)).queryByText('images:model.recommended')
    ).not.toBeInTheDocument()
  })

  it('recommends nothing when no quant fits this machine', () => {
    // 6 GiB: even Q4 is past the offload threshold.
    hardware.profile = gpuWith(6 * 1024)
    render(<ImageModelSelector />)
    expect(screen.queryByText('images:model.recommended')).not.toBeInTheDocument()
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

  it('turns the size line into a byte count while downloading, keeping the row one button tall', () => {
    act(() => {
      useDownloadStore
        .getState()
        .updateProgress(diffusionDownloadTaskId(Q8_ID), 0.18, Q8_ID, 1, 10)
    })
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q8_ID}`)

    const pick = within(row).getByRole('button', { name: 'images:model.pick' })
    expect(within(pick).getByText('images:model.progress')).toBeInTheDocument()
    expect(within(pick).queryByText('images:model.sizeGb')).not.toBeInTheDocument()
    // Progress is the cancel button alone, with no second line stacked under it.
    const cancel = within(row).getByRole('button', { name: 'common:cancelDownload' })
    expect(cancel).toHaveTextContent('18%')
    expect(within(row).getAllByText('images:model.progress')).toHaveLength(1)
  })

  it('tells the user when the catalog has not arrived', () => {
    useImageGenerationStore.setState({ catalog: null })
    render(<ImageModelSelector />)
    expect(screen.getByTestId('image-models-loading')).toBeInTheDocument()
  })
})
