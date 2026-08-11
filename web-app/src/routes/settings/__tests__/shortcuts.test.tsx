import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Route as ShortcutsRoute } from '../shortcuts'

// Mock dependencies
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="card">
      {header && <div data-testid="card-header">{header}</div>}
      {children}
    </div>
  ),
  CardItem: ({ title, description, actions }: { title?: string; description?: string; actions?: React.ReactNode }) => (
    <div data-testid="card-item" data-title={title}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && <div data-testid="card-item-description">{description}</div>}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      shortcuts: '/settings/shortcuts',
    },
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
}))

// Mock the shortcut data that would be imported
vi.mock('@/constants/shortcuts', () => ({
  shortcuts: [
    {
      id: 'new-thread',
      title: 'New Thread',
      description: 'Create a new conversation thread',
      shortcut: ['Ctrl', 'N'],
      category: 'general',
    },
    {
      id: 'save-file',
      title: 'Save File',
      description: 'Save current file',
      shortcut: ['Ctrl', 'S'],
      category: 'general',
    },
    {
      id: 'copy-text',
      title: 'Copy Text',
      description: 'Copy selected text',
      shortcut: ['Ctrl', 'C'],
      category: 'editing',
    },
  ],
}))

describe('Shortcuts Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render the shortcuts settings page', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('should render shortcuts card with header', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    const cards = screen.getAllByTestId('card')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0]).toBeInTheDocument()
  })

  it('should have proper layout structure', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    // The page contributes a header and a content pane; the sidebar and the
    // page frame around them belong to the `/settings` layout route.
    const container = screen.getByTestId('header-page')
    expect(container).toBeInTheDocument()
    expect(container.nextElementSibling).toHaveClass('overflow-y-auto')
  })

  it('should call translation function with correct keys', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('should render with proper responsive classes', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    const settingsContent = screen.getByTestId('header-page').nextElementSibling
    expect(settingsContent).toHaveClass('p-4', 'pt-0', 'w-full', 'overflow-y-auto')
  })

  it('should render main content area', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    const mainContent = screen.getAllByTestId('card')
    expect(mainContent.length).toBeGreaterThan(0)
  })

  it('should render shortcuts section', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    // The shortcuts page should render the card structure
    const cards = screen.getAllByTestId('card')
    expect(cards.length).toBeGreaterThan(0)
  })

  it('should be properly structured as a route component', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    
    // Test that the component can be rendered without errors
    expect(() => {
      render(<Component />)
    }).not.toThrow()
  })

  it('should have header with settings title', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    const headerPage = screen.getByTestId('header-page')
    expect(headerPage).toBeInTheDocument()
    expect(headerPage).toHaveTextContent('common:settings')
  })

  it('should render in proper container structure', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    // Check the main container structure
    const container = screen.getByTestId('header-page')
    expect(container).toHaveTextContent('common:settings')
    expect(container.nextElementSibling).toHaveClass('p-4')
  })

  it('should render content in scrollable area', () => {
    const Component = ShortcutsRoute.component as React.ComponentType
    render(<Component />)

    const contentArea = screen.getAllByTestId('card')
    expect(contentArea.length).toBeGreaterThan(0)
  })
})
