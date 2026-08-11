import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import SettingsMenu from '../SettingsMenu'
import { useNavigate, useMatches } from '@tanstack/react-router'
import { useModelProvider } from '@/hooks/useModelProvider'
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
  useMatches: vi.fn(),
  useNavigate: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: vi.fn(() => ({ settingsMode: 'base' })),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(() => ({
    providers: [
      {
        provider: 'openai',
        active: true,
        models: [],
      },
      {
        provider: 'llama.cpp',
        active: true,
        models: [],
      },
    ],
    addProvider: vi.fn(),
  })),
}))

vi.mock('@/containers/dialogs', () => ({
  AddCloudProviderDialog: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  getProviderTitle: (provider: string) => provider,
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: any }) => (
    <div data-testid={`provider-avatar-${provider.provider}`}>
      {provider.provider}
    </div>
  ),
}))

describe('SettingsMenu', () => {
  const mockNavigate = vi.fn()
  const mockMatches = [
    {
      routeId: '/settings/general',
      params: {},
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(useNavigate).mockReturnValue(mockNavigate)
    vi.mocked(useMatches).mockReturnValue(mockMatches)
    vi.mocked(useGeneralSetting).mockReturnValue({ settingsMode: 'base' })
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'openai', active: true, models: [] },
        { provider: 'llama.cpp', active: true, models: [] },
      ],
      addProvider: vi.fn(),
    })
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

  it('shows provider expansion chevron when providers are active', () => {
    render(<SettingsMenu />)

    // There should be at least one button (the chevron)
    const chevronButtons = screen.getAllByRole('button')
    expect(chevronButtons.length).toBeGreaterThan(0)
  })

  it('shows expanded providers by default', () => {
    render(<SettingsMenu />)

    // Providers ARE expanded by default (expandedProviders starts as true)
    expect(screen.getByTestId('provider-avatar-openai')).toBeInTheDocument()
  })

  it('splits the provider list into a local and a cloud section', () => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'openai', active: true, models: [] },
      ],
      addProvider: vi.fn(),
    })

    render(<SettingsMenu />)

    expect(screen.getByText('provider:local')).toBeInTheDocument()
    expect(screen.getByText('provider:cloud')).toBeInTheDocument()
    expect(
      screen.getByTestId('provider-avatar-llamacpp-upstream')
    ).toBeInTheDocument()
    expect(screen.getByTestId('provider-avatar-openai')).toBeInTheDocument()
  })

  it('auto-expands providers when on provider route', () => {
    vi.mocked(useMatches).mockReturnValue([
      {
        routeId: '/settings/providers/$providerName',
        params: { providerName: 'openai' },
      },
    ])

    render(<SettingsMenu />)

    expect(screen.getByTestId('provider-avatar-openai')).toBeInTheDocument()
  })

  it('highlights active provider in submenu', () => {
    vi.mocked(useMatches).mockReturnValue([
      {
        routeId: '/settings/providers/$providerName',
        params: { providerName: 'openai' },
      },
    ])

    render(<SettingsMenu />)

    const openaiProvider = screen
      .getByTestId('provider-avatar-openai')
      .closest('div')
    expect(openaiProvider).toBeInTheDocument()
  })

  it('navigates to provider when provider is clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsMenu />)

    // Providers are expanded by default, click directly on a provider
    const openaiProvider = screen
      .getByTestId('provider-avatar-openai')
      .closest('div[class*="cursor-pointer"]')
    await user.click(openaiProvider!)

    expect(mockNavigate).toHaveBeenCalled()
  })

  it('highlights the clicked provider before the route match catches up', async () => {
    const user = userEvent.setup()
    render(<SettingsMenu />)

    const row = (provider: string) =>
      screen
        .getByTestId(`provider-avatar-${provider}`)
        .closest('div[class*="cursor-pointer"]')!

    expect(row('openai').className).not.toContain('bg-foreground/20')

    // `useMatches` keeps reporting the old route, standing in for a navigation
    // transition that has not committed yet.
    await user.click(row('openai'))

    expect(row('openai').className).toContain('bg-foreground/20')
    expect(row('llama.cpp').className).not.toContain('bg-foreground/20')
  })

  it('drops the optimistic highlight once the route resolves elsewhere', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<SettingsMenu />)

    const row = (provider: string) =>
      screen
        .getByTestId(`provider-avatar-${provider}`)
        .closest('div[class*="cursor-pointer"]')!

    await user.click(row('openai'))
    expect(row('openai').className).toContain('bg-foreground/20')

    vi.mocked(useMatches).mockReturnValue([
      { routeId: '/settings/providers/$providerName', params: { providerName: 'llama.cpp' } },
    ])
    rerender(<SettingsMenu />)

    expect(row('openai').className).not.toContain('bg-foreground/20')
    expect(row('llama.cpp').className).toContain('bg-foreground/20')
  })

  it('hides llama.cpp during setup remote provider step', () => {
    vi.mocked(useMatches).mockReturnValue([
      {
        routeId: '/settings/providers/',
        params: {},
        search: { step: 'setup_remote_provider' },
      },
    ])

    render(<SettingsMenu />)

    // openai should be visible during remote provider setup
    expect(screen.getByTestId('provider-avatar-openai')).toBeInTheDocument()

    // llama.cpp should have 'hidden' class during setup_remote_provider step
    const llamaCpp = screen
      .getByTestId('provider-avatar-llama.cpp')
      .closest('div[class*="cursor-pointer"]')
    expect(llamaCpp?.className).toContain('hidden')
  })

  it('keeps disabled local engines listed but hides unadded clouds', () => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: false, models: [] },
        { provider: 'openai', active: true, models: [] },
        { provider: 'anthropic', active: false, models: [] },
      ],
      addProvider: vi.fn(),
    })

    render(<SettingsMenu />)

    // A local engine stays on the menu even when switched off, so it can be
    // switched back on.
    expect(
      screen.getByTestId('provider-avatar-llamacpp-upstream')
    ).toBeInTheDocument()
    expect(screen.getByTestId('provider-avatar-openai')).toBeInTheDocument()
    // An unconnected cloud provider lives in the "Add provider" catalog.
    expect(
      screen.queryByTestId('provider-avatar-anthropic')
    ).not.toBeInTheDocument()
  })
})
