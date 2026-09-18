import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DialogAppUpdater from '@/containers/dialogs/AppUpdater'
import type { UpdateState } from '@/hooks/useAppUpdater'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const downloadAndInstallUpdate = vi.fn()
const setRemindMeLater = vi.fn()
const open = vi.fn()

let updateState: UpdateState

// Like the real hook, `remindMeLater` is component state: setting it
// re-renders the banner, so the tests can watch the banner actually go away
// (and give the corner back) instead of only watching the setter get called.
vi.mock('@/hooks/useAppUpdater', () => ({
  useAppUpdater: () => {
    const [remindMeLater, setRemind] = useState(updateState.remindMeLater)
    return {
      updateState: { ...updateState, remindMeLater },
      downloadAndInstallUpdate,
      setRemindMeLater: (remind: boolean) => {
        setRemindMeLater(remind)
        setRemind(remind)
      },
    }
  },
}))

const banner = () => screen.queryByTestId('app-update-banner')
const appClaimsCorner = () => useUpdateBannerSlots.getState().claimed.app

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open }) }),
}))

const RELEASE_BODY = `## 🚀 New Features

- Windows support — Atomic Chat is now available on Windows
- Image generation. Run Stable Diffusion locally
- Voice input — dictate straight into the composer
- Projects — group threads and files together
- Agent skills. Teach the agent repeatable workflows
`

const baseState = (): UpdateState => ({
  isUpdateAvailable: true,
  updateInfo: { version: '2.0.38', body: RELEASE_BODY },
  isDownloading: false,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  remindMeLater: false,
  currentVersion: '2.0.37',
})

describe('DialogAppUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    open.mockResolvedValue(undefined)
    updateState = baseState()
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: false, engine: false },
    })
  })

  it('renders nothing when no update is available', () => {
    updateState = { ...baseState(), isUpdateAvailable: false }
    const { container } = render(<DialogAppUpdater />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays down once the user has asked to be reminded later', () => {
    updateState = { ...baseState(), remindMeLater: true }
    const { container } = render(<DialogAppUpdater />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the version transition and a changelog preview', () => {
    render(<DialogAppUpdater />)

    expect(screen.getByText('updater:app.title')).toBeInTheDocument()
    expect(screen.getByText('2.0.37')).toBeInTheDocument()
    expect(screen.getByText('2.0.38')).toBeInTheDocument()
    expect(screen.getByText('updater:app.subtitle')).toBeInTheDocument()

    // Four bullets fit; the fifth collapses into the "+N more" line.
    expect(screen.getByText('Windows support')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.queryByText('Agent skills.')).not.toBeInTheDocument()
    expect(screen.getByText('updater:app.moreHighlights')).toBeInTheDocument()
  })

  it('omits the changelog block when the release carries no bullets', () => {
    updateState = {
      ...baseState(),
      updateInfo: { version: '2.0.38', body: 'Maintenance release.' },
    }
    render(<DialogAppUpdater />)

    expect(screen.getByText('updater:app.title')).toBeInTheDocument()
    expect(
      screen.queryByText('updater:app.moreHighlights')
    ).not.toBeInTheDocument()
  })

  it('renders the target version alone when the current one is unknown', () => {
    updateState = { ...baseState(), currentVersion: '' }
    render(<DialogAppUpdater />)

    expect(screen.getByText('2.0.38')).toBeInTheDocument()
    expect(screen.queryByText('2.0.37')).not.toBeInTheDocument()
  })

  it('installs on "Update" and puts the banner away', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)
    expect(appClaimsCorner()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(downloadAndInstallUpdate).toHaveBeenCalledTimes(1)
    expect(setRemindMeLater).toHaveBeenCalledWith(true)
    expect(banner()).not.toBeInTheDocument()
    // Hidden, it gives the corner back so the engine offer can surface.
    expect(appClaimsCorner()).toBe(false)
  })

  it('puts the banner away on "Remind me later" and on the ×', async () => {
    const user = userEvent.setup()
    const first = render(<DialogAppUpdater />)

    await user.click(
      screen.getByRole('button', { name: 'updater:remindMeLater' })
    )
    expect(banner()).not.toBeInTheDocument()
    expect(appClaimsCorner()).toBe(false)

    first.unmount()
    render(<DialogAppUpdater />)
    expect(appClaimsCorner()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'updater:dismiss' }))
    expect(banner()).not.toBeInTheDocument()
    expect(appClaimsCorner()).toBe(false)

    expect(setRemindMeLater).toHaveBeenCalledTimes(2)
    expect(setRemindMeLater).toHaveBeenNthCalledWith(1, true)
    expect(setRemindMeLater).toHaveBeenNthCalledWith(2, true)
    expect(downloadAndInstallUpdate).not.toHaveBeenCalled()
  })

  it('opens the GitHub release page for the new version and leaves the offer up', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    await user.click(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    )

    expect(open).toHaveBeenCalledWith(
      'https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v2.0.38'
    )
    // Reading the notes is not an answer to the offer.
    expect(banner()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'updater:update' })).toBeEnabled()
    expect(appClaimsCorner()).toBe(true)
    expect(setRemindMeLater).not.toHaveBeenCalled()
  })

  it('disables "Update" while the download runs', () => {
    updateState = { ...baseState(), isDownloading: true }
    render(<DialogAppUpdater />)

    expect(
      screen.getByRole('button', { name: 'updater:downloading' })
    ).toBeDisabled()
  })

  it('outranks the engine banner but yields to a running download', () => {
    useUpdateBannerSlots.setState({
      claimed: { download: true, app: false, engine: false },
    })
    const { container } = render(<DialogAppUpdater />)
    expect(container).toBeEmptyDOMElement()
  })
})
