import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ServiceHub } from '@/services'
import type { EngineVersions } from '@/services/engines/types'
import type { ModelSetupService } from '@/services/model-setup/types'
import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { seedServiceHub } from '@/test/service-hub'

import { DownloadsPage } from '../DownloadsPage'

// Keys stay readable; a name passed in is appended so rows can be told apart.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) =>
      vars?.name ? `${key}(${vars.name})` : key,
  }),
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// Importing the registry store fires a background fetch that lands mid-test.
vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { providers: [], hasInitialized: true, refresh: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        providers: [],
        hasInitialized: true,
        refresh: vi.fn(),
      }),
    }
  ),
  isKnownProvider: () => true,
  ensureRegistryLoaded: async () => [],
}))

const deleteLocalModel = vi.hoisted(() => vi.fn())
vi.mock('@/lib/model-deletion', () => ({ deleteLocalModel }))

const deleteEngineBuild = vi.hoisted(() => vi.fn())
vi.mock('@/services/engines/core', () => ({
  deleteEngineBuild,
  engineVersions: vi.fn(),
}))

const cancelDownload = vi.hoisted(() => vi.fn())
vi.mock('@/lib/downloadCancellation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloadCancellation')>()),
  cancelDownload,
}))

const GB = 1024 ** 3

const provider = (name: string, models: Partial<Model>[]): ModelProvider =>
  ({
    active: true,
    provider: name,
    persist: true,
    settings: [],
    models: models.map((model) => ({ id: 'unset', ...model })),
  }) as ModelProvider

const engineBuild = (
  version: string,
  removable: boolean
): EngineVersions['builds'][number] => ({
  version,
  variant: 'macos-arm64',
  origin: removable ? 'downloaded' : 'bundled',
  active: !removable,
  in_use: false,
  removable,
  ...(removable ? {} : { not_removable_reason: 'bundled' as const }),
})

let serviceHub: ServiceHub
const diskAvailable = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  diskAvailable.mockResolvedValue(512 * GB)
  deleteLocalModel.mockResolvedValue(undefined)
  deleteEngineBuild.mockResolvedValue({})
  serviceHub = seedServiceHub({
    decision: { isSupported: () => false } as never,
    modelSetup: { diskAvailable } as unknown as ModelSetupService,
  })
  useModelProvider.setState({
    deletedModels: [],
    providers: [
      provider('llamacpp-upstream', [
        { id: 'unsloth/Qwen3.5-4B-Q4_K_M', sizeBytes: 2.5 * GB },
      ]),
      provider('mlx', [{ id: 'Llama-3.1-8B-4bit', sizeBytes: 4.5 * GB }]),
    ],
  })
  useImageGenerationStore.setState({
    catalog: null,
    installedArtifacts: [],
    modelFiles: [],
  })
  useEmbeddingStore.setState({
    catalog: getBaselineEmbeddingCatalog(),
    installed: {},
    bind: () => () => {},
  })
  useDecisionStore.setState({
    catalog: getBaselineDecisionCatalog(),
    installed: {},
    bind: () => () => {},
  })
  useEngineVersionsStore.setState({
    refresh: vi.fn().mockResolvedValue(undefined),
    engines: {
      mlx: {
        engine: 'mlx',
        kind: 'engine-build',
        active_choice: 'core',
        builds: [engineBuild('v0.4.0', false), engineBuild('v0.3.9', true)],
        active: null,
        latest: null,
        update: { needed: false, target: null, apply: 'swap' },
        source: null,
        source_error: null,
        error: null,
      },
    },
  })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
    downloadOriginByModelId: {},
  })
})

const rows = () => screen.queryAllByTestId('downloads-row')
const rowNamed = (name: string) =>
  rows().find((row) => within(row).queryByText(name)) as HTMLElement

describe('DownloadsPage', () => {
  it('sums what is on disk, counts it, and shows the free space', async () => {
    render(<DownloadsPage />)

    expect(
      screen.getByLabelText('downloads:summary.totalStorage')
    ).toHaveTextContent('7.0 GB')
    expect(screen.getByLabelText('downloads:summary.items')).toHaveTextContent(
      '4'
    )
    await waitFor(() =>
      expect(
        screen.getByLabelText('downloads:summary.freeSpace')
      ).toHaveTextContent('512.0 GB')
    )
    // The core reports no size for a build: say so instead of a number.
    expect(
      screen.getByText('downloads:summary.enginesNotCounted')
    ).toBeVisible()
    const engineBuild = rows().find((row) =>
      within(row).queryByText(/v0\.3\.9/)
    ) as HTMLElement
    expect(within(engineBuild).getByText('—')).toBeInTheDocument()
  })

  it('shows a dash when the platform cannot say how much room is left', async () => {
    diskAvailable.mockRejectedValue(new Error('unsupported'))
    render(<DownloadsPage />)

    await waitFor(() => expect(diskAvailable).toHaveBeenCalled())
    expect(
      screen.getByLabelText('downloads:summary.freeSpace')
    ).toHaveTextContent('—')
  })

  it('filters by category and by search', () => {
    render(<DownloadsPage />)
    expect(rows()).toHaveLength(4)

    fireEvent.change(screen.getByLabelText('downloads:categoryLabel'), {
      target: { value: 'engine' },
    })
    expect(rows()).toHaveLength(2)
    expect(rows().every((row) => within(row).queryByText('MLX'))).toBe(true)

    fireEvent.change(screen.getByLabelText('downloads:categoryLabel'), {
      target: { value: 'all' },
    })
    fireEvent.change(screen.getByLabelText('downloads:searchLabel'), {
      target: { value: 'qwen' },
    })
    expect(rows()).toHaveLength(1)
    expect(
      within(rows()[0]).getByText('unsloth/Qwen3.5-4B-Q4_K_M')
    ).toBeInTheDocument()

    // The engine and the kind are searchable too.
    fireEvent.change(screen.getByLabelText('downloads:searchLabel'), {
      target: { value: 'v0.3.9' },
    })
    expect(rows()).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('downloads:searchLabel'), {
      target: { value: 'nothing like this' },
    })
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('downloads:noMatch')).toBeInTheDocument()
  })

  it('removes a model through its provider after the user confirms', async () => {
    render(<DownloadsPage />)

    fireEvent.click(
      within(rowNamed('Llama-3.1-8B-4bit')).getByRole('button', {
        name: /^downloads:remove/,
      })
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('downloads:confirm.title(Llama-3.1-8B-4bit)')
    ).toBeInTheDocument()
    expect(deleteLocalModel).not.toHaveBeenCalled()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'downloads:confirm.remove' })
    )

    await waitFor(() =>
      expect(deleteLocalModel).toHaveBeenCalledWith(
        serviceHub,
        'Llama-3.1-8B-4bit',
        'mlx'
      )
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'downloads:removed(Llama-3.1-8B-4bit)'
      )
    )
    // Free space is read again once the files are gone.
    expect(diskAvailable).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing removed when the user cancels', async () => {
    render(<DownloadsPage />)

    fireEvent.click(
      within(rowNamed('unsloth/Qwen3.5-4B-Q4_K_M')).getByRole('button', {
        name: /^downloads:remove/,
      })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'downloads:confirm.cancel' })
    )

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(deleteLocalModel).not.toHaveBeenCalled()
  })

  it('offers no removal of a build the core keeps, and removes one it allows', async () => {
    render(<DownloadsPage />)

    const bundled = rows().find((row) =>
      within(row).queryByText(/v0\.4\.0/)
    ) as HTMLElement
    const kept = within(bundled).getByRole('button', {
      name: /^downloads:remove/,
    })
    expect(kept).toBeDisabled()
    expect(kept).toHaveAttribute(
      'title',
      'settings:engineBuilds.notRemovable.bundled'
    )
    // The reason is on the row, not only in a tooltip.
    expect(
      within(bundled).getByText(/settings:engineBuilds\.notRemovable\.bundled/)
    ).toBeInTheDocument()

    const downloaded = rows().find((row) =>
      within(row).queryByText(/v0\.3\.9/)
    ) as HTMLElement
    fireEvent.click(
      within(downloaded).getByRole('button', { name: /^downloads:remove/ })
    )
    const dialog = await screen.findByRole('dialog')
    // Two builds of one engine share a name: the dialog names the version.
    expect(
      within(dialog).getByText(
        'downloads:confirm.title(MLX v0.3.9 macos-arm64)'
      )
    ).toBeInTheDocument()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'downloads:confirm.remove' })
    )

    await waitFor(() =>
      expect(deleteEngineBuild).toHaveBeenCalledWith(
        'mlx',
        'v0.3.9',
        'macos-arm64'
      )
    )
    expect(deleteEngineBuild).toHaveBeenCalledTimes(1)
  })

  it('reports the core’s refusal instead of pretending it worked', async () => {
    deleteEngineBuild.mockRejectedValue({
      code: 'BACKEND_IN_USE',
      message: 'a model runs from it',
    })
    render(<DownloadsPage />)

    const downloaded = rows().find((row) =>
      within(row).queryByText(/v0\.3\.9/)
    ) as HTMLElement
    fireEvent.click(
      within(downloaded).getByRole('button', { name: /^downloads:remove/ })
    )
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'downloads:confirm.remove',
      })
    )

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'downloads:removeFailed(MLX v0.3.9 macos-arm64)',
        {
          description: 'settings:engineBuilds.error.inUse',
        }
      )
    )
    expect(toast.success).not.toHaveBeenCalled()
    // The build the core refused to remove stays on the page.
    expect(rows().some((row) => within(row).queryByText(/v0\.3\.9/))).toBe(true)
  })

  it('lists a running download first and cancels it like the panel does', () => {
    useDownloadStore.setState({
      downloads: {
        'unsloth/Big-Model-Q4_K_M': {
          id: 'unsloth/Big-Model-Q4_K_M',
          name: 'unsloth/Big-Model-Q4_K_M',
          progress: 0.25,
          current: 5 * GB,
          total: 20 * GB,
          speed: { bytesPerSecond: 0, atBytes: 0, atTime: 0 },
        },
      },
    })
    render(<DownloadsPage />)

    const first = rows()[0]
    expect(within(first).getByText('unsloth/Big-Model-Q4_K_M')).toBeVisible()
    expect(within(first).getByText('25%')).toBeInTheDocument()
    expect(within(first).getByText('5.00 / 20.00 GB')).toBeInTheDocument()
    // Not on disk yet: neither counted nor offered for removal.
    expect(screen.getByLabelText('downloads:summary.items')).toHaveTextContent(
      '4'
    )

    fireEvent.click(
      within(first).getByRole('button', { name: 'common:cancelDownload' })
    )
    expect(cancelDownload).toHaveBeenCalledWith(
      { id: 'unsloth/Big-Model-Q4_K_M', name: 'unsloth/Big-Model-Q4_K_M' },
      serviceHub
    )
  })

  it('never takes the global download panel’s landmark', () => {
    render(<DownloadsPage />)
    // Desktop E2E finds the panel as the region labelled "Downloads".
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('says when nothing is downloaded yet', () => {
    useModelProvider.setState({ providers: [] })
    useEngineVersionsStore.setState({ engines: {} })
    render(<DownloadsPage />)

    expect(rows()).toHaveLength(0)
    expect(screen.getByText('downloads:empty')).toBeInTheDocument()
  })
})
