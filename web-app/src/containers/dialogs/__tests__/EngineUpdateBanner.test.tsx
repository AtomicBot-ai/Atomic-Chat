import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EngineUpdateBanner from '@/containers/dialogs/EngineUpdateBanner'
import {
  engineUpdateOfferKey,
  isEngineUpdateSnoozed,
  retractEngineUpdateOffer,
  ENGINE_UPDATE_AVAILABLE_EVENT,
  type EngineUpdateOffer,
} from '@/lib/engineUpdateOffer'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const downloadRecommendedBackend = vi.fn()
const getByName = vi.fn()
const open = vi.fn()

vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ getByName }) },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open }) }),
}))

// The media engine is updated by the image store, not an extension.
const imageStore = vi.hoisted(() => ({
  engineUpdate: { availableTag: null as string | null },
  checkEngineUpdate: vi.fn(),
  updateEngine: vi.fn(),
}))
vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: { getState: () => imageStore },
}))

// MLX is installed by the core, under a download task of the app's.
const engineBuilds = vi.hoisted(() => ({
  installEngineBuildWithProgress: vi.fn(),
  checkEngineBuildUpdates: vi.fn(),
}))
vi.mock('@/services/engine-builds/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engine-builds/core')>()),
  checkEngineBuildUpdates: engineBuilds.checkEngineBuildUpdates,
}))
vi.mock('@/services/engine-builds/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engine-builds/install')>()),
  ...engineBuilds,
}))

const OFFER: EngineUpdateOffer = {
  provider: 'llamacpp-upstream',
  currentBackend: 'b10840/macos-arm64',
  targetBackend: 'b10909-mix-bea84f7/macos-arm64',
  currentVersion: 'b10840',
  targetVersion: 'b10909-mix-bea84f7',
  downloadSizeBytes: 11 * 1024 * 1024,
  restartRequired: false,
  releaseNotesUrl: 'https://example.test/releases/tag/b10909-mix-bea84f7',
}

const publish = (offer: EngineUpdateOffer = OFFER) => {
  localStorage.setItem(engineUpdateOfferKey(offer.provider), JSON.stringify(offer))
}

describe('EngineUpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: false, engine: false },
    })
    open.mockResolvedValue(undefined)
    downloadRecommendedBackend.mockResolvedValue(undefined)
    getByName.mockReturnValue({ downloadRecommendedBackend })
    imageStore.engineUpdate.availableTag = null
    imageStore.checkEngineUpdate.mockResolvedValue(undefined)
    imageStore.updateEngine.mockResolvedValue(undefined)
    engineBuilds.installEngineBuildWithProgress.mockResolvedValue(undefined)
    engineBuilds.checkEngineBuildUpdates.mockResolvedValue({
      update_needed: true,
      current: { tag: 'mlxvlm-macos-arm64-07ba5a1', backend_id: 'macos-arm64', origin: 'bundled' },
      target: { tag: 'mlxvlm-macos-arm64-abc1234', backend_id: 'macos-arm64', download_bytes: 1 },
    })
  })

  it('renders nothing when no engine update is on offer', () => {
    const { container } = render(<EngineUpdateBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the engine, the version transition and what the update costs', async () => {
    publish()
    render(<EngineUpdateBanner />)

    expect(
      await screen.findByText('updater:engine.title')
    ).toBeInTheDocument()
    expect(screen.getByText('b10840')).toBeInTheDocument()
    expect(screen.getByText('b10909-mix-bea84f7')).toBeInTheDocument()
    expect(
      screen.getByText(
        'updater:engine.downloadSize · updater:engine.noRestartNeeded'
      )
    ).toBeInTheDocument()
  })

  it('says a restart is needed when the engine cannot hot-swap', async () => {
    publish({ ...OFFER, restartRequired: true, downloadSizeBytes: undefined })
    render(<EngineUpdateBanner />)

    expect(
      await screen.findByText('updater:engine.restartRequired')
    ).toBeInTheDocument()
  })

  it('picks up an offer published after it mounted', async () => {
    render(<EngineUpdateBanner />)
    expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()

    publish()
    window.dispatchEvent(
      new CustomEvent(ENGINE_UPDATE_AVAILABLE_EVENT, { detail: OFFER })
    )

    expect(await screen.findByText('updater:engine.title')).toBeInTheDocument()
  })

  it('downloads the offered build only once the user accepts', async () => {
    const user = userEvent.setup()
    publish()
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    expect(downloadRecommendedBackend).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(downloadRecommendedBackend).toHaveBeenCalledWith(
      'b10909-mix-bea84f7/macos-arm64'
    )
    // The transfer's progress belongs to <BackendUpdater />, so the banner
    // steps aside instead of growing a progress bar.
    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
  })

  it('offers a PrismML build with its release note, through the PrismML extension', async () => {
    const user = userEvent.setup()
    publish({
      ...OFFER,
      provider: 'atomic-prism',
      currentBackend: 'prism-b9000-abcdef0/macos-arm64',
      targetBackend: 'prism-b9100-1234567/macos-arm64',
      currentVersion: 'prism-b9000-abcdef0',
      targetVersion: 'prism-b9100-1234567',
      notes: 'Faster PQ2_0 kernels on Metal.',
    })
    render(<EngineUpdateBanner />)

    expect(
      await screen.findByText('Faster PQ2_0 kernels on Metal.')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(getByName).toHaveBeenCalledWith('@janhq/atomic-prism-extension')
    expect(downloadRecommendedBackend).toHaveBeenCalledWith(
      'prism-b9100-1234567/macos-arm64'
    )
  })

  it('brings the offer back later after "Remind me later"', async () => {
    const user = userEvent.setup()
    publish()
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(
      screen.getByRole('button', { name: 'updater:remindMeLater' })
    )

    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
    // Snoozed, not forgotten: the offer is still on disk for the next launch.
    expect(
      localStorage.getItem(engineUpdateOfferKey(OFFER.provider))
    ).not.toBeNull()
    expect(isEngineUpdateSnoozed(OFFER, Date.now())).toBe(true)
  })

  it('never offers a dismissed build again', async () => {
    const user = userEvent.setup()
    publish()
    const { unmount } = render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(screen.getByRole('button', { name: 'updater:dismiss' }))
    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
    unmount()

    render(<EngineUpdateBanner />)
    expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
  })

  it('opens the engine release page for "Show what\'s new"', async () => {
    const user = userEvent.setup()
    publish()
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(
      screen.getByRole('button', { name: 'updater:engine.showWhatsNew' })
    )

    expect(open).toHaveBeenCalledWith(OFFER.releaseNotesUrl)
    expect(open.mock.calls).toEqual([[OFFER.releaseNotesUrl]])
    // Reading the notes is not an answer to the offer: the banner stays up
    // with "Update" still live, nothing is downloaded, and the offer is
    // neither snoozed nor dismissed.
    expect(screen.getByText('updater:engine.title')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:update' })
    ).toBeEnabled()
    expect(downloadRecommendedBackend).not.toHaveBeenCalled()
    expect(
      JSON.parse(
        localStorage.getItem(engineUpdateOfferKey(OFFER.provider)) ?? 'null'
      )
    ).toEqual(OFFER)
    expect(isEngineUpdateSnoozed(OFFER, Date.now())).toBe(false)
  })

  it('stands down while the app-update banner holds the corner', async () => {
    publish()
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: true, engine: false },
    })
    render(<EngineUpdateBanner />)

    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
  })

  it('ignores an offer whose target is already the current backend', () => {
    publish({ ...OFFER, targetBackend: OFFER.currentBackend })
    render(<EngineUpdateBanner />)

    expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    // The stale record is cleaned up rather than re-read on every mount.
    expect(
      localStorage.getItem(engineUpdateOfferKey(OFFER.provider))
    ).toBeNull()
  })

  describe('media engine', () => {
    const MEDIA_OFFER: EngineUpdateOffer = {
      provider: 'sd-cpp',
      currentBackend: 'master-849-d04e895/macos-arm64',
      targetBackend: 'master-900-abc1234/macos-arm64',
      currentVersion: 'master-849-d04e895',
      targetVersion: 'master-900-abc1234',
      downloadSizeBytes: 40_000_000,
      restartRequired: false,
      releaseNotesUrl:
        'https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-900-abc1234',
    }

    it('updates through the image store once the user accepts', async () => {
      const user = userEvent.setup()
      imageStore.engineUpdate.availableTag = MEDIA_OFFER.targetVersion
      publish(MEDIA_OFFER)
      render(<EngineUpdateBanner />)

      expect(await screen.findByText('master-900-abc1234')).toBeInTheDocument()
      expect(imageStore.updateEngine).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'updater:update' }))

      expect(imageStore.updateEngine).toHaveBeenCalledTimes(1)
      expect(imageStore.checkEngineUpdate).not.toHaveBeenCalled()
      expect(getByName).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(
          screen.queryByText('updater:engine.title')
        ).not.toBeInTheDocument()
      )
    })

    it('asks the manifest again for an offer this launch has not confirmed', async () => {
      const user = userEvent.setup()
      // The manifest went back to the installed tag since the offer was made.
      publish(MEDIA_OFFER)
      render(<EngineUpdateBanner />)

      await screen.findByText('updater:engine.title')
      await user.click(screen.getByRole('button', { name: 'updater:update' }))

      expect(imageStore.checkEngineUpdate).toHaveBeenCalledTimes(1)
      expect(imageStore.updateEngine).not.toHaveBeenCalled()
      // The manifest no longer offers a newer tag, so the stale offer comes down.
      await waitFor(() =>
        expect(
          screen.queryByText('updater:engine.title')
        ).not.toBeInTheDocument()
      )
    })

    it('waits behind a llama.cpp offer', async () => {
      publish()
      publish(MEDIA_OFFER)
      render(<EngineUpdateBanner />)

      expect(await screen.findByText('b10909-mix-bea84f7')).toBeInTheDocument()
      expect(screen.queryByText('master-900-abc1234')).not.toBeInTheDocument()
    })

    it('steps down when the offer is withdrawn elsewhere', async () => {
      publish(MEDIA_OFFER)
      render(<EngineUpdateBanner />)
      await screen.findByText('updater:engine.title')

      // Updated from Settings → Media: the store withdraws the offer.
      act(() => retractEngineUpdateOffer('sd-cpp'))

      await waitFor(() =>
        expect(
          screen.queryByText('updater:engine.title')
        ).not.toBeInTheDocument()
      )
    })
  })

  describe('MLX', () => {
    const MLX_OFFER: EngineUpdateOffer = {
      provider: 'mlx',
      currentBackend: 'mlxvlm-macos-arm64-07ba5a1/macos-arm64',
      targetBackend: 'mlxvlm-macos-arm64-abc1234/macos-arm64',
      currentVersion: 'mlxvlm-macos-arm64-07ba5a1',
      targetVersion: 'mlxvlm-macos-arm64-abc1234',
      downloadSizeBytes: 210_000_000,
      restartRequired: false,
      releaseNotesUrl:
        'https://github.com/AtomicBot-ai/mlx-vlm/releases/tag/mlxvlm-macos-arm64-abc1234',
    }

    it('installs the offered MLX build through the core once the user accepts', async () => {
      const user = userEvent.setup()
      publish(MLX_OFFER)
      render(<EngineUpdateBanner />)

      expect(
        await screen.findByText('mlxvlm-macos-arm64-abc1234')
      ).toBeInTheDocument()
      expect(engineBuilds.installEngineBuildWithProgress).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'updater:update' }))

      expect(engineBuilds.installEngineBuildWithProgress).toHaveBeenCalledWith(
        'mlx',
        { taskId: 'engine-build-mlx-mlxvlm-macos-arm64-abc1234' }
      )
      expect(getByName).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(
          screen.queryByText('updater:engine.title')
        ).not.toBeInTheDocument()
      )
    })

    it('asks the core again first, and installs nothing when the offer is no longer true', async () => {
      const user = userEvent.setup()
      engineBuilds.checkEngineBuildUpdates.mockResolvedValue({
        update_needed: false,
        current: { tag: 'mlxvlm-macos-arm64-abc1234', backend_id: 'macos-arm64', origin: 'bundled' },
        target: null,
      })
      publish(MLX_OFFER)
      render(<EngineUpdateBanner />)
      await screen.findByText('updater:engine.title')
      await user.click(screen.getByRole('button', { name: 'updater:update' }))

      expect(engineBuilds.checkEngineBuildUpdates).toHaveBeenCalledWith('mlx', {})
      expect(engineBuilds.installEngineBuildWithProgress).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(
          screen.queryByText('updater:engine.title')
        ).not.toBeInTheDocument()
      )
    })

    it('waits behind a llama.cpp offer and goes ahead of the media engine', async () => {
      publish(MLX_OFFER)
      publish({ ...OFFER, provider: 'sd-cpp', targetVersion: 'master-900-abc1234' })
      const first = render(<EngineUpdateBanner />)
      expect(
        await screen.findByText('mlxvlm-macos-arm64-abc1234')
      ).toBeInTheDocument()
      first.unmount()

      publish()
      render(<EngineUpdateBanner />)
      expect(await screen.findByText('b10909-mix-bea84f7')).toBeInTheDocument()
      expect(
        screen.queryByText('mlxvlm-macos-arm64-abc1234')
      ).not.toBeInTheDocument()
    })
  })
})
