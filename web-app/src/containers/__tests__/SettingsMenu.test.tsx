import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsNavigation } from '../SettingsMenu'
import { useLocation } from '@tanstack/react-router'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

// Mock global platform constants - simulate desktop (Tauri) environment
Object.defineProperty(global, 'IS_IOS', { value: false, writable: true })
Object.defineProperty(global, 'IS_ANDROID', { value: false, writable: true })
Object.defineProperty(global, 'IS_WEB_APP', { value: false, writable: true })

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode
    to: string
    params?: Record<string, string>
    className?: string
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (href, [key, value]) => href.replace(`$${key}`, value),
        to
      )}
      className={className}
    >
      {children}
    </a>
  ),
  useLocation: vi.fn(),
}))

// Plain stand-ins for the sidebar primitives: rows keep their active flag so
// highlighting can be asserted without a SidebarProvider.
vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({
    children,
    asChild,
    isActive,
    ...props
  }: {
    children: React.ReactElement
    asChild?: boolean
    isActive?: boolean
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    asChild ? (
      <span data-active={isActive ? 'true' : 'false'}>{children}</span>
    ) : (
      <button data-active={isActive ? 'true' : 'false'} {...props}>
        {children}
      </button>
    ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: vi.fn(),
}))

const setLocation = (pathname: string) =>
  vi
    .mocked(useLocation)
    .mockReturnValue({ pathname } as ReturnType<typeof useLocation>)

describe('SettingsNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocation('/settings/general')
    vi.mocked(useGeneralSetting).mockImplementation(((
      selector: (state: { connectorsBadgeSeen: boolean }) => unknown
    ) => selector({ connectorsBadgeSeen: true })) as never)
  })

  it('lists the app preferences and the workspace pages', () => {
    render(<SettingsNavigation />)

    for (const label of [
      'common:general',
      'common:attachments',
      'common:interface',
      'common:keyboardShortcuts',
      'common:hardware',
      'common:navigation.workspace',
      'common:assistants',
      'common:navigation.mcpConnectors',
      'common:skills',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('leaves engine, server and model pages to their own sections', () => {
    render(<SettingsNavigation />)

    // Voice and Media live under Models Hub's inference engines, HTTPS Proxy
    // under Server.
    expect(screen.queryByText('common:voice')).not.toBeInTheDocument()
    expect(screen.queryByText('common:media')).not.toBeInTheDocument()
    expect(screen.queryByText('common:https_proxy')).not.toBeInTheDocument()
    expect(screen.queryByText('common:modelProviders')).not.toBeInTheDocument()
    expect(screen.queryByText('common:privacy')).not.toBeInTheDocument()
  })

  it('highlights the open page', () => {
    setLocation('/settings/hardware')
    render(<SettingsNavigation />)

    expect(
      screen.getByText('common:hardware').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
    expect(
      screen.getByText('common:general').closest('[data-active]')
    ).toHaveAttribute('data-active', 'false')
  })

  it('keeps the connectors "New" badge until the page is seen', () => {
    vi.mocked(useGeneralSetting).mockImplementation(((
      selector: (state: { connectorsBadgeSeen: boolean }) => unknown
    ) => selector({ connectorsBadgeSeen: false })) as never)
    render(<SettingsNavigation />)

    expect(screen.getByText('common:newBadge')).toBeInTheDocument()
  })
})
