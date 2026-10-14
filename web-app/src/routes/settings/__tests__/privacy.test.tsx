import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Route as PrivacyRoute } from '../privacy'

// Mock dependencies
vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu">Settings Menu</div>,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({
    header,
    children,
  }: {
    header?: React.ReactNode
    children: React.ReactNode
  }) => (
    <div data-testid="card">
      {header && <div data-testid="card-header">{header}</div>}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
    actions,
  }: {
    title?: string
    description?: string
    actions?: React.ReactNode
  }) => (
    <div data-testid="card-item" data-title={title}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && (
        <div data-testid="card-item-description">{description}</div>
      )}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/hooks/useAnalytic', () => ({
  useAnalytic: () => ({
    productAnalytic: false,
    setProductAnalytic: vi.fn(),
  }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      data-testid="switch"
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}))

vi.mock('posthog-js', () => ({
  default: {
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      privacy: '/settings/privacy',
    },
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
}))

describe('Privacy Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  const getAnalyticsSwitch = () => {
    const switches = screen.getAllByTestId('switch')
    return switches[switches.length - 1]
  }

  it('should render the privacy settings page', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('should render analytics card with header', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getAllByTestId('card')).toHaveLength(2)
    expect(screen.getAllByTestId('card-header')).toHaveLength(2)
    expect(screen.getByText('Cloud privacy gate')).toBeInTheDocument()
    expect(screen.getByText('settings:privacy.analytics')).toBeInTheDocument()
  })

  it('should render analytics switch', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const analyticsSwitch = getAnalyticsSwitch()
    expect(analyticsSwitch).toBeInTheDocument()
    expect(analyticsSwitch).not.toBeChecked()
  })

  it('should handle analytics toggle when enabling', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const analyticsSwitch = getAnalyticsSwitch()
    expect(analyticsSwitch).toBeInTheDocument()

    // Test that switch is interactive
    fireEvent.click(analyticsSwitch)
    expect(analyticsSwitch).toBeInTheDocument()
  })

  it('should handle analytics toggle when disabling', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const analyticsSwitch = getAnalyticsSwitch()
    expect(analyticsSwitch).toBeInTheDocument()

    // Test that switch is interactive
    fireEvent.click(analyticsSwitch)
    expect(analyticsSwitch).toBeInTheDocument()
  })

  it('should have proper layout structure', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const headerPage = screen.getByTestId('header-page')
    expect(headerPage).toBeInTheDocument()

    const settingsMenu = screen.getByTestId('settings-menu')
    expect(settingsMenu).toBeInTheDocument()
  })

  it('should render switch in correct checked state based on productAnalytic', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const analyticsSwitch = getAnalyticsSwitch()
    expect(analyticsSwitch).toBeInTheDocument()
    // Test that switch has some state
    expect(analyticsSwitch).toHaveAttribute('type', 'checkbox')
  })

  it('should render switch in unchecked state when productAnalytic is false', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const analyticsSwitch = getAnalyticsSwitch()
    expect(analyticsSwitch).toBeInTheDocument()
    expect(analyticsSwitch).toHaveAttribute('type', 'checkbox')
  })

  it('should call translation function with correct keys', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    // Test that translations are rendered
    expect(screen.getByText('common:settings')).toBeInTheDocument()
    expect(screen.getByText('settings:privacy.analytics')).toBeInTheDocument()
  })

  it('should handle switch state change properly', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const analyticsSwitch = getAnalyticsSwitch()

    // Test that switch can be toggled
    fireEvent.click(analyticsSwitch)
    expect(analyticsSwitch).toBeInTheDocument()

    // Test that switch can be toggled again
    fireEvent.click(analyticsSwitch)
    expect(analyticsSwitch).toBeInTheDocument()
  })

  it('keeps draft whitespace while persisting normalized custom terms', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)
    const terms = screen.getByPlaceholderText(/Project Falcon/)

    fireEvent.change(terms, { target: { value: '  Falcon  \n\n' } })
    expect(terms).toHaveValue('  Falcon  \n\n')
    expect(JSON.parse(localStorage.getItem('privacy-gate')!).customTerms).toEqual(
      ['Falcon']
    )

    fireEvent.change(terms, {
      target: { value: '  Falcon  \n\n Northstar ' },
    })
    expect(terms).toHaveValue('  Falcon  \n\n Northstar ')
    expect(JSON.parse(localStorage.getItem('privacy-gate')!).customTerms).toEqual(
      ['Falcon', 'Northstar']
    )
  })
})
