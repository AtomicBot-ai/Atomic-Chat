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
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
  },
}))
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
  useHardwareTier: () => ({
    tier: 'vram_8',
    profile: hardware.profile,
    ready: true,
  }),
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
    global.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
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
    const klein = {
      ...Z_IMAGE,
      id: 'flux.2-klein' as const,
      name: 'FLUX.2 Klein 4B',
    }
    useImageGenerationStore.setState({ catalog: makeCatalog([Z_IMAGE, klein]) })
    render(<ImageModelSelector workflow="edit" />)

    // One family is one row: an installed quant wins over alternate downloads.
    const installed = screen
      .getByRole('heading', { name: 'images:model.installed' })
      .closest('section')!
    const available = screen
      .getByRole('heading', { name: 'images:model.available' })
      .closest('section')!
    for (const zImage of screen.getAllByTestId('family-z-image')) {
      expect(zImage).toHaveAttribute('data-unsupported', 'edit')
      expect(
        within(zImage).getByText('images:model.notForWorkflow')
      ).toBeInTheDocument()
      expect(
        within(zImage).getAllByRole('button', { name: 'images:model.pick' })[0]
      ).toBeDisabled()
    }
    // The installed quant cannot run this workflow.
    expect(
      within(installed).getByRole('button', { name: 'images:model.load' })
    ).toBeDisabled()
    expect(
      within(available).queryByTestId('family-z-image')
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
    expect(
      screen.getByRole('button', { name: 'images:model.load' })
    ).toBeEnabled()
  })

  it('shows one configuration per family, preferring what is on disk', () => {
    render(<ImageModelSelector />)
    const installed = screen
      .getByRole('heading', { name: 'images:model.installed' })
      .closest('section')!
    expect(within(installed).getByText('Q4_K_M')).toBeInTheDocument()
    expect(within(installed).queryByText('Q8_0')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'images:model.available' })
    ).not.toBeInTheDocument()
    // The size shown is the whole artifact, side files included.
    expect(
      within(installed).getByText(/images:model.sizeGb/)
    ).toBeInTheDocument()
  })

  it('opens on the best quant and preserves a picked alternative in one dropdown', async () => {
    // 16 GiB: Q4 needs ~7.8 GiB with its encoder and activations (ok), Q8 ~11.6 (maybe).
    hardware.profile = gpuWith(16 * 1024)
    const view = render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)
    expect(within(row).getByText('Q4_K_M')).toBeInTheDocument()
    expect(
      screen.queryByText('images:model.recommended')
    ).not.toBeInTheDocument()

    await userEvent.click(
      within(row).getByRole('button', { name: 'images:model.pick' })
    )
    expect(screen.getByTestId(`quant-${Q4_ID}`)).toBeInTheDocument()
    expect(screen.getByTestId(`quant-${Q8_ID}`)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId(`quant-${Q8_ID}`))
    expect(screen.getByTestId('family-z-image')).toHaveAttribute(
      'data-artifact-id',
      Q8_ID
    )
    view.rerender(<ImageModelSelector />)
    expect(screen.getByTestId(`artifact-${Q8_ID}`)).toBeInTheDocument()
  })

  it('uses compact page rows with primary actions and icon-only removal', () => {
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)

    expect(row).toHaveAttribute('data-compact-row', 'true')
    expect(
      within(row).getByRole('button', { name: 'images:model.load' })
    ).toHaveAttribute('data-variant', 'default')
    const remove = within(row).getByRole('button', {
      name: 'images:model.remove',
    })
    expect(remove).toHaveAttribute('data-size', 'icon-xs')
    expect(remove).not.toHaveTextContent('images:model.remove')
  })

  it('keeps available rows equally compact with a primary Download action', () => {
    useImageGenerationStore.setState({ modelFiles: [], installedArtifacts: [] })
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)

    expect(row).toHaveAttribute('data-compact-row', 'true')
    expect(
      within(row).getByRole('button', { name: 'images:model.download' })
    ).toHaveAttribute('data-variant', 'default')
  })

  it('does not add recommendation badges when no quant fits this machine', () => {
    // 6 GiB: even Q4 is past the offload threshold.
    hardware.profile = gpuWith(6 * 1024)
    render(<ImageModelSelector />)
    expect(
      screen.queryByText('images:model.recommended')
    ).not.toBeInTheDocument()
  })

  it('loads an installed quant and then offers Unload instead', async () => {
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)
    await act(async () => {
      await userEvent.click(
        within(row).getByRole('button', { name: 'images:model.load' })
      )
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

  it('downloads every required file immediately after one click', async () => {
    useImageGenerationStore.setState({
      modelFiles: [],
      installedArtifacts: [],
    })
    render(<ImageModelSelector />)
    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'images:model.download' })
      )
    })

    expect(screen.queryByTestId('plan-entries')).not.toBeInTheDocument()
    await waitFor(() => expect(transfer.download).toHaveBeenCalledTimes(1))
    expect(transfer.download.mock.calls[0][1]).toBe('q4_k_m')
    expect(useImageSetting.getState().selectedArtifactId).toBe(Q4_ID)
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
      await userEvent.click(
        screen.getByRole('button', { name: 'images:model.remove' })
      )
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
        .updateProgress(diffusionDownloadTaskId(Q4_ID), 0.18, Q4_ID, 1, 10)
    })
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)

    const pick = within(row).getByRole('button', { name: 'images:model.pick' })
    expect(within(row).getByText('images:model.progress')).toBeInTheDocument()
    expect(within(pick).queryByText('images:model.progress')).not.toBeInTheDocument()
    expect(within(row).queryByText('images:model.sizeGb')).not.toBeInTheDocument()
    // Progress is the cancel button alone, with no second line stacked under it.
    const cancel = within(row).getByRole('button', {
      name: 'common:cancelDownload',
    })
    expect(cancel).toHaveTextContent('18%')
    expect(within(row).getAllByText('images:model.progress')).toHaveLength(1)
  })

  it('tells the user when the catalog has not arrived', () => {
    useImageGenerationStore.setState({ catalog: null })
    render(<ImageModelSelector />)
    expect(screen.getByTestId('image-models-loading')).toBeInTheDocument()
  })
})
