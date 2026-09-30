import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeLoadedStatus,
  makeStatus,
  Z_IMAGE,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const modelSelector = vi.hoisted(() => ({
  dispatchDownload: vi.fn(),
  startDownload: () => {},
}))

// The model selector has its own tests; here it exposes the accepted-download
// callback so the setup-dialog behavior can be tested in isolation.
vi.mock('@/containers/images/ImageModelSelector', () => ({
  ImageModelSelector: ({
    onDownloadStarted,
  }: {
    onDownloadStarted?: (artifactId: string) => void
  }) => {
    modelSelector.startDownload = () => {
      modelSelector.dispatchDownload()
      onDownloadStarted?.('z-image:q4_k_m')
    }
    return <div data-testid="image-model-selector" />
  },
}))

const install = vi.hoisted(() => ({
  ensure: vi.fn(),
  select: vi.fn(async () => ({ backendId: 'macos-arm64' })),
}))
vi.mock('@/services/diffusion/install', () => ({
  ensureDiffusionBackend: install.ensure,
  selectDiffusionBackendForHost: install.select,
  resolveSdcppManifest: vi.fn(async () => ({
    manifest: { tag_name: 'master-849-d04e895', assets: [] },
    source: 'cache',
    fetchedAt: 1,
  })),
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))

import en from '@/locales/en/images.json'
import ru from '@/locales/ru/images.json'
import { useImageSetting } from '@/hooks/useImageSetting'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import ImageSetupDialog from '../ImageSetupDialog'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const notInstalled = () => makeStatus({ install: { state: 'not-installed' } })

describe('ImageSetupDialog', () => {
  let fake: FakeDiffusion

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useImageSetting.persist.rehydrate()
    useImageSetting.setState({ setupCompleted: false })
    fake = makeFakeDiffusion()
    fake.getStatus.mockResolvedValue(notInstalled())
    seedServiceHub({ diffusion: fake })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      setupOpen: true,
      setupStep: 0,
      status: notInstalled(),
      hostBackendId: 'macos-arm64',
      catalog: makeCatalog(),
      installedArtifacts: [],
    })
  })

  it('leads each step with its own title and one subtitle', () => {
    render(<ImageSetupDialog />)
    expect(screen.getByText('images:setup.intro.title')).toBeInTheDocument()
    expect(screen.getByText('images:setup.intro.description')).toBeInTheDocument()
  })

  it('ends the tour at the engine: Done, never on to a model step', async () => {
    render(<ImageSetupDialog />)
    await act(async () => {
      await userEvent.click(screen.getByText('images:setup.next'))
    })
    expect(useImageGenerationStore.getState().setupStep).toBe(1)
    expect(screen.getByText('images:setup.engine.title')).toBeInTheDocument()
    expect(screen.queryByText('images:setup.next')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-setup-engine-done')).toBeDisabled()

    await act(async () => {
      await userEvent.click(screen.getByText('images:setup.back'))
    })
    expect(useImageGenerationStore.getState().setupStep).toBe(0)
    await act(async () => {
      await userEvent.click(screen.getByText('images:setup.next'))
    })

    act(() => {
      useImageGenerationStore.setState({ status: makeStatus() })
    })

    // No model on disk: the studio's picker handles that, not the wizard.
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-setup-engine-done'))
    })
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
    expect(useImageGenerationStore.getState().setupStep).toBe(1)
    expect(useImageSetting.getState().setupCompleted).toBe(true)
  })

  it('offers Back from the standalone model list only while the engine is owed', () => {
    useImageGenerationStore.setState({ setupStep: 2 })
    const { unmount } = render(<ImageSetupDialog />)
    expect(screen.getByText('images:setup.back')).toBeInTheDocument()
    unmount()

    useImageGenerationStore.setState({ setupStep: 2, status: makeStatus() })
    render(<ImageSetupDialog />)
    expect(screen.queryByText('images:setup.back')).not.toBeInTheDocument()
  })

  it('keeps every step description short enough for its two-line slot', () => {
    const MAX = 100
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      for (const step of ['intro', 'engine', 'model', 'ready'] as const) {
        const text = bundle.setup[step].description
        expect(
          text.length,
          `${locale} ${step}.description is ${text.length} chars`
        ).toBeLessThanOrEqual(MAX)
      }
      expect(bundle.setup.ready.descriptionRunning.length).toBeLessThanOrEqual(MAX)
    }
  })

  it('says it is ready once a model has landed, and what to press next', () => {
    const catalog = makeCatalog()
    useImageGenerationStore.setState({ setupStep: 2, status: makeStatus() })
    const { unmount } = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-title')).toHaveTextContent(
      'images:setup.model.title'
    )

    // The download lands while the wizard is open.
    act(() => {
      useImageGenerationStore.setState({
        installedArtifacts: listInstalledArtifacts(
          catalog,
          makeFilesFor(Z_IMAGE, 'q4_k_m')
        ),
      })
    })
    expect(screen.getByTestId('image-setup-title')).toHaveTextContent(
      'images:setup.ready.title'
    )
    expect(screen.getByTestId('image-setup-description')).toHaveTextContent(
      'images:setup.ready.description'
    )
    expect(screen.getByTestId('image-setup-done')).toBeEnabled()
    unmount()

    // Run was pressed: nothing is left but Done.
    useImageGenerationStore.setState({ status: makeLoadedStatus() })
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-description')).toHaveTextContent(
      'images:setup.ready.descriptionRunning'
    )
  })

  it('keeps the model step headed "get a model" while the engine is missing', () => {
    useImageGenerationStore.setState({
      setupStep: 2,
      installedArtifacts: listInstalledArtifacts(
        makeCatalog(),
        makeFilesFor(Z_IMAGE, 'q4_k_m')
      ),
    })
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-title')).toHaveTextContent(
      'images:setup.model.title'
    )
  })

  it('keeps the wizard open while installing and reaches the installed state', async () => {
    install.ensure.mockImplementation(async () => {
      fake.getStatus.mockResolvedValue(makeStatus())
      return {
        tag: 'master-849-d04e895',
        backendId: 'macos-arm64',
        backend: 'metal',
        engine: 'sd-cpp',
        sha256: null,
        installedAtMs: 1,
        dir: '/x',
      }
    })
    useImageGenerationStore.setState({ setupStep: 1 })
    render(<ImageSetupDialog />)

    await act(async () => {
      await userEvent.click(screen.getByTestId('image-engine-install'))
    })

    await waitFor(() =>
      expect(useImageGenerationStore.getState().status?.install.state).toBe(
        'installed'
      )
    )
    expect(useImageGenerationStore.getState().setupOpen).toBe(true)
    expect(useImageGenerationStore.getState().status?.install.state).toBe('installed')
  })

  it.each([
    { transferred: 0, total: 0, percent: 0 },
    { transferred: 50, total: 100, percent: 50 },
    { transferred: 100, total: 100, percent: 100 },
  ])(
    'keeps $percent% engine progress in the same rounded pill',
    ({ transferred, total, percent }) => {
      useImageGenerationStore.setState({
        setupStep: 1,
        engineInstall: {
          inFlight: true,
          transferred,
          total,
          error: null,
        },
      })
      render(<ImageSetupDialog />)

      const progress = screen.getByTestId('image-engine-progress')
      expect(progress).toHaveClass('h-8', 'w-28', 'rounded-full')
      expect(progress).not.toHaveClass('rounded-md')
      expect(progress).toHaveTextContent(`${percent}%`)
    }
  )

  it('explains when this computer has no engine build', () => {
    useImageGenerationStore.setState({
      setupStep: 1,
      hostBackendId: null,
      hostBackendReason: 'Intel Macs are not supported.',
      hostBackendResolved: true,
    })
    render(<ImageSetupDialog />)
    expect(screen.getByText('Intel Macs are not supported.')).toBeInTheDocument()
    expect(screen.queryByTestId('image-engine-install')).not.toBeInTheDocument()
  })

  it('only allows Done once the engine and a model are both in place', () => {
    useImageGenerationStore.setState({ setupStep: 2 })
    const neither = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    neither.unmount()

    // The engine alone is not enough.
    useImageGenerationStore.setState({ setupStep: 2, status: makeStatus() })
    const engineOnly = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    engineOnly.unmount()

    // Nor is a model on its own.
    const catalog = makeCatalog()
    const files = makeFilesFor(Z_IMAGE, 'q4_k_m')
    useImageGenerationStore.setState({
      setupStep: 2,
      status: notInstalled(),
      installedArtifacts: listInstalledArtifacts(catalog, files),
    })
    const modelOnly = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    modelOnly.unmount()

    useImageGenerationStore.setState({ setupStep: 2, status: makeStatus() })
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeEnabled()
  })

  it('marks setup complete on Done', async () => {
    const catalog = makeCatalog()
    useImageGenerationStore.setState({
      setupStep: 2,
      status: makeStatus(),
      installedArtifacts: listInstalledArtifacts(catalog, makeFilesFor(Z_IMAGE, 'q4_k_m')),
    })
    render(<ImageSetupDialog />)
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-setup-done'))
    })
    expect(useImageSetting.getState().setupCompleted).toBe(true)
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })

  it('closes after a model download start is accepted', () => {
    useImageGenerationStore.setState({ setupStep: 2 })
    render(<ImageSetupDialog />)

    act(() => modelSelector.startDownload())

    expect(modelSelector.dispatchDownload).toHaveBeenCalledOnce()
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
    expect(useImageSetting.getState().setupCompleted).toBe(false)
  })

  it('stays open when a model download start throws synchronously', () => {
    modelSelector.dispatchDownload.mockImplementationOnce(() => {
      throw new Error('dispatch failed')
    })
    useImageGenerationStore.setState({ setupStep: 2 })
    render(<ImageSetupDialog />)

    expect(() => modelSelector.startDownload()).toThrow('dispatch failed')
    expect(useImageGenerationStore.getState().setupOpen).toBe(true)
  })

  it('can be dismissed half-configured with the close button', async () => {
    useImageGenerationStore.setState({ setupStep: 2 })
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })
})
