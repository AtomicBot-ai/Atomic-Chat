import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from '@tanstack/react-router'
import { NavMain } from '../NavMain'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useLocation: vi.fn(),
  useNavigate: () => vi.fn(),
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({
    children,
    isActive,
  }: {
    children: React.ReactNode
    isActive: boolean
  }) => <div data-active={String(isActive)}>{children}</div>,
}))

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
  })

  it('shows every section on the unified sidebar', () => {
    render(<NavMain />)

    expect(screen.getByText('common:newChat')).toBeInTheDocument()
    expect(screen.getByText('common:models')).toBeInTheDocument()
    expect(screen.getByText('common:cloud')).toBeInTheDocument()
    expect(screen.getByText('common:connectors')).toBeInTheDocument()
    expect(screen.getByText('common:skills')).toBeInTheDocument()
    expect(screen.getByText('common:projects.new')).toBeInTheDocument()
    expect(screen.getByText('common:launch')).toBeInTheDocument()
    expect(screen.getByText('common:api')).toBeInTheDocument()
    expect(screen.queryByText('common:newTask')).not.toBeInTheDocument()
  })

  it('highlights Connectors on its route', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/connectors/',
    } as never)
    render(<NavMain />)

    expect(
      screen.getByText('common:connectors').closest('[data-active]')
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
