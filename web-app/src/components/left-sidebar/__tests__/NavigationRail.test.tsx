import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const location = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => location,
  Link: ({
    children,
    to,
    ...props
  }: {
    children: React.ReactNode
    to: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({
    isMobile: false,
    setOpen: vi.fn(),
    setOpenMobile: vi.fn(),
  }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

const open = vi.hoisted(() => vi.fn())
const account = vi.hoisted(() => ({
  status: vi.fn(async () => ({ signedIn: false, user: null }) as unknown),
  onChanged: vi.fn(async () => () => {}),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open }) }),
  getServiceHub: () => ({ account: () => account }),
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

vi.mock('@/services/support/diagnostics', () => ({
  collectSupportMeta: vi.fn(async () => ({})),
  hashSupportMeta: () => 'hash',
}))

import { useSupportChatStore } from '@/stores/support-chat-store'
import { resetAccountStore } from '@/stores/account-store'
import { NavigationRail } from '../NavigationRail'

describe('NavigationRail help menu', () => {
  beforeEach(() => {
    open.mockReset()
    useSupportChatStore.setState({ sheetOpen: false, messages: [] })
    resetAccountStore()
  })

  it('lists Chat with us first, then the external help links', async () => {
    const user = userEvent.setup()
    render(<NavigationRail section="chat" />)

    await user.click(
      screen.getByRole('button', { name: 'common:navigation.help' })
    )

    const items = (await screen.findAllByRole('button')).filter((button) =>
      button.closest('[data-slot="popover-content"]')
    )
    expect(items.map((item) => item.textContent)).toEqual([
      'common:navigation.chatWithUs',
      'common:navigation.emailSupport',
      'common:navigation.discord',
      'common:navigation.newGithubIssue',
    ])

    await user.click(
      screen.getByRole('button', { name: 'common:navigation.discord' })
    )
    expect(open).toHaveBeenCalledWith('https://discord.com/invite/8wGSsvmg4V')
  })

  it('opens the support chat from Chat with us and closes the menu', async () => {
    const user = userEvent.setup()
    render(<NavigationRail section="chat" />)

    await user.click(
      screen.getByRole('button', { name: 'common:navigation.help' })
    )
    await user.click(await screen.findByTestId('help-chat-with-us'))

    expect(useSupportChatStore.getState().sheetOpen).toBe(true)
    expect(await screen.findByTestId('support-chat-sheet')).toBeInTheDocument()
    expect(screen.getByText('common:support.title')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('help-chat-with-us')).not.toBeInTheDocument()
    )
    // Focus lands in the composer, not back on the Help button.
    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'common:support.inputLabel' })
      ).toHaveFocus()
    )
    expect(open).not.toHaveBeenCalled()
  })
})

describe('NavigationRail account item', () => {
  const ada = {
    id: 'u1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    avatarUrl: null,
  }

  beforeEach(() => {
    resetAccountStore()
    platform.accounts = true
    location.pathname = '/'
    account.status.mockReset()
    account.status.mockResolvedValue({ signedIn: false, user: null })
    account.onChanged.mockClear()
  })

  it('is absent while the accounts flag is off', () => {
    platform.accounts = false
    render(<NavigationRail section="chat" />)

    expect(screen.queryByTestId('rail-account')).not.toBeInTheDocument()
    expect(account.status).not.toHaveBeenCalled()
  })

  it('links to the Account section and comes first in the bottom group', async () => {
    render(<NavigationRail section="chat" />)

    const item = screen.getByTestId('rail-account')
    expect(item).toHaveAttribute('href', '/account/')
    expect(item).not.toHaveAttribute('aria-current')
    expect(item.parentElement?.firstElementChild).toBe(item)
    await waitFor(() => expect(account.status).toHaveBeenCalledTimes(1))
    expect(account.onChanged).toHaveBeenCalledTimes(1)
  })

  it('shows the sign-in icon while signed out', async () => {
    render(<NavigationRail section="chat" />)

    const item = screen.getByTestId('rail-account')
    await waitFor(() => expect(account.status).toHaveBeenCalled())
    expect(item).toHaveAttribute('aria-label', 'common:navigation.signIn')
    expect(item.querySelector('.lucide-circle-user-round')).not.toBeNull()
    expect(screen.queryByTestId('account-avatar')).not.toBeInTheDocument()
  })

  it('shows the avatar with initials once signed in', async () => {
    account.status.mockResolvedValue({ signedIn: true, user: ada })
    render(<NavigationRail section="chat" />)

    const avatar = await screen.findByTestId('account-avatar')
    const item = screen.getByTestId('rail-account')
    expect(item).toContainElement(avatar)
    expect(avatar).toHaveTextContent('AL')
    expect(item).toHaveAttribute('aria-label', 'common:navigation.account')
    expect(item.querySelector('.lucide-circle-user-round')).toBeNull()
  })

  it('is the lit item while the Account section is open', async () => {
    location.pathname = '/account/'
    render(<NavigationRail section="account" />)

    expect(screen.getByTestId('rail-account')).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByTestId('rail-settings')).not.toHaveAttribute(
      'aria-current'
    )
    await waitFor(() => expect(account.status).toHaveBeenCalled())
  })
})
