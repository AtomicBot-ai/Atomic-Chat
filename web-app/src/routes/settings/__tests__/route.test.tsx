import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Route as SettingsLayoutRoute } from '../route'

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu">Settings Menu</div>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/constants/routes', () => ({
  route: { settings: { index: '/settings' } },
}))

// The child page stands in for any `/settings/*` route: it renders no chrome of
// its own and hands its header up through the slot.
vi.mock('@tanstack/react-router', async () => {
  const { SettingsPageHeader } = await import(
    '@/containers/SettingsPageHeader'
  )
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createFileRoute: () => (config: any) => config,
    Outlet: () => (
      <>
        <SettingsPageHeader>
          <span data-testid="page-header">page header</span>
        </SettingsPageHeader>
        <div data-testid="page-content">page content</div>
      </>
    ),
  }
})

describe('Settings layout route', () => {
  const renderLayout = () => {
    const Component = SettingsLayoutRoute.component as React.ComponentType
    return render(<Component />)
  }

  it('owns the sidebar so pages do not each render their own', () => {
    renderLayout()

    expect(screen.getAllByTestId('settings-menu')).toHaveLength(1)
    expect(screen.getByTestId('page-content')).toBeInTheDocument()
  })

  it('renders a page header into the shared header, not the content area', () => {
    renderLayout()

    const header = screen.getByTestId('header-page')
    expect(header).toContainElement(screen.getByTestId('page-header'))
    expect(screen.getAllByTestId('header-page')).toHaveLength(1)
    expect(screen.getByTestId('page-content')).not.toContainElement(
      screen.getByTestId('page-header')
    )
  })
})
