import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import SettingsMenu from '../SettingsMenu'
import { useNavigate, useMatches } from '@tanstack/react-router'
import { useModelProvider } from '@/hooks/useModelProvider'

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
  useGeneralSetting: vi.fn(() => ({})),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(() => ({
    providers: [
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [],
      },
      {
        provider: 'llamacpp',
        active: true,
        models: [],
      },
    ],
    addProvider: vi.fn(),
  })),
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
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'llamacpp', active: true, models: [] },
      ],
      addProvider: vi.fn(),
    })
  })

  it('renders all menu items', () => {
    render(<SettingsMenu />)

    expect(screen.getByText('common:general')).toBeInTheDocument()
    expect(screen.getByText('common:attachments')).toBeInTheDocument()
    expect(screen.getByText('common:voice')).toBeInTheDocument()
    expect(screen.getByText('common:interface')).toBeInTheDocument()
    expect(screen.getByText('common:assistants')).toBeInTheDocument()
    expect(screen.queryByText('common:privacy')).not.toBeInTheDocument()
  })

  it('renders keyboard shortcuts and other settings', () => {
    render(<SettingsMenu />)
    expect(screen.getByText('common:keyboardShortcuts')).toBeInTheDocument()
    expect(screen.getByText('common:hardware')).toBeInTheDocument()
    expect(
      screen.queryByText('common:local_api_server')
    ).not.toBeInTheDocument()
    expect(screen.getByText('common:https_proxy')).toBeInTheDocument()
    // MCP moved to the top-level Connectors page.
    expect(screen.queryByText('common:mcp-servers')).not.toBeInTheDocument()
  })

  it('shows the expansion chevron only when a provider is disabled', () => {
    // No disabled provider: nothing to expand, and no other button in the
    // section since the add-provider `+` moved to `/cloud`.
    const { unmount } = render(<SettingsMenu />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    unmount()

    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'foundation-models', active: false, models: [] },
      ],
      addProvider: vi.fn(),
    })
    render(<SettingsMenu />)
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
  })

  it('shows expanded providers by default', () => {
    render(<SettingsMenu />)

    // Providers ARE expanded by default (expandedProviders starts as true)
    expect(screen.getByTestId('provider-avatar-llamacpp-upstream')).toBeInTheDocument()
  })

  it('collapses disabled providers section when toggle is clicked', async () => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'foundation-models', active: false, models: [] },
      ],
      addProvider: vi.fn(),
    })

    const user = userEvent.setup()
    render(<SettingsMenu />)

    // Disabled section is expanded by default — anthropic is visible
    expect(screen.getByTestId('provider-avatar-foundation-models')).toBeInTheDocument()

    // Click the toggle to collapse the disabled section
    const toggleButton = screen.getByText('common:hiddenProviders')
    await user.click(toggleButton)

    // After collapsing, anthropic should be hidden
    expect(
      screen.queryByTestId('provider-avatar-foundation-models')
    ).not.toBeInTheDocument()
  })

  it('auto-expands providers when on provider route', () => {
    vi.mocked(useMatches).mockReturnValue([
      {
        routeId: '/settings/providers/$providerName',
        params: { providerName: 'llamacpp-upstream' },
      },
    ])

    render(<SettingsMenu />)

    expect(screen.getByTestId('provider-avatar-llamacpp-upstream')).toBeInTheDocument()
  })

  it('highlights active provider in submenu', () => {
    vi.mocked(useMatches).mockReturnValue([
      {
        routeId: '/settings/providers/$providerName',
        params: { providerName: 'llamacpp-upstream' },
      },
    ])

    render(<SettingsMenu />)

    const upstreamProvider = screen
      .getByTestId('provider-avatar-llamacpp-upstream')
      .closest('div')
    expect(upstreamProvider).toBeInTheDocument()
  })

  it('navigates to provider when provider is clicked', async () => {
    const user = userEvent.setup()
    render(<SettingsMenu />)

    // Providers are expanded by default, click directly on a provider
    const upstreamProvider = screen
      .getByTestId('provider-avatar-llamacpp-upstream')
      .closest('div[class*="cursor-pointer"]')
    await user.click(upstreamProvider!)

    expect(mockNavigate).toHaveBeenCalled()
  })

  it('lists no cloud provider', () => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'openai', active: true, models: [] },
        { provider: 'ollama', active: true, models: [], base_url: 'http://localhost:11434/v1' },
        { provider: 'my-custom', active: false, models: [] },
      ],
      addProvider: vi.fn(),
    })

    render(<SettingsMenu />)

    expect(
      screen.getByTestId('provider-avatar-llamacpp-upstream')
    ).toBeInTheDocument()
    // Connecting these lives on `/cloud` now.
    expect(screen.queryByTestId('provider-avatar-openai')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-avatar-ollama')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('provider-avatar-my-custom')
    ).not.toBeInTheDocument()
  })

  it('lists turboquant below upstream, never first', () => {
    // IS_MACOS is false under vitest, so this is the Windows/Linux list —
    // mlx is filtered out and turboquant collapses under upstream.
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp', active: true, models: [] },
        { provider: 'llamacpp-upstream', active: true, models: [] },
      ],
      addProvider: vi.fn(),
    })

    const { container } = render(<SettingsMenu />)

    const rendered = Array.from(
      container.querySelectorAll('[data-testid^="provider-avatar-"]')
    ).map((el) =>
      el.getAttribute('data-testid')?.replace('provider-avatar-', '')
    )
    expect(rendered).toEqual(['llamacpp-upstream', 'llamacpp'])
  })

  it('marks the provider backing the selected model with a green dot', () => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'llamacpp', active: true, models: [] },
      ],
      selectedProvider: 'llamacpp-upstream',
      addProvider: vi.fn(),
    })

    render(<SettingsMenu />)

    expect(screen.getByTestId('provider-active-dot-llamacpp-upstream')).toBeInTheDocument()
    expect(
      screen.queryByTestId('provider-active-dot-llamacpp')
    ).not.toBeInTheDocument()
  })

  it('shows no active dot when nothing is selected', () => {
    render(<SettingsMenu />)

    expect(
      screen.queryByTestId('provider-active-dot-llamacpp-upstream')
    ).not.toBeInTheDocument()
  })

  it('shows inactive providers in disabled section', () => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers: [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'foundation-models', active: false, models: [] },
      ],
      addProvider: vi.fn(),
    })

    render(<SettingsMenu />)

    // Active provider shown normally
    expect(screen.getByTestId('provider-avatar-llamacpp-upstream')).toBeInTheDocument()
    // Inactive provider shown in the disabled section (expanded by default)
    expect(screen.getByTestId('provider-avatar-foundation-models')).toBeInTheDocument()
    // Disabled section label is shown
    expect(screen.getByText('common:hiddenProviders')).toBeInTheDocument()
  })
})
