import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLocation } from '@tanstack/react-router'
import { NavMain } from '../NavMain'

// A forwardRef stub for the animated icons (NavMain attaches a ref to them).
const { IconStub } = vi.hoisted(() => {
  const React = require('react')
  return { IconStub: React.forwardRef(() => null) }
})

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: any) => (
    <a href={typeof to === 'string' ? to : '#'} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: vi.fn(),
}))

// Surface `isActive` as `data-active` so the test asserts the wiring.
vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children, isActive }: any) => (
    <div data-testid="nav-button" data-active={String(!!isActive)}>
      {children}
    </div>
  ),
}))

vi.mock('@/components/ui/kbd', () => ({
  Kbd: ({ children }: any) => <span>{children}</span>,
  KbdGroup: ({ children }: any) => <span>{children}</span>,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/PlatformMetaKey', () => ({ PlatformMetaKey: () => null }))
vi.mock('@/components/animated-icon/search', () => ({ SearchIcon: IconStub }))
vi.mock('@/components/animated-icon/folder-plus', () => ({
  FolderPlusIcon: IconStub,
}))
vi.mock('@/components/animated-icon/message-circle', () => ({
  MessageCircleIcon: IconStub,
}))
vi.mock('@/components/animated-icon/settings', () => ({
  SettingsIcon: IconStub,
}))
vi.mock('@/components/animated-icon/blocks', () => ({ BlocksIcon: IconStub }))
vi.mock('@/components/animated-icon/bot', () => ({ BotIcon: IconStub }))

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => null,
}))

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ addFolder: vi.fn() }),
}))
vi.mock('@/hooks/useSearchDialog', () => ({
  useSearchDialog: () => ({ open: false, setOpen: vi.fn() }),
}))
vi.mock('@/hooks/useProjectDialog', () => ({
  useProjectDialog: () => ({ open: false, setOpen: vi.fn() }),
}))
vi.mock('@/hooks/useAgentMode', () => ({
  useAgentMode: {
    getState: () => ({ removeThread: vi.fn(), setAgentMode: vi.fn() }),
  },
}))
vi.mock('@/constants/chat', () => ({ TEMPORARY_CHAT_ID: 'temp' }))
vi.mock('@/lib/shortcuts', () => ({
  ShortcutAction: {
    NEW_CHAT: 'NEW_CHAT',
    NEW_AGENT_CHAT: 'NEW_AGENT_CHAT',
    NEW_PROJECT: 'NEW_PROJECT',
    SEARCH: 'SEARCH',
  },
  PlatformShortcuts: new Proxy({}, { get: () => ({ key: 'k' }) }),
}))

const buttonFor = (label: string) =>
  screen.getByText(label).closest('[data-testid="nav-button"]')

describe('NavMain active highlight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('highlights Settings across its sub-pages, not the action items', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/settings/privacy',
    } as never)

    render(<NavMain />)

    expect(buttonFor('common:settings')).toHaveAttribute('data-active', 'true')
    expect(buttonFor('common:models')).toHaveAttribute('data-active', 'false')
    expect(buttonFor('common:launch')).toHaveAttribute('data-active', 'false')
    // Action items (no route) never highlight.
    expect(buttonFor('common:newChat')).toHaveAttribute('data-active', 'false')
  })

  it('highlights Models on the hub route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/hub/' } as never)

    render(<NavMain />)

    expect(buttonFor('common:models')).toHaveAttribute('data-active', 'true')
    expect(buttonFor('common:settings')).toHaveAttribute('data-active', 'false')
  })

  it('highlights Integrations on the launch route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/launch/' } as never)

    render(<NavMain />)

    expect(buttonFor('common:launch')).toHaveAttribute('data-active', 'true')
    expect(buttonFor('common:models')).toHaveAttribute('data-active', 'false')
  })
})
