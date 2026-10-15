import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from '@tanstack/react-router'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { NavMain } from '../NavMain'
import { LeftSidebar } from '..'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    'children': React.ReactNode
    'to': string
    'aria-disabled'?: boolean
    'onClick'?: (event: React.MouseEvent) => void
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: vi.fn(),
  useNavigate: () => vi.fn(),
}))

// The sidebar primitives are stubbed, but they forward refs and props so the
// Plugins row can still act as a real Collapsible trigger.
vi.mock('@/components/ui/sidebar', async () => {
  const { forwardRef } = await import('react')
  return {
    Sidebar: ({ children }: { children: React.ReactNode }) => (
      <aside>{children}</aside>
    ),
    SidebarContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="sidebar-content">{children}</div>
    ),
    SidebarFooter: ({ children }: { children: React.ReactNode }) => (
      <footer>{children}</footer>
    ),
    SidebarHeader: ({ children }: { children: React.ReactNode }) => (
      <header>{children}</header>
    ),
    SidebarTrigger: () => <button type="button">Toggle sidebar</button>,
    SidebarRail: () => null,
    SidebarMenu: ({ children }: { children: React.ReactNode }) => (
      <ul>{children}</ul>
    ),
    SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
      <li>{children}</li>
    ),
    SidebarMenuButton: forwardRef<HTMLDivElement, any>(
      ({ children, isActive, asChild, ...props }, ref) => (
        <div ref={ref} data-active={String(Boolean(isActive))} {...props}>
          {children}
        </div>
      )
    ),
    SidebarMenuSub: ({
      children,
      ...props
    }: {
      'children': React.ReactNode
      'data-testid'?: string
    }) => (
      <ul data-testid="plugins-submenu" {...props}>
        {children}
      </ul>
    ),
    SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => (
      <li>{children}</li>
    ),
    SidebarMenuSubButton: forwardRef<HTMLDivElement, any>(
      ({ children, isActive, asChild, ...props }, ref) => (
        <div ref={ref} data-active={String(Boolean(isActive))} {...props}>
          {children}
        </div>
      )
    ),
  }
})

vi.mock('@/components/animated-icon/plug', () => ({
  PlugIcon: () => null,
}))

vi.mock('@/components/animated-icon/cloud', () => ({
  CloudIcon: () => null,
}))

vi.mock('@/components/animated-icon/settings', () => ({
  SettingsIcon: () => null,
}))

vi.mock('@/components/AppLogo', () => ({
  AppLogo: () => <div>Atomic Chat</div>,
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('../NavProjects', () => ({
  NavProjects: () => (
    <section aria-label="common:projects.title">common:projects.title</section>
  ),
}))

vi.mock('../NavChats', () => ({
  NavChats: () => <section aria-label="common:chats">common:chats</section>,
}))

vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => <div data-testid="search-dialog" />,
}))

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Media generation is desktop-only and Video is off on Linux; the flags are
// flipped per test so the gated and the ungated sidebar can be checked from
// one file.
const platform = vi.hoisted(() => ({
  mediaGeneration: true,
  videoGeneration: true,
}))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key === 'mediaGeneration'
          ? platform.mediaGeneration
          : key === 'videoGeneration'
            ? platform.videoGeneration
            : target[key as keyof typeof target],
    }),
  }
})

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: () => true,
}))

vi.mock('@/hooks/useSearchDialog', () => ({
  useSearchDialog: () => ({ open: false, setOpen: vi.fn() }),
}))

vi.mock('@/hooks/useProjectDialog', () => ({
  useProjectDialog: (
    selector: (state: { open: boolean; setOpen: () => void }) => unknown
  ) => selector({ open: false, setOpen: vi.fn() }),
}))

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ addFolder: vi.fn() }),
}))

describe('NavMain', () => {
  beforeEach(() => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/' } as never)
    useLeftPanel.setState({ pluginsExpanded: false })
    platform.mediaGeneration = true
    platform.videoGeneration = true
  })

  it('puts Images right after Models on desktop', () => {
    render(<NavMain />)

    const labels = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent?.trim())
    const models = labels.indexOf('common:modelHub')
    expect(models).toBeGreaterThanOrEqual(0)
    expect(labels[models + 1]).toBe('common:images')
  })

  it('hides Images where the platform has no media generation', () => {
    platform.mediaGeneration = false
    platform.videoGeneration = false
    render(<NavMain />)

    expect(screen.queryByTestId('images-link')).not.toBeInTheDocument()
    expect(screen.queryByTestId('videos-link')).not.toBeInTheDocument()
    expect(screen.getByText('common:modelHub')).toBeInTheDocument()
  })

  it('keeps Images and hides Video on Linux', () => {
    platform.videoGeneration = false
    render(<NavMain />)

    expect(screen.getByTestId('images-link')).toBeInTheDocument()
    expect(screen.queryByTestId('videos-link')).not.toBeInTheDocument()
  })

  it('puts Video right after Images as one row, and highlights it on its route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/videos/' } as never)
    render(<NavMain />)

    const labels = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent?.trim())
    const images = labels.indexOf('common:images')
    expect(labels[images + 1]).toBe('common:video')
    const link = screen.getByTestId('videos-link')
    expect(link).toHaveAttribute('href', '/videos/')
    expect(link.parentElement).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('images-link').parentElement).toHaveAttribute(
      'data-active',
      'false'
    )
  })

  it('shows Images as one row like Video: no workflow list to unfold', () => {
    render(<NavMain />)

    const link = screen.getByTestId('images-link')
    expect(link).toHaveAttribute('href', '/images/')
    // The page's own heading picks the mode; the sidebar only names the section.
    expect(link.closest('li')?.querySelector('[aria-expanded]')).toBeNull()
    expect(screen.queryByText('images:workflow.create.label')).toBeNull()
    expect(screen.queryByText('images:workflow.inpaint.label')).toBeNull()
  })

  it.each(['/images/', '/images/inpaint', '/images/edit'])(
    'highlights Images on %s',
    (pathname) => {
      vi.mocked(useLocation).mockReturnValue({ pathname } as never)
      render(<NavMain />)

      expect(screen.getByTestId('images-link').parentElement).toHaveAttribute(
        'data-active',
        'true'
      )
    }
  )

  it('shows every section on the unified sidebar', () => {
    render(<NavMain />)

    expect(screen.getByText('common:newChat')).toBeInTheDocument()
    expect(screen.getByText('common:modelHub')).toBeInTheDocument()
    expect(screen.getByText('common:cloud')).toBeInTheDocument()
    expect(screen.getByText('common:plugins')).toBeInTheDocument()
    expect(screen.getByText('common:projects.new')).toBeInTheDocument()
    expect(screen.getByText('common:launch')).toBeInTheDocument()
    expect(screen.getByText('common:api')).toBeInTheDocument()
    expect(screen.queryByText('common:newTask')).not.toBeInTheDocument()
  })

  it('renders the main navigation in order with New Project last before the separate Projects section', () => {
    render(<LeftSidebar />)

    const mainMenu = screen.getByText('common:newChat').closest('ul')
    expect(mainMenu).not.toBeNull()
    expect(
      within(mainMenu!).getAllByRole('listitem').map((item) => item.textContent)
    ).toEqual([
      'common:newChat',
      'common:modelHub',
      'common:images',
      'common:video',
      'common:cloud',
      'common:plugins',
      'common:launch',
      'common:api',
      'common:projects.new',
    ])

    const projectsSection = screen.getByRole('region', {
      name: 'common:projects.title',
    })
    expect(mainMenu).not.toContainElement(projectsSection)
    expect(
      mainMenu!.compareDocumentPosition(projectsSection) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('keeps Connectors and Skills tucked inside the collapsed Plugins group', () => {
    render(<NavMain />)

    expect(screen.queryByText('common:connectors')).not.toBeInTheDocument()
    expect(screen.queryByText('common:skills')).not.toBeInTheDocument()
  })

  it('reveals Connectors and Skills as Plugins sub-items when expanded', async () => {
    const user = userEvent.setup()
    render(<NavMain />)

    await user.click(screen.getByText('common:plugins'))

    const submenu = screen
      .getAllByTestId('plugins-submenu')
      .find((element) => element.textContent?.includes('common:connectors'))
    expect(submenu).toContainElement(screen.getByText('common:connectors'))
    expect(submenu).toContainElement(screen.getByText('common:skills'))
  })

  it('expands the Plugins group and highlights Connectors on its route', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/connectors/',
    } as never)
    render(<NavMain />)

    expect(useLeftPanel.getState().pluginsExpanded).toBe(true)
    expect(
      screen.getByText('common:connectors').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })

  it('highlights the Plugins group itself when collapsed on a child route', async () => {
    const user = userEvent.setup()
    vi.mocked(useLocation).mockReturnValue({ pathname: '/skills/' } as never)
    render(<NavMain />)

    await user.click(screen.getByText('common:plugins'))

    expect(
      screen.getByText('common:plugins').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })

  it('highlights Cloud on the cloud route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/cloud/' } as never)

    render(<NavMain />)

    expect(
      screen.getByText('common:cloud').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })

  it('highlights Integrations on the launch route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/launch/' } as never)

    render(<NavMain />)

    expect(
      screen.getByText('common:launch').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })
})
