import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
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
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open }) }),
}))

vi.mock('@/services/support/diagnostics', () => ({
  collectSupportMeta: vi.fn(async () => ({})),
  hashSupportMeta: () => 'hash',
}))

import { useSupportChatStore } from '@/stores/support-chat-store'
import { NavigationRail } from '../NavigationRail'

describe('NavigationRail help menu', () => {
  beforeEach(() => {
    open.mockReset()
    useSupportChatStore.setState({ sheetOpen: false, messages: [] })
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
