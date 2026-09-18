import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { PlatformFeature } from '@/lib/platform/types'

const { features } = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
}))

// Everything the desktop build has, with the one flag under test switchable.
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  Object.assign(features, actual.PlatformFeatures)
  return { PlatformFeatures: features }
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useMatches: () => [{ routeId: '/settings/general', params: {} }],
  useNavigate: () => vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ providers: [], selectedProvider: undefined }),
}))

import SettingsMenu from '../SettingsMenu'

const remoteLanLink = () =>
  screen.queryByRole('link', { name: /common:remote_lan/ })

describe('SettingsMenu — Remote & LAN', () => {
  beforeEach(() => {
    localStorage.clear()
    features[PlatformFeature.LOCAL_API_SERVER] = true
    useGeneralSetting.setState({ remoteLanBadgeSeen: false })
  })

  it('lists the page right after HTTPS Proxy', () => {
    render(<SettingsMenu />)

    const link = remoteLanLink()
    expect(link).toHaveAttribute('href', '/settings/remote-lan')

    const titles = screen
      .getAllByRole('link')
      .map((item) => item.getAttribute('href'))
    expect(titles.indexOf('/settings/remote-lan')).toBe(
      titles.indexOf('/settings/https-proxy') + 1
    )
  })

  it('wears a "New" pill until the page has been opened', () => {
    render(<SettingsMenu />)

    expect(
      within(remoteLanLink()!).getByText('common:newBadge')
    ).toBeInTheDocument()
    // The pill belongs to this item only.
    expect(screen.getAllByText('common:newBadge')).toHaveLength(1)

    // What the page does on mount.
    act(() => {
      useGeneralSetting.getState().markRemoteLanBadgeSeen()
    })

    expect(remoteLanLink()).toBeInTheDocument()
    expect(screen.queryByText('common:newBadge')).not.toBeInTheDocument()
  })

  it('stays without the pill for someone who has already been there', () => {
    useGeneralSetting.setState({ remoteLanBadgeSeen: true })

    render(<SettingsMenu />)

    expect(remoteLanLink()).toBeInTheDocument()
    expect(screen.queryByText('common:newBadge')).not.toBeInTheDocument()
  })

  it('is hidden where there is no Local API Server to expose', () => {
    features[PlatformFeature.LOCAL_API_SERVER] = false

    render(<SettingsMenu />)

    expect(remoteLanLink()).not.toBeInTheDocument()
    expect(screen.queryByText('common:newBadge')).not.toBeInTheDocument()
    // The rest of the menu is untouched.
    expect(
      screen.getByRole('link', { name: 'common:https_proxy' })
    ).toBeInTheDocument()
  })
})
