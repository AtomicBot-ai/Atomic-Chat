import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
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

const ONE_QUANT_FAMILY = {
  ...Z_IMAGE,
  id: 'flux.2-klein' as const,
  name: 'FLUX.2 Klein 4B',
  transformer: {
    ...Z_IMAGE.transformer,
    quants: [Z_IMAGE.transformer.quants[0]],
  },
}
const ONE_QUANT_ID = 'flux.2-klein:q4_k_m'

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

  it.each(['reference', 'edit'] as const)(
    'lists only the one compatible family for the %s workflow',
    (workflow) => {
      const klein = {
        ...Z_IMAGE,
        id: 'flux.2-klein' as const,
        name: 'FLUX.2 Klein 4B',
      }
      useImageGenerationStore.setState({
        catalog: makeCatalog([Z_IMAGE, klein]),
      })
      render(<ImageModelSelector workflow={workflow} />)

      const kleinBlock = screen.getByTestId('family-flux.2-klein')
      expect(kleinBlock).toBeInTheDocument()
      expect(screen.queryByTestId('family-z-image')).not.toBeInTheDocument()
      expect(
        screen.queryByText('images:model.notForWorkflow')
      ).not.toBeInTheDocument()
      expect(screen.getAllByTestId(/^family-/)).toHaveLength(1)
    }
  )

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
    expect(
      within(installed).queryByText(/images:model.sizeGb/)
    ).not.toBeInTheDocument()
    expect(
      within(installed).queryByTestId('image-model-download-meta')
    ).not.toBeInTheDocument()
  })

  it('groups installed and available quants without promoting an available quant into the outer row', async () => {
    // 16 GiB: Q4 needs ~7.8 GiB with its encoder and activations (ok), Q8 ~11.6 (maybe).
    hardware.profile = gpuWith(16 * 1024)
    render(<ImageModelSelector />)
    const family = screen.getByTestId('family-z-image')
    const row = screen.getByTestId(`artifact-${Q4_ID}`)
    expect(within(row).getByText('Q4_K_M')).toBeInTheDocument()
    expect(family).toHaveAttribute('data-artifact-id', Q4_ID)
    expect(
      within(family).getByRole('button', { name: 'images:model.load' })
    ).toBeInTheDocument()
    expect(
      within(family).queryByRole('button', { name: 'images:model.download' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('images:model.recommended')
    ).not.toBeInTheDocument()

    await userEvent.click(
      within(row).getByRole('button', { name: 'images:model.pick' })
    )
    expect(screen.getByTestId('quant-group-downloaded')).toHaveTextContent(
      'images:model.downloaded'
    )
    expect(screen.getByTestId('quant-group-available')).toHaveTextContent(
      'images:model.available'
    )
    expect(screen.getByTestId(`quant-${Q4_ID}`)).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(
      within(screen.getByTestId(`quant-${Q4_ID}`)).queryByText(
        'images:model.downloaded',
        { selector: 'span' }
      )
    ).not.toBeInTheDocument()
    expect(screen.getByTestId(`quant-downloaded-${Q4_ID}`)).toBeInTheDocument()
    const available = screen.getByTestId(`quant-${Q8_ID}`)
    expect(within(available).getByText('images:model.sizeGb')).toBeInTheDocument()
    expect(within(available).getByText('Might fit')).toBeInTheDocument()
    expect(available).toHaveAttribute('role', 'menuitem')
    expect(available).toHaveAccessibleName('images:model.download Q8_0')
    expect(within(available).getByText('images:model.download')).toBeInTheDocument()

    await userEvent.hover(available)
    expect(family).toHaveAttribute('data-artifact-id', Q4_ID)
    expect(
      within(family).getByRole('button', {
        name: 'images:model.load',
        hidden: true,
      })
    ).toBeInTheDocument()
    expect(
      within(family).queryByRole('button', {
        name: 'images:model.download',
        hidden: true,
      })
    ).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByTestId(`quant-action-${Q8_ID}`)
    )
    await waitFor(() => expect(transfer.download).toHaveBeenCalledTimes(1))
    expect(transfer.download.mock.calls[0][1]).toBe('q8_0')
    expect(family).toHaveAttribute('data-artifact-id', Q4_ID)
  })

  it('uses compact page rows with primary actions and icon-only removal', () => {
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)

    expect(row).toHaveAttribute('data-compact-row', 'true')
    expect(
      within(row).getByRole('button', { name: 'images:model.load' })
    ).toHaveAttribute('data-variant', 'default')
    expect(
      within(row)
        .getByRole('button', { name: 'images:model.load' })
        .querySelector('svg')
    ).toBeNull()
    const quantTrigger = within(row).getByRole('button', {
      name: 'images:model.pick',
    })
    expect(quantTrigger.querySelector('[class*="bg-secondary"]')).toBeNull()
    const remove = within(row).getByRole('button', {
      name: 'images:model.remove',
    })
    expect(remove).toHaveAttribute('data-size', 'icon-xs')
    expect(remove).not.toHaveTextContent('images:model.remove')
  })

  it('offers a primary outer Download for a one-quant available family', async () => {
    const oneQuantCatalog = makeCatalog([ONE_QUANT_FAMILY])
    useImageGenerationStore.setState({
      catalog: oneQuantCatalog,
      modelFiles: [],
      installedArtifacts: [],
    })
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${ONE_QUANT_ID}`)
    const family = screen.getByTestId('family-flux.2-klein')

    expect(row).toHaveAttribute('data-compact-row', 'true')
    expect(
      within(family).getByRole('button', { name: 'images:model.download' })
    ).toHaveAttribute('data-variant', 'default')
    expect(
      within(family).queryByTestId('image-model-download-meta')
    ).not.toBeInTheDocument()

    await userEvent.click(
      within(family).getByRole('button', { name: 'images:model.download' })
    )
    await waitFor(() => expect(transfer.download).toHaveBeenCalledTimes(1))
    expect(transfer.download.mock.calls[0][1]).toBe('q4_k_m')
    expect(useImageSetting.getState().selectedArtifactId).toBe(ONE_QUANT_ID)
  })

  it('keeps alternative per-quant downloads inside the Available group', async () => {
    useImageGenerationStore.setState({ modelFiles: [], installedArtifacts: [] })
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)
    const family = screen.getByTestId('family-z-image')

    expect(
      within(family).getByRole('button', { name: 'images:model.download' })
    ).toBeInTheDocument()

    await userEvent.click(
      within(row).getByRole('button', { name: 'images:model.pick' })
    )
    expect(screen.queryByTestId('quant-group-downloaded')).not.toBeInTheDocument()
    expect(screen.getByTestId('quant-group-available')).toBeInTheDocument()
    for (const id of [Q4_ID, Q8_ID]) {
      const quant = screen.getByTestId(`quant-${id}`)
      expect(quant).toHaveAttribute('role', 'menuitem')
      expect(within(quant).getByText('images:model.download')).toBeInTheDocument()
      expect(within(quant).getByText('images:model.sizeGb')).toBeInTheDocument()
    }
  })

  it('omits an empty Available group and selects another installed quant', async () => {
    const allFiles = [...q4Files, ...makeFilesFor(Z_IMAGE, 'q8_0')]
    useImageGenerationStore.setState({
      modelFiles: allFiles,
      installedArtifacts: listInstalledArtifacts(catalog, allFiles),
    })
    render(<ImageModelSelector />)

    await userEvent.click(
      within(screen.getByTestId(`artifact-${Q4_ID}`)).getByRole('button', {
        name: 'images:model.pick',
      })
    )
    expect(screen.getByTestId('quant-group-downloaded')).toHaveTextContent(
      'images:model.downloaded'
    )
    expect(screen.queryByTestId('quant-group-available')).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId(`quant-${Q8_ID}`)).queryByText(
        'images:model.downloaded',
        { selector: 'span' }
      )
    ).not.toBeInTheDocument()
    expect(screen.getByTestId(`quant-downloaded-${Q8_ID}`)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId(`quant-${Q8_ID}`))
    const family = screen.getByTestId('family-z-image')
    expect(family).toHaveAttribute('data-artifact-id', Q8_ID)
    expect(
      within(family).getByRole('button', { name: 'images:model.load' })
    ).toBeInTheDocument()
    expect(useImageSetting.getState().selectedArtifactId).toBe(Q8_ID)
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

  it('keeps Run, starting, Stop, and stopping in one stable action slot', async () => {
    const originalLoad = fake.loadModel.getMockImplementation()!
    const originalUnload = fake.unloadModel.getMockImplementation()!
    let releaseLoad!: () => void
    let releaseUnload!: () => void
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const unloadGate = new Promise<void>((resolve) => {
      releaseUnload = resolve
    })
    fake.loadModel.mockImplementationOnce(async (request) => {
      await loadGate
      return originalLoad(request)
    })
    fake.unloadModel.mockImplementationOnce(async () => {
      await unloadGate
      return originalUnload()
    })

    render(<ImageModelSelector />)
    const family = screen.getByTestId('family-z-image')
    const idle = within(family).getByTestId('image-model-runtime-action')
    expect(idle).toHaveAttribute('data-phase', 'idle')
    expect(idle).toHaveTextContent('images:model.load')
    expect(idle.querySelector('svg')).toBeNull()

    await userEvent.click(idle)
    const starting = within(family).getByTestId('image-model-runtime-action')
    await waitFor(() => expect(starting).toHaveAttribute('data-phase', 'starting'))
    expect(starting).not.toHaveTextContent('images:model.loading')
    expect(starting.querySelector('svg')).not.toBeNull()

    releaseLoad()
    await waitFor(() =>
      expect(
        within(family).getByTestId('image-model-runtime-action')
      ).toHaveAttribute('data-phase', 'ready')
    )
    const ready = within(family).getByTestId('image-model-runtime-action')
    expect(ready).toHaveTextContent('images:model.unload')
    expect(ready.querySelector('svg')).toBeNull()

    await userEvent.click(ready)
    const stopping = within(family).getByTestId('image-model-runtime-action')
    await waitFor(() => expect(stopping).toHaveAttribute('data-phase', 'stopping'))
    expect(stopping).not.toHaveTextContent('images:model.unload')
    expect(stopping.querySelector('svg')).not.toBeNull()

    releaseUnload()
    await waitFor(() =>
      expect(
        within(family).getByTestId('image-model-runtime-action')
      ).toHaveAttribute('data-phase', 'idle')
    )
    expect(toast.loading).toHaveBeenCalledTimes(2)
    expect(toast.success).toHaveBeenCalledTimes(2)
  })

  it('downloads every required file immediately after one click', async () => {
    useImageGenerationStore.setState({
      modelFiles: [],
      installedArtifacts: [],
    })
    render(<ImageModelSelector />)
    await act(async () => {
      await userEvent.click(
        within(screen.getByTestId('family-z-image')).getByRole('button', {
          name: 'images:model.download',
        })
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

  it('shows active download progress in the outer quick-action slot', async () => {
    act(() => {
      useImageGenerationStore.setState({
        modelFiles: [],
        installedArtifacts: [],
      })
      useDownloadStore
        .getState()
        .updateProgress(diffusionDownloadTaskId(Q4_ID), 0.18, Q4_ID, 1, 10)
    })
    render(<ImageModelSelector />)
    const row = screen.getByTestId(`artifact-${Q4_ID}`)
    const family = screen.getByTestId('family-z-image')

    expect(within(family).queryByText('images:model.progress')).not.toBeInTheDocument()
    const cancel = within(row).getByRole('button', {
      name: 'common:cancelDownload',
    })
    expect(cancel).toHaveTextContent('18%')
    expect(cancel).toHaveClass('w-24')
  })

  it('tells the user when the catalog has not arrived', () => {
    useImageGenerationStore.setState({ catalog: null })
    render(<ImageModelSelector />)
    expect(screen.getByTestId('image-models-loading')).toBeInTheDocument()
  })
})
