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

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    'data-testid': testId,
  }: {
    'checked': boolean
    'disabled'?: boolean
    'onCheckedChange': (checked: boolean) => void
    'data-testid'?: string
  }) => (
    <input
      data-testid={testId ?? 'switch'}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
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

const dsn = vi.hoisted(() => ({ value: '' }))
vi.mock('@/lib/crash-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crash-reporting')>()),
  buildDsn: () => dsn.value,
}))

import { useCrashReporting } from '@/lib/crash-reporting'

describe('Privacy Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    dsn.value = ''
    useCrashReporting.setState({ enabled: false })
  })

  it('should render the privacy settings page', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('shows crash reports and the privacy gate, and no analytics opt-in', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    expect(screen.getAllByTestId('card')).toHaveLength(2)
    expect(
      screen.getByText('settings:privacy.crashReports')
    ).toBeInTheDocument()
    expect(screen.getByText('Cloud privacy gate')).toBeInTheDocument()
    expect(screen.queryByText(/privacy\.analytics/)).not.toBeInTheDocument()
    expect(screen.queryByText(/helpUsImprove/)).not.toBeInTheDocument()
  })

  it('crash reports are off and unavailable in a build without a DSN', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const toggle = screen.getByTestId(
      'crash-reports-switch'
    ) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(true)
    expect(
      screen.getByText('settings:privacy.crashReportsUnavailable')
    ).toBeInTheDocument()
  })

  it('crash reports start off and the toggle persists the choice', () => {
    dsn.value = 'https://k@o1.ingest.sentry.io/1'
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const toggle = screen.getByTestId(
      'crash-reports-switch'
    ) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    expect(useCrashReporting.getState().enabled).toBe(true)
    expect(
      JSON.parse(localStorage.getItem('crash-reporting')!).state.enabled
    ).toBe(true)
  })

  it('persists the gate switch', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)

    const gateSwitch = screen.getAllByTestId('switch')[0]
    const before = (gateSwitch as HTMLInputElement).checked
    fireEvent.click(gateSwitch)
    expect(JSON.parse(localStorage.getItem('privacy-gate')!).enabled).toBe(
      !before
    )
  })

  it('keeps draft whitespace while persisting normalized custom terms', () => {
    const Component = PrivacyRoute.component as React.ComponentType
    render(<Component />)
    const terms = screen.getByPlaceholderText(/Project Falcon/)

    fireEvent.change(terms, { target: { value: '  Falcon  \n\n' } })
    expect(terms).toHaveValue('  Falcon  \n\n')
    expect(
      JSON.parse(localStorage.getItem('privacy-gate')!).customTerms
    ).toEqual(['Falcon'])

    fireEvent.change(terms, {
      target: { value: '  Falcon  \n\n Northstar ' },
    })
    expect(terms).toHaveValue('  Falcon  \n\n Northstar ')
    expect(
      JSON.parse(localStorage.getItem('privacy-gate')!).customTerms
    ).toEqual(['Falcon', 'Northstar'])
  })
})
