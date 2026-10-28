import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => 'granted'),
}))

import { requestPermission } from '@tauri-apps/plugin-notification'
import { useThreadNotifications } from '@/hooks/useThreadNotifications'
import {
  isWindowAway,
  notifyUnlessWatching,
  requestNotificationPermission,
} from '../notifications'

// Tests build with IS_TAURI = false: the first-run step must not prompt, nor
// claim access, where there is no OS to ask.
describe('notification permission outside the desktop app', () => {
  it('reports no access and never prompts', async () => {
    await expect(requestNotificationPermission()).resolves.toBe(false)
    expect(requestPermission).not.toHaveBeenCalled()
  })
})

describe('notifyUnlessWatching', () => {
  let focused: boolean
  let visibility: DocumentVisibilityState

  beforeEach(() => {
    focused = false
    visibility = 'visible'
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility
    )
    useThreadNotifications.setState({ globallyEnabled: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('notifies while another app is in front, even about the page on screen', () => {
    expect(isWindowAway()).toBe(true)
    expect(notifyUnlessWatching(true, 'Video ready', 'Your clip')).toBe(true)
  })

  it('stays quiet while the user looks at the thing in a focused window', () => {
    focused = true
    expect(isWindowAway()).toBe(false)
    expect(notifyUnlessWatching(true, 'Images ready', '2 new images')).toBe(
      false
    )
  })

  it('notifies a focused window about something it does not show', () => {
    focused = true
    expect(
      notifyUnlessWatching(false, 'Model downloaded', 'Qwen3 is ready')
    ).toBe(true)
  })

  it('notifies for a hidden or minimized window even if it reports focus', () => {
    focused = true
    visibility = 'hidden'
    expect(notifyUnlessWatching(true, 'Video ready', 'Your clip')).toBe(true)
  })

  it('respects the Settings switch', () => {
    useThreadNotifications.setState({ globallyEnabled: false })
    expect(
      notifyUnlessWatching(false, 'Model downloaded', 'Qwen3 is ready')
    ).toBe(false)
  })

  it('treats a switch lost in rehydration as on', () => {
    useThreadNotifications.setState({
      globallyEnabled: undefined as unknown as boolean,
    })
    expect(notifyUnlessWatching(true, 'Images ready', '2 new images')).toBe(
      true
    )
  })
})
