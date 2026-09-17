import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DialogAppUpdater from '@/containers/dialogs/AppUpdater'
import type { UpdateState } from '@/hooks/useAppUpdater'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const downloadAndInstallUpdate = vi.fn()
const setRemindMeLater = vi.fn()
const open = vi.fn()

let updateState: UpdateState

vi.mock('@/hooks/useAppUpdater', () => ({
  useAppUpdater: () => ({
    updateState,
    downloadAndInstallUpdate,
    setRemindMeLater,
  }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open }) }),
}))

const RELEASE_BODY = `Atomic Chat 2.0.38 brings the desktop app to Windows and adds local image generation.

## 🚀 New Features

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

  it('shows a wider version transition and changelog without a redundant subtitle', () => {
    render(<DialogAppUpdater />)

    expect(screen.getByTestId('app-update-banner')).toHaveClass(
      'w-[min(27rem,calc(100vw-1rem))]',
      'bottom-[calc(1rem+var(--download-panel-offset,0px))]',
      'z-[70]',
      'transition-[bottom]'
    )
    expect(screen.getByText('updater:app.title')).toBeInTheDocument()
    expect(screen.getByText('2.0.37')).toBeInTheDocument()
    expect(screen.getByText('2.0.38')).toBeInTheDocument()
    expect(screen.queryByText('updater:app.subtitle')).not.toBeInTheDocument()

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

  it('installs on "Update"', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(downloadAndInstallUpdate).toHaveBeenCalledTimes(1)
    expect(setRemindMeLater).toHaveBeenCalledWith(true)
  })

  it('puts the banner away on "Remind me later" and on the ×', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    await user.click(
      screen.getByRole('button', { name: 'updater:remindMeLater' })
    )
    await user.click(screen.getByRole('button', { name: 'updater:dismiss' }))

    expect(setRemindMeLater).toHaveBeenCalledTimes(2)
    expect(setRemindMeLater).toHaveBeenNthCalledWith(1, true)
    expect(setRemindMeLater).toHaveBeenNthCalledWith(2, true)
    expect(downloadAndInstallUpdate).not.toHaveBeenCalled()
  })

  it('unfolds the full release notes in place on "Show release notes"', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    // The intro paragraph is not a bullet, so it never makes the preview.
    const intro =
      'Atomic Chat 2.0.38 brings the desktop app to Windows and adds local image generation.'
    expect(screen.queryByText(intro)).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    )

    expect(screen.getByText(intro)).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '🚀 New Features' })
    ).toBeInTheDocument()
    // The fifth bullet, hidden behind "+1 more" in the preview, is in full.
    expect(
      screen.getByText('Agent skills. Teach the agent repeatable workflows')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('updater:app.moreHighlights')
    ).not.toBeInTheDocument()

    // The toggle flips, the header and the actions stay put, and nothing
    // left the app.
    expect(
      screen.getByRole('button', { name: 'updater:hideReleaseNotes' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:openRelease' })
    ).toBeInTheDocument()
    expect(screen.getByText('updater:app.title')).toBeInTheDocument()
    expect(screen.getByText('2.0.37')).toBeInTheDocument()
    expect(screen.getByText('2.0.38')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:remindMeLater' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:update' })
    ).toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })

  it('"Open release" opens the GitHub release page for the new version', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    await user.click(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    )
    await user.click(
      screen.getByRole('button', { name: 'updater:openRelease' })
    )

    expect(open).toHaveBeenCalledWith(
      'https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v2.0.38'
    )
    // Opening the page does not fold the notes back.
    expect(
      screen.getByRole('button', { name: 'updater:hideReleaseNotes' })
    ).toBeInTheDocument()
  })

  it('folds back to the highlights preview on "Hide release notes"', async () => {
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    await user.click(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    )
    await user.click(
      screen.getByRole('button', { name: 'updater:hideReleaseNotes' })
    )

    expect(
      screen.queryByText(
        'Atomic Chat 2.0.38 brings the desktop app to Windows and adds local image generation.'
      )
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'updater:openRelease' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Windows support')).toBeInTheDocument()
    expect(screen.getByText('updater:app.moreHighlights')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:remindMeLater' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'updater:update' })
    ).toBeInTheDocument()
  })

  it('opens the GitHub release page directly when the release has no body', async () => {
    updateState = {
      ...baseState(),
      updateInfo: { version: '2.0.38', body: '' },
    }
    const user = userEvent.setup()
    render(<DialogAppUpdater />)

    await user.click(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    )

    expect(open).toHaveBeenCalledWith(
      'https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v2.0.38'
    )
    // Nothing to unfold: the toggle keeps its label and no link appears.
    expect(
      screen.getByRole('button', { name: 'updater:showReleaseNotes' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'updater:openRelease' })
    ).not.toBeInTheDocument()
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
