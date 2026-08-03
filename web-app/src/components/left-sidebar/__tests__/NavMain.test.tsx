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

vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: ({ mode }: { mode: string }) => (
    <div data-testid="search-mode">{mode}</div>
  ),
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

  it('shows Integrations only in Chat mode', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.getByText('common:launch')).toBeInTheDocument()

    rerender(<NavMain mode="agent" />)

    expect(screen.queryByText('common:launch')).not.toBeInTheDocument()
  })

  it('shows New Project only in Chat mode', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.getByText('common:projects.new')).toBeInTheDocument()

    rerender(<NavMain mode="agent" />)

    expect(screen.queryByText('common:projects.new')).not.toBeInTheDocument()
  })

  it('shows Models in both modes', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.getByText('common:models')).toBeInTheDocument()

    rerender(<NavMain mode="agent" />)

    expect(screen.getByText('common:models')).toBeInTheDocument()
  })

  it('shows Skills only in Agent mode', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.queryByText('common:skills')).not.toBeInTheDocument()

    rerender(<NavMain mode="agent" />)

    expect(screen.getByText('common:skills')).toBeInTheDocument()
  })

  it('labels the new conversation action for the active mode', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.getByText('common:newChat')).toBeInTheDocument()

    rerender(<NavMain mode="agent" />)

    expect(screen.getByText('common:newTask')).toBeInTheDocument()
    expect(screen.queryByText('common:newChat')).not.toBeInTheDocument()
  })

  it('passes the active mode to search', () => {
    const { rerender } = render(<NavMain mode="chat" />)

    expect(screen.getByTestId('search-mode')).toHaveTextContent('chat')

    rerender(<NavMain mode="agent" />)

    expect(screen.getByTestId('search-mode')).toHaveTextContent('agent')
  })

  it('highlights Integrations on the launch route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/launch/' } as never)

    render(<NavMain mode="chat" />)

    expect(
      screen.getByText('common:launch').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })
})
