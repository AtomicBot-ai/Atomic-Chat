import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from '@tanstack/react-router'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { NavMain } from '../NavMain'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useLocation: vi.fn(),
  useNavigate: () => vi.fn(),
}))

// The sidebar primitives are stubbed, but they forward refs and props so the
// Plugins row can still act as a real Collapsible trigger.
vi.mock('@/components/ui/sidebar', async () => {
  const { forwardRef } = await import('react')
  return {
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
    SidebarMenuSub: ({ children }: { children: React.ReactNode }) => (
      <ul data-testid="plugins-submenu">{children}</ul>
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

vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => <div data-testid="search-dialog" />,
}))

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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
  })

  it('shows every section on the unified sidebar', () => {
    render(<NavMain />)

    expect(screen.getByText('common:newChat')).toBeInTheDocument()
    expect(screen.getByText('common:models')).toBeInTheDocument()
    expect(screen.getByText('common:cloud')).toBeInTheDocument()
    expect(screen.getByText('common:plugins')).toBeInTheDocument()
    expect(screen.getByText('common:projects.new')).toBeInTheDocument()
    expect(screen.getByText('common:launch')).toBeInTheDocument()
    expect(screen.getByText('common:api')).toBeInTheDocument()
    expect(screen.queryByText('common:newTask')).not.toBeInTheDocument()
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

    const submenu = screen.getByTestId('plugins-submenu')
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
