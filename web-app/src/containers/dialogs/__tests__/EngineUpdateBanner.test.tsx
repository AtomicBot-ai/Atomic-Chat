import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EngineUpdateBanner from '@/containers/dialogs/EngineUpdateBanner'
import {
  engineUpdateOfferKey,
  isEngineUpdateSnoozed,
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
})
