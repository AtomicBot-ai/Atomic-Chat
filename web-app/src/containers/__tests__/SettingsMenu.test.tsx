import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { EngineNavigation, SettingsNavigation } from '../SettingsMenu'
import { useLocation } from '@tanstack/react-router'
import { useModelProvider } from '@/hooks/useModelProvider'
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

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  getProviderTitle: (provider: string) => provider,
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: { provider: string } }) => (
    <div data-testid={`provider-avatar-${provider.provider}`}>
      {provider.provider}
    </div>
  ),
}))

const setLocation = (pathname: string) =>
  vi
    .mocked(useLocation)
    .mockReturnValue({ pathname } as ReturnType<typeof useLocation>)

const setProviders = (
  providers: Array<Record<string, unknown>>,
  selectedProvider?: string
) =>
  vi.mocked(useModelProvider).mockReturnValue({
    providers,
    selectedProvider,
  } as unknown as ReturnType<typeof useModelProvider>)

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

    // Voice and Media live under Models Hub, HTTPS Proxy under Server.
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

describe('EngineNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocation('/settings/providers/llamacpp-upstream')
    setProviders([
      { provider: 'llamacpp-upstream', active: true, models: [] },
      { provider: 'llamacpp', active: true, models: [] },
    ])
  })

  it('links each engine to its settings page', () => {
    render(<EngineNavigation />)

    expect(
      screen.getByTestId('provider-avatar-llamacpp-upstream').closest('a')
    ).toHaveAttribute('href', '/settings/providers/llamacpp-upstream')
  })

  it('highlights the engine whose page is open', () => {
    render(<EngineNavigation />)

    expect(
      screen
        .getByTestId('provider-avatar-llamacpp-upstream')
        .closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
    expect(
      screen.getByTestId('provider-avatar-llamacpp').closest('[data-active]')
    ).toHaveAttribute('data-active', 'false')
  })

  it('shows the disabled fold only when an engine is disabled', () => {
    const { unmount } = render(<EngineNavigation />)
    expect(screen.queryByText('common:hiddenProviders')).not.toBeInTheDocument()
    unmount()

    setProviders([
      { provider: 'llamacpp-upstream', active: true, models: [] },
      { provider: 'foundation-models', active: false, models: [] },
    ])
    render(<EngineNavigation />)
    expect(screen.getByText('common:hiddenProviders')).toBeInTheDocument()
    // Expanded by default.
    expect(
      screen.getByTestId('provider-avatar-foundation-models')
    ).toBeInTheDocument()
  })

  it('collapses disabled engines when the fold is clicked', async () => {
    setProviders([
      { provider: 'llamacpp-upstream', active: true, models: [] },
      { provider: 'foundation-models', active: false, models: [] },
    ])
    const user = userEvent.setup()
    render(<EngineNavigation />)

    await user.click(screen.getByText('common:hiddenProviders'))

    expect(
      screen.queryByTestId('provider-avatar-foundation-models')
    ).not.toBeInTheDocument()
  })

  it('lists no cloud provider', () => {
    setProviders([
      { provider: 'llamacpp-upstream', active: true, models: [] },
      { provider: 'openai', active: true, models: [] },
      {
        provider: 'ollama',
        active: true,
        models: [],
        base_url: 'http://localhost:11434/v1',
      },
      { provider: 'my-custom', active: false, models: [] },
    ])
    render(<EngineNavigation />)

    expect(
      screen.getByTestId('provider-avatar-llamacpp-upstream')
    ).toBeInTheDocument()
    // Connecting these lives under Cloud providers.
    expect(
      screen.queryByTestId('provider-avatar-openai')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('provider-avatar-ollama')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('provider-avatar-my-custom')
    ).not.toBeInTheDocument()
  })

  it('lists turboquant below upstream, never first', () => {
    // IS_MACOS is false under vitest, so this is the Windows/Linux list —
    // mlx is filtered out and turboquant collapses under upstream.
    setProviders([
      { provider: 'llamacpp', active: true, models: [] },
      { provider: 'llamacpp-upstream', active: true, models: [] },
    ])
    const { container } = render(<EngineNavigation />)

    const rendered = Array.from(
      container.querySelectorAll('[data-testid^="provider-avatar-"]')
    ).map((el) =>
      el.getAttribute('data-testid')?.replace('provider-avatar-', '')
    )
    expect(rendered).toEqual(['llamacpp-upstream', 'llamacpp'])
  })

  it('marks the provider backing the selected model with a green dot', () => {
    setProviders(
      [
        { provider: 'llamacpp-upstream', active: true, models: [] },
        { provider: 'llamacpp', active: true, models: [] },
      ],
      'llamacpp-upstream'
    )
    render(<EngineNavigation />)

    expect(
      screen.getByTestId('provider-active-dot-llamacpp-upstream')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('provider-active-dot-llamacpp')
    ).not.toBeInTheDocument()
  })

  it('shows no active dot when nothing is selected', () => {
    render(<EngineNavigation />)

    expect(
      screen.queryByTestId('provider-active-dot-llamacpp-upstream')
    ).not.toBeInTheDocument()
  })

  it('carries the media and voice engine settings', () => {
    render(<EngineNavigation />)

    expect(screen.getByText('common:media').closest('a')).toHaveAttribute(
      'href',
      '/settings/media'
    )
    expect(screen.getByText('common:voice').closest('a')).toHaveAttribute(
      'href',
      '/settings/voice'
    )
  })
})
