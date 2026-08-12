import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import SettingsMenu from '../SettingsMenu'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

// Mock global platform constants - simulate desktop (Tauri) environment
Object.defineProperty(global, 'IS_IOS', { value: false, writable: true })
Object.defineProperty(global, 'IS_ANDROID', { value: false, writable: true })
Object.defineProperty(global, 'IS_WEB_APP', { value: false, writable: true })

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: vi.fn(() => ({ settingsMode: 'base' })),
}))

describe('SettingsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useGeneralSetting).mockReturnValue({ settingsMode: 'base' })
  })

  it('renders only the consumer-facing menu items in base mode', () => {
    render(<SettingsMenu />)

    expect(screen.getByText('common:general')).toBeInTheDocument()
    expect(screen.getByText('common:assistants')).toBeInTheDocument()
    expect(screen.getByText('common:mcp-servers')).toBeInTheDocument()

    expect(screen.queryByText('common:attachments')).not.toBeInTheDocument()
    expect(
      screen.queryByText('common:keyboardShortcuts')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('common:hardware')).not.toBeInTheDocument()
    expect(screen.queryByText('common:https_proxy')).not.toBeInTheDocument()
  })

  it('renders the advanced menu items in advanced mode', () => {
    vi.mocked(useGeneralSetting).mockReturnValue({ settingsMode: 'advanced' })

    render(<SettingsMenu />)

    expect(screen.getByText('common:attachments')).toBeInTheDocument()
    expect(screen.getByText('common:keyboardShortcuts')).toBeInTheDocument()
    expect(screen.getByText('common:hardware')).toBeInTheDocument()
    expect(screen.getByText('common:https_proxy')).toBeInTheDocument()
  })

  it('never renders removed or hidden menu items', () => {
    vi.mocked(useGeneralSetting).mockReturnValue({ settingsMode: 'advanced' })

    render(<SettingsMenu />)

    expect(screen.queryByText('common:interface')).not.toBeInTheDocument()
    expect(screen.queryByText('common:privacy')).not.toBeInTheDocument()
    expect(
      screen.queryByText('common:local_api_server')
    ).not.toBeInTheDocument()
  })

  // Providers used to be enumerated here, one row per engine and per connected
  // cloud. They now live behind the Local/Cloud tabs of the Model Providers
  // page, so the menu is a flat list and never depends on the provider store.
  it('links Model Providers as a single entry right after MCP Servers', () => {
    render(<SettingsMenu />)

    const entry = screen.getByText('common:modelProviders')
    expect(entry.closest('a')).toHaveAttribute('href', '/settings/providers')

    const labels = screen
      .getAllByRole('link')
      .map((link) => link.textContent?.trim())
    expect(labels.slice(-2)).toEqual([
      'common:mcp-servers',
      'common:modelProviders',
    ])

    expect(screen.queryByText('provider:local')).not.toBeInTheDocument()
    expect(screen.queryByText('provider:cloud')).not.toBeInTheDocument()
  })
})
