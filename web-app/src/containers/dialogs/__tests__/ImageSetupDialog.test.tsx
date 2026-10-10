import { act, render, screen } from '@testing-library/react'
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
  modality: 'image' as 'image' | 'video',
}))

// The model selector has its own tests; here it exposes the accepted-download
// callback so the setup-dialog behavior can be tested in isolation.
vi.mock('@/containers/images/ImageModelSelector', () => ({
  ImageModelSelector: ({
    onDownloadStarted,
    modality,
  }: {
    onDownloadStarted?: (artifactId: string) => void
    modality?: 'image' | 'video'
  }) => {
    modelSelector.modality = modality ?? 'image'
    modelSelector.startDownload = () => {
      modelSelector.dispatchDownload()
      onDownloadStarted?.('z-image:q4_k_m')
    }
    return <div data-testid="image-model-selector" />
  },
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
      status: notInstalled(),
      hostBackendId: 'macos-arm64',
      catalog: makeCatalog(),
      installedArtifacts: [],
    })
  })

  it('speaks for the page that opened it and lists that page\'s models', () => {
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-title')).toHaveTextContent(
      'images:setup.model.title'
    )
    expect(modelSelector.modality).toBe('image')
  })

  it('lists video models when the Video page opened it', () => {
    useImageGenerationStore.setState({ setupModality: 'video' })
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-title')).toHaveTextContent(
      'videos:setup.model.title'
    )
    expect(modelSelector.modality).toBe('video')
  })

  it('has no tour: no Back, no Next, no engine step', () => {
    render(<ImageSetupDialog />)
    expect(screen.queryByText('images:setup.back')).not.toBeInTheDocument()
    expect(screen.queryByText('images:setup.next')).not.toBeInTheDocument()
    expect(screen.queryByTestId('image-engine-install')).not.toBeInTheDocument()
  })

  it('keeps each description short enough for its two-line slot', () => {
    const MAX = 100
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      for (const step of ['model', 'ready'] as const) {
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
    useImageGenerationStore.setState({ status: makeStatus() })
    const { unmount } = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-title')).toHaveTextContent(
      'images:setup.model.title'
    )

    // The download lands while the dialog is open.
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

  it('keeps the list headed "get a model" while the engine is missing', () => {
    useImageGenerationStore.setState({
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

  it('only allows Done once the engine and a model are both in place', () => {
    const neither = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    neither.unmount()

    // The engine alone is not enough.
    useImageGenerationStore.setState({ status: makeStatus() })
    const engineOnly = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    engineOnly.unmount()

    // Nor is a model on its own.
    const catalog = makeCatalog()
    const files = makeFilesFor(Z_IMAGE, 'q4_k_m')
    useImageGenerationStore.setState({
      status: notInstalled(),
      installedArtifacts: listInstalledArtifacts(catalog, files),
    })
    const modelOnly = render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    modelOnly.unmount()

    useImageGenerationStore.setState({ status: makeStatus() })
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeEnabled()
  })

  it('marks setup complete on Done', async () => {
    const catalog = makeCatalog()
    useImageGenerationStore.setState({
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
    render(<ImageSetupDialog />)

    expect(() => modelSelector.startDownload()).toThrow('dispatch failed')
    expect(useImageGenerationStore.getState().setupOpen).toBe(true)
  })

  it('can be dismissed half-configured with the close button', async () => {
    render(<ImageSetupDialog />)
    expect(screen.getByTestId('image-setup-done')).toBeDisabled()
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })
})
