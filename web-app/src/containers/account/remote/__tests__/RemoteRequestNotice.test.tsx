import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({
  pathname: '/',
  navigate: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown
  }) => select({ location: { pathname: router.pathname } }),
}))

// Whether the window is in front, as the card and the store read it.
const win = vi.hoisted(() => ({ away: false }))
vi.mock('@/lib/notifications', () => ({
  isWindowAway: () => win.away,
  desktopNotificationsEnabled: () => true,
  showDesktopNotification: vi.fn(async () => {}),
}))

const platform = vi.hoisted(() => ({ accounts: true }))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key in platform
          ? platform[key as keyof typeof platform]
          : target[key as keyof typeof target],
    }),
  }
})

import { AUTO_COLLAPSE_MS } from '@/containers/corner/useAutoCollapse'
import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import {
  EMPTY_REMOTE_STATUS,
  type RemoteStatus,
} from '@/services/account/remote-types'
import {
  resetAccountRemoteStoreForTests,
  useAccountRemoteStore,
} from '@/stores/account-remote-store'
import { RemoteRequestNotice } from '../RemoteRequestNotice'

const DEVICES: Record<string, { name: string; code: string }> = {
  g1: { name: "Ann's iPhone", code: '123456' },
  g2: { name: 'Studio Mac', code: '654321' },
}

const asking = (...grantIds: string[]): RemoteStatus => ({
  ...EMPTY_REMOTE_STATUS,
  sharing: true,
  requests: grantIds.map((grantId) => ({
    grantId,
    deviceName: DEVICES[grantId].name,
    platform: 'ios',
    clientType: 'mobile',
    checkCode: DEVICES[grantId].code,
    createdAt: '2026-11-23T10:00:00Z',
  })),
})

const ui = () => (
  <TranslationContext.Provider value={{ t: i18n.t, i18n }}>
    <RemoteRequestNotice />
  </TranslationContext.Provider>
)

const setStatus = (status: RemoteStatus) =>
  act(() => useAccountRemoteStore.getState().setStatus(status))

const card = () => screen.queryByTestId('remote-request-notice')
const pill = () => screen.queryByTestId('remote-request-notice-mini')

beforeEach(() => {
  resetAccountRemoteStoreForTests()
  router.pathname = '/'
  router.navigate.mockReset()
  win.away = false
  platform.accounts = true
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('RemoteRequestNotice', () => {
  it('names the device and its check code on another page, and Review opens Remote models', () => {
    render(ui())
    expect(card()).toBeNull()

    setStatus(asking('g1'))

    expect(card()).not.toBeNull()
    expect(screen.getByText('Access request')).toBeTruthy()
    expect(screen.getByText("Ann's iPhone")).toBeTruthy()
    expect(screen.getByText('Check code 123456')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(router.navigate.mock.calls).toEqual([[{ to: '/account/remote' }]])
  })

  it('stays off the Remote models page, and a request seen there does not come back', () => {
    router.pathname = '/account/remote'
    const { rerender } = render(ui())
    setStatus(asking('g1'))

    expect(card()).toBeNull()
    expect(useAccountRemoteStore.getState().acknowledgedRequests).toEqual([
      'g1',
    ])

    router.pathname = '/'
    rerender(ui())
    expect(card()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('× puts the request away; another device asking brings the card back with it alone', () => {
    render(ui())
    setStatus(asking('g1'))

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(card()).toBeNull()

    setStatus(asking('g1', 'g2'))
    expect(card()).not.toBeNull()
    expect(screen.getByText('Studio Mac')).toBeTruthy()
    expect(screen.getByText('Check code 654321')).toBeTruthy()
    expect(screen.queryByText("Ann's iPhone")).toBeNull()
  })

  it('leaves once the request is allowed, denied or expired', () => {
    render(ui())
    setStatus(asking('g1', 'g2'))
    expect(screen.getByText("Ann's iPhone")).toBeTruthy()

    // g1 was decided: only g2 is left.
    setStatus(asking('g2'))
    expect(screen.queryByText("Ann's iPhone")).toBeNull()
    expect(screen.getByText('Studio Mac')).toBeTruthy()

    setStatus(EMPTY_REMOTE_STATUS)
    expect(card()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('folds into a pill, and opens again when the window comes back while the request waits', () => {
    vi.useFakeTimers()
    render(ui())
    setStatus(asking('g1'))

    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_MS)
    })
    expect(card()).toBeNull()
    expect(pill()?.getAttribute('aria-label')).toBe('Show access requests')

    // Going away does not open it; coming back does.
    win.away = true
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(card()).toBeNull()

    win.away = false
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(card()).not.toBeNull()
    expect(screen.getByText("Ann's iPhone")).toBeTruthy()
  })

  it('opens the folded card again when another device asks', () => {
    vi.useFakeTimers()
    render(ui())
    setStatus(asking('g1'))
    act(() => {
      vi.advanceTimersByTime(AUTO_COLLAPSE_MS)
    })
    expect(pill()).not.toBeNull()

    setStatus(asking('g1', 'g2'))

    expect(card()).not.toBeNull()
    expect(screen.getByText("Ann's iPhone")).toBeTruthy()
    expect(screen.getByText('Studio Mac')).toBeTruthy()
  })

  it('shows nothing without the accounts flag', () => {
    platform.accounts = false
    render(ui())
    setStatus(asking('g1'))

    expect(card()).toBeNull()
    expect(pill()).toBeNull()
  })
})
