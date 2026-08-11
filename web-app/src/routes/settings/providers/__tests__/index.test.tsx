import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Route as ProvidersRoute } from '../index'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'

let mockProviders: any[] = []
const mockUpdateProvider = vi.fn()

// Mock dependencies
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
    title?: React.ReactNode
    description?: React.ReactNode
    actions?: React.ReactNode
  }) => (
    <div data-testid="card-item">
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && (
        <div data-testid="card-item-description">{description}</div>
      )}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: { provider: string } }) => (
    <div data-testid="providers-avatar" data-provider={provider.provider} />
  ),
}))

// The catalog dialog has its own test; here we only care that the route
// renders its trigger.
vi.mock('@/containers/dialogs', () => ({
  AddCloudProviderDialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="add-cloud-provider-dialog">{children}</div>
  ),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    providers: mockProviders,
    addProvider: vi.fn(),
    updateProvider: mockUpdateProvider,
    setProviders: vi.fn(),
  }),
}))

vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: Object.assign(
    (selector: (state: any) => unknown) =>
      selector({
        providers: [],
        status: 'success',
        fetchedAt: null,
        refresh: vi.fn(),
      }),
    {
      getState: () => ({ error: null }),
    }
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@/lib/utils', () => ({
  getProviderTitle: (provider: string) => `${provider} Provider`,
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
  useNavigate: () => vi.fn(),
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

vi.mock('lodash/cloneDeep', () => ({
  default: (obj: any) => JSON.parse(JSON.stringify(obj)),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      model_providers: '/settings/providers',
      providers: '/settings/providers/$providerName',
    },
  },
}))

const renderRoute = () => {
  const Component = ProvidersRoute.component as React.ComponentType
  return render(<Component />)
}

describe('Providers Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProviders = []
    seedServiceHub({
      providers: {
        getProviders: vi.fn().mockResolvedValue([]),
      } as unknown as ProvidersService,
      models: {
        stopAllModels: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelsService,
    })
  })

  it('should render the providers settings page', () => {
    renderRoute()

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('renders a separate card for local and cloud providers', () => {
    renderRoute()

    expect(screen.getAllByTestId('card')).toHaveLength(2)
    expect(screen.getByText('provider:localProviders')).toBeInTheDocument()
    expect(screen.getByText('provider:cloudProviders')).toBeInTheDocument()
  })

  it('shows the empty state when no cloud provider is connected', () => {
    mockProviders = [
      {
        provider: 'llamacpp-upstream',
        active: true,
        api_key: '',
        models: [],
        settings: [],
      },
    ]
    renderRoute()

    expect(screen.getByText('provider:noCloudProviders')).toBeInTheDocument()
    expect(screen.getAllByTestId('card-item')).toHaveLength(1)
  })

  it('lists only cloud providers the user has added', () => {
    mockProviders = [
      {
        provider: 'llamacpp-upstream',
        active: true,
        api_key: '',
        models: [],
        settings: [],
      },
      {
        provider: 'openai',
        active: true,
        api_key: 'sk-test',
        base_url: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o' }],
        settings: [],
      },
      {
        provider: 'anthropic',
        active: false,
        api_key: '',
        base_url: 'https://api.anthropic.com/v1',
        models: [{ id: 'claude' }],
        settings: [],
      },
    ]
    renderRoute()

    const avatars = screen
      .getAllByTestId('providers-avatar')
      .map((node) => node.getAttribute('data-provider'))

    expect(avatars).toContain('llamacpp-upstream')
    expect(avatars).toContain('openai')
    expect(avatars).not.toContain('anthropic')
  })

  it('flags a connected cloud provider that is still missing its key', () => {
    mockProviders = [
      {
        provider: 'openai',
        active: true,
        api_key: '',
        base_url: 'https://api.openai.com/v1',
        models: [],
        settings: [],
      },
    ]
    renderRoute()

    expect(screen.getByText('provider:needsApiKey')).toBeInTheDocument()
  })

  it('renders the add provider catalog trigger', () => {
    renderRoute()

    expect(screen.getByText('provider:addProvider')).toBeInTheDocument()
  })
})
