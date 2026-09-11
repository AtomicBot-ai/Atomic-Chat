import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeStatus,
  Z_IMAGE,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The model selector has its own tests; here it is just "the step-3 content".
vi.mock('@/containers/images/ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

const install = vi.hoisted(() => ({
  ensure: vi.fn(),
  select: vi.fn(async () => ({ backendId: 'macos-arm64' })),
}))
vi.mock('@/services/diffusion/install', () => ({
  ensureDiffusionBackend: install.ensure,
  selectDiffusionBackendForHost: install.select,
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

  it('walks forward and back through the three steps', async () => {
    render(<ImageSetupDialog />)
    await act(async () => {
      await userEvent.click(screen.getByText('images:setup.next'))
    })
    expect(useImageGenerationStore.getState().setupStep).toBe(1)
    expect(screen.getByText('images:setup.engine.title')).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByText('images:setup.next'))
    })
    expect(useImageGenerationStore.getState().setupStep).toBe(2)
    expect(screen.getByTestId('image-model-selector')).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByText('images:setup.back'))
    })
    expect(useImageGenerationStore.getState().setupStep).toBe(1)
  })

  it('keeps every step description short enough for its two-line slot', () => {
    const MAX = 100
    for (const [locale, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      for (const step of ['intro', 'engine', 'model'] as const) {
        const text = bundle.setup[step].description
        expect(
          text.length,
          `${locale} ${step}.description is ${text.length} chars`
        ).toBeLessThanOrEqual(MAX)
      }
    }
  })

  it('installs the engine from step 2 and shows it installed', async () => {
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
      expect(screen.getByText('images:setup.engine.installed')).toBeInTheDocument()
    )
    expect(useImageGenerationStore.getState().status?.install.state).toBe('installed')
  })

  it('explains when this computer has no engine build', () => {
    useImageGenerationStore.setState({
      setupStep: 1,
      hostBackendId: null,
      hostBackendReason: 'Intel Macs are not supported.',
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
