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
import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu" />,
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/diffusion/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/config')>()),
  configureDiffusion: vi.fn(async () => makeStatus({ idleUnloadSecs: 0 })),
  getDiffusionPaths: vi.fn(),
}))
vi.mock('@/services/diffusion/install', () => ({
  ensureDiffusionBackend: vi.fn(),
  selectDiffusionBackendForHost: vi.fn(async () => ({ backendId: 'macos-arm64' })),
}))

import { useImageSetting } from '@/hooks/useImageSetting'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { Route } from '../media'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('Media settings', () => {
  let fake: FakeDiffusion
  const open = vi.fn(async () => '/Users/me/Pictures/Atomic')
  const openPath = vi.fn(async () => undefined)
  const Component = Route.component as React.ComponentType

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    global.IS_MACOS = false
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useImageSetting.persist.rehydrate()
    fake = makeFakeDiffusion()
    seedServiceHub({
      diffusion: fake,
      dialog: { open, save: vi.fn() } as unknown as ReturnType<ServiceHub['dialog']>,
      opener: {
        open: vi.fn(),
        openPath,
        revealItemInDir: vi.fn(),
      } as unknown as ReturnType<ServiceHub['opener']>,
    })
    const catalog = makeCatalog()
    const files = makeFilesFor(Z_IMAGE, 'q4_k_m')
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      status: makeStatus(),
      catalog,
      modelFiles: files,
      installedArtifacts: listInstalledArtifacts(catalog, files),
      hostBackendId: 'macos-arm64',
    })
  })

  it('renders the page chrome with the three cards', () => {
    render(<Component />)
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('settings:media.engineTitle')).toBeInTheDocument()
    expect(screen.getByText('settings:media.modelsTitle')).toBeInTheDocument()
    expect(screen.getByText('settings:media.outputTitle')).toBeInTheDocument()
  })

  it('shows the installed engine and offers Reinstall, or Install when missing', () => {
    const installed = render(<Component />)
    expect(screen.getByText('settings:media.engineInstalled')).toBeInTheDocument()
    expect(screen.getByText('settings:media.reinstall')).toBeInTheDocument()
    installed.unmount()

    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
    })
    render(<Component />)
    expect(screen.getByText('settings:media.engineNotInstalled')).toBeInTheDocument()
    expect(screen.getByText('settings:media.install')).toBeEnabled()
  })

  it('hides the engine override while only one engine can serve this host', () => {
    render(<Component />)
    expect(screen.queryByText('settings:media.engineOverride')).not.toBeInTheDocument()
  })

  it('lists the installed checkpoint with its size', () => {
    render(<Component />)
    expect(screen.getByText('Z-Image Turbo · Q4_K_M')).toBeInTheDocument()
    expect(screen.getByText('images:model.sizeGb')).toBeInTheDocument()
  })

  it('shows the output folder and changes it through the folder picker', async () => {
    render(<Component />)
    expect(screen.getByTestId('media-output-dir')).toHaveTextContent('/data/images')

    await act(async () => {
      await userEvent.click(screen.getByText('settings:media.change'))
    })

    expect(open.mock.calls[0][0]).toMatchObject({ directory: true })
    expect(fake.setOutputDir).toHaveBeenCalledWith('/Users/me/Pictures/Atomic')
    await waitFor(() =>
      expect(screen.getByTestId('media-output-dir')).toHaveTextContent(
        '/Users/me/Pictures/Atomic'
      )
    )
  })

  it('opens the output folder', async () => {
    render(<Component />)
    await act(async () => {
      await userEvent.click(screen.getByText('settings:media.openFolder'))
    })
    expect(openPath.mock.calls[0][0]).toBe('/data/images')
  })

  it('applies keep-loaded to the plugin idle timer and disables the idle picker', async () => {
    render(<Component />)
    const idle = screen.getByText('settings:media.idleMinutes').closest('button')!
    expect(idle).toBeEnabled()

    await act(async () => {
      await userEvent.click(screen.getAllByRole('switch')[0])
    })

    expect(useImageSetting.getState().keepModelLoaded).toBe(true)
    expect(screen.getByText('settings:media.idleMinutes').closest('button')).toBeDisabled()
    await waitFor(() =>
      expect(useImageGenerationStore.getState().status?.idleUnloadSecs).toBe(0)
    )
  })

  it('resets the residency settings to their defaults', async () => {
    useImageSetting.setState({
      keepModelLoaded: true,
      idleUnloadMinutes: 60,
      evictChatModel: 'always',
      engineOverride: 'sd-cpp',
    })
    render(<Component />)
    await act(async () => {
      await userEvent.click(screen.getByText('common:reset'))
    })
    expect(useImageSetting.getState()).toMatchObject({
      keepModelLoaded: false,
      idleUnloadMinutes: 10,
      evictChatModel: 'whenNeeded',
      engineOverride: 'auto',
    })
  })
})
