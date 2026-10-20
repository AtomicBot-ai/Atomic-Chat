import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from '@tanstack/react-router'
import { LeftSidebar } from '..'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    ...props
  }: {
    'children': React.ReactNode
    'to': string
    'search'?: Record<string, unknown>
    'aria-current'?: string
  }) => (
    <a
      href={to}
      data-search={search ? JSON.stringify(search) : undefined}
      {...props}
    >
      {children}
    </a>
  ),
  useLocation: vi.fn(),
  useNavigate: () => navigate,
}))

const sidebar = vi.hoisted(() => ({
  setOpen: vi.fn(),
  setOpenMobile: vi.fn(),
}))

vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => (
    <aside>{children}</aside>
  ),
  SidebarContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-content">{children}</div>
  ),
  SidebarHeader: ({ children }: { children: React.ReactNode }) => (
    <header>{children}</header>
  ),
  SidebarTrigger: (props: { 'aria-label'?: string }) => (
    <button type="button" {...props} />
  ),
  SidebarRail: () => null,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({
    children,
    isActive,
    asChild: _asChild,
    ...props
  }: {
    children: React.ReactNode
    isActive?: boolean
    asChild?: boolean
  }) => (
    <div data-active={String(Boolean(isActive))} {...props}>
      {children}
    </div>
  ),
  useSidebar: () => ({
    open: true,
    openMobile: false,
    isMobile: false,
    ...sidebar,
  }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: () => null,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open: vi.fn() }) }),
}))

const badges = vi.hoisted(() => ({
  integrationsBadgeSeen: true,
  connectorsBadgeSeen: true,
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: (state: typeof badges) => unknown) =>
    selector(badges),
}))

const addFolder = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ addFolder }),
}))

vi.mock('../NavPinned', () => ({
  NavPinned: () => <section aria-label="pinned" />,
}))
vi.mock('../NavProjects', () => ({
  NavProjects: ({ onCreate }: { onCreate: () => void }) => (
    <button type="button" onClick={onCreate}>
      common:projects.new
    </button>
  ),
}))
vi.mock('../NavChats', () => ({
  NavChats: () => <section aria-label="recents" />,
}))
vi.mock('../NavServerAgents', () => ({
  NavServerAgents: () => <section aria-label="agents" />,
}))
vi.mock('@/containers/ServerControlPanel', () => ({
  ServerControlPanel: () => <section aria-label="server control" />,
}))
vi.mock('@/containers/SettingsMenu', () => ({
  SettingsNavigation: () => <section aria-label="settings navigation" />,
  EngineNavigation: () => <section aria-label="engine navigation" />,
}))
vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => null,
}))

const projectDialog = vi.hoisted(() => ({
  onSave: undefined as
    | undefined
    | ((name: string, assistantId?: string) => Promise<string>),
}))
vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: ({
    onSave,
  }: {
    onSave: (name: string, assistantId?: string) => Promise<string>
  }) => {
    projectDialog.onSave = onSave
    return null
  },
}))

// Feature flags are flipped per test so gated and ungated rows are both
// checked from one file.
const platform = vi.hoisted(() => ({
  mediaGeneration: true,
  localApiServer: true,
  httpsProxy: true,
}))
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

const at = (pathname: string, search: Record<string, unknown> = {}) =>
  vi
    .mocked(useLocation)
    .mockReturnValue({ pathname, search } as ReturnType<typeof useLocation>)

const rowFor = (label: string) =>
  within(screen.getByTestId('sidebar-content'))
    .getByText(label)
    .closest('[data-active]')

describe('LeftSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platform.mediaGeneration = true
    platform.localApiServer = true
    platform.httpsProxy = true
    badges.integrationsBadgeSeen = true
    at('/')
  })

  describe('navigation rail', () => {
    it('offers the four sections and marks the current one', () => {
      at('/hub/')
      render(<LeftSidebar />)

      const rail = screen.getByRole('navigation', {
        name: 'common:navigation.primary',
      })
      const links = within(rail).getAllByRole('link')
      expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
        'common:navigation.workspace',
        'common:navigation.server',
        'common:navigation.modelsHub',
        'common:settings',
      ])
      expect(
        within(rail).getByRole('link', { name: 'common:navigation.modelsHub' })
      ).toHaveAttribute('aria-current', 'page')
      expect(
        within(rail).getByRole('link', { name: 'common:navigation.workspace' })
      ).not.toHaveAttribute('aria-current')
    })

    it('opens the sidebar when a section is picked', () => {
      render(<LeftSidebar />)

      const server = screen.getByRole('link', {
        name: 'common:navigation.server',
      })
      expect(server).toHaveAttribute('href', '/api/')
      server.click()

      expect(sidebar.setOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('Workspace', () => {
    it('lists new chat, media, pins, projects and recents', () => {
      render(<LeftSidebar />)

      expect(screen.getByText('common:navigation.workspace')).toBeInTheDocument()
      expect(screen.getByText('common:newChat')).toBeInTheDocument()
      expect(screen.getByTestId('images-link')).toHaveAttribute(
        'href',
        '/images/'
      )
      expect(screen.getByTestId('videos-link')).toHaveAttribute(
        'href',
        '/videos/'
      )
      expect(screen.getByLabelText('pinned')).toBeInTheDocument()
      expect(screen.getByLabelText('recents')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'common:navigation.searchChats' })
      ).toBeInTheDocument()
    })

    it('hides Images and Video without local media generation', () => {
      platform.mediaGeneration = false
      render(<LeftSidebar />)

      expect(screen.queryByTestId('images-link')).not.toBeInTheDocument()
      expect(screen.queryByTestId('videos-link')).not.toBeInTheDocument()
    })

    it('highlights Images on any image workflow', () => {
      at('/images/create')
      render(<LeftSidebar />)

      expect(rowFor('common:images')).toHaveAttribute('data-active', 'true')
    })

    it('opens the new project and reports its id to the dialog', async () => {
      addFolder.mockResolvedValue({ id: 'p-42' })
      render(<LeftSidebar />)

      await expect(projectDialog.onSave?.('Research')).resolves.toBe('p-42')
      expect(navigate).toHaveBeenCalledWith({
        to: '/project/$projectId',
        params: { projectId: 'p-42' },
      })
    })
  })

  describe('Server', () => {
    it('shows the control panel, its pages and the agents', () => {
      at('/api/')
      render(<LeftSidebar />)

      expect(screen.getByLabelText('server control')).toBeInTheDocument()
      expect(rowFor('common:navigation.overview')).toHaveAttribute(
        'data-active',
        'true'
      )
      expect(
        screen.getByText('common:navigation.activity').closest('a')
      ).toHaveAttribute('href', '/api/activity')
      expect(
        screen.getByText('common:launch').closest('a')
      ).toHaveAttribute('href', '/launch/')
      expect(
        screen.getByText('common:navigation.configuration').closest('a')
      ).toHaveAttribute('href', '/settings/local-api-server')
      expect(
        screen.getByText('common:navigation.remoteAccess').closest('a')
      ).toHaveAttribute('href', '/settings/remote-lan')
      expect(
        screen.getByText('common:https_proxy').closest('a')
      ).toHaveAttribute('href', '/settings/https-proxy')
      expect(screen.getByLabelText('agents')).toBeInTheDocument()
    })

    it('highlights Activity, not Overview, below /api', () => {
      at('/api/activity')
      render(<LeftSidebar />)

      expect(rowFor('common:navigation.activity')).toHaveAttribute(
        'data-active',
        'true'
      )
      expect(rowFor('common:navigation.overview')).toHaveAttribute(
        'data-active',
        'false'
      )
    })

    it('highlights Remote access on its own page', () => {
      at('/settings/remote-lan')
      render(<LeftSidebar />)

      expect(rowFor('common:navigation.remoteAccess')).toHaveAttribute(
        'data-active',
        'true'
      )
      expect(rowFor('common:navigation.overview')).toHaveAttribute(
        'data-active',
        'false'
      )
    })

    it('drops the panel, the server pages and the proxy where they do not exist', () => {
      platform.localApiServer = false
      platform.httpsProxy = false
      at('/api/')
      render(<LeftSidebar />)

      expect(screen.queryByLabelText('server control')).not.toBeInTheDocument()
      expect(
        screen.queryByText('common:navigation.configuration')
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('common:navigation.remoteAccess')
      ).not.toBeInTheDocument()
      expect(screen.queryByText('common:https_proxy')).not.toBeInTheDocument()
    })

    it('keeps the Integrations "New" badge until the page is seen', () => {
      badges.integrationsBadgeSeen = false
      at('/api/')
      render(<LeftSidebar />)

      expect(
        within(screen.getByText('common:launch').closest('a')!).getByText(
          'common:newBadge'
        )
      ).toBeInTheDocument()
    })
  })

  describe('Models Hub', () => {
    it('links Downloads and Custom Endpoint to their views', () => {
      at('/hub/')
      render(<LeftSidebar />)

      const downloads = screen.getByText('common:downloads').closest('a')
      expect(downloads).toHaveAttribute('href', '/hub/')
      expect(downloads).toHaveAttribute(
        'data-search',
        JSON.stringify({ installed: true })
      )
      const custom = screen
        .getByText('common:navigation.customEndpoint')
        .closest('a')
      expect(custom).toHaveAttribute('href', '/cloud/')
      expect(custom).toHaveAttribute(
        'data-search',
        JSON.stringify({ add: 'custom' })
      )
      expect(screen.getByLabelText('engine navigation')).toBeInTheDocument()
    })

    it('highlights Local models or Downloads by the installed filter', () => {
      at('/hub/')
      const { unmount } = render(<LeftSidebar />)
      expect(rowFor('common:navigation.localModels')).toHaveAttribute(
        'data-active',
        'true'
      )
      expect(rowFor('common:downloads')).toHaveAttribute('data-active', 'false')
      unmount()

      at('/hub/', { installed: true })
      render(<LeftSidebar />)
      expect(rowFor('common:downloads')).toHaveAttribute('data-active', 'true')
      expect(rowFor('common:navigation.localModels')).toHaveAttribute(
        'data-active',
        'false'
      )
    })

    it('highlights Custom Endpoint while its dialog is open', () => {
      at('/cloud/', { provider: 'openai', add: 'custom' })
      render(<LeftSidebar />)

      expect(rowFor('common:navigation.customEndpoint')).toHaveAttribute(
        'data-active',
        'true'
      )
      expect(rowFor('common:navigation.cloudProviders')).toHaveAttribute(
        'data-active',
        'false'
      )
    })
  })

  describe('Settings', () => {
    it('shows the settings navigation', () => {
      at('/settings/general')
      render(<LeftSidebar />)

      expect(screen.getByLabelText('settings navigation')).toBeInTheDocument()
    })
  })
})
