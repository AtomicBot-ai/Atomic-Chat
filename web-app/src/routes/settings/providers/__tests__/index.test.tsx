import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Route as ProvidersRoute } from '../index'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'
import { useModelProvider } from '@/hooks/useModelProvider'

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

vi.mock('@/containers/ProvidersAvatar', () => ({
  // The real component takes the whole provider object, not its name.
  default: ({ provider }: { provider: { provider: string } }) => (
    <div data-testid="providers-avatar" data-provider={provider.provider}>
      Provider Avatar: {provider.provider}
    </div>
  ),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(() => ({
    providers: [],
    updateProvider: vi.fn(),
  })),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (key === 'providerAlreadyExists') {
        return `Provider ${options?.name} already exists`
      }
      return key
    },
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

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    [key: string]: any
  }) => (
    <button data-testid="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  ),
  DialogClose: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-close">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-title">{children}</div>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
  }) => (
    <input
      data-testid="input"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  ),
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

vi.mock('@/mock/data', () => ({
  openAIProviderSettings: [
    {
      key: 'api_key',
      title: 'API Key',
      description: 'Your API key',
      controllerType: 'input',
      controllerProps: { placeholder: 'Enter API key' },
    },
  ],
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
    cloud: { index: '/cloud/' },
  },
}))

describe('Providers Settings Route', () => {
  const localAndCloud = [
    { provider: 'llamacpp-upstream', active: true, models: [], persist: true },
    { provider: 'llamacpp', active: true, models: [], persist: true },
    { provider: 'openai', active: true, models: [{ id: 'gpt-5.4' }] },
    {
      provider: 'ollama',
      active: true,
      models: [],
      base_url: 'http://localhost:11434/v1',
    },
    { provider: 'my-custom', active: true, models: [] },
  ]

  const mockProviders = (providers: unknown[], updateProvider = vi.fn()) => {
    vi.mocked(useModelProvider).mockReturnValue({
      providers,
      updateProvider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    return updateProvider
  }

  const renderPage = () => {
    const Component = ProvidersRoute.component as React.ComponentType
    return render(<Component />)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockProviders([])
    seedServiceHub({
      providers: {
        getProviders: vi.fn().mockResolvedValue([]),
      } as unknown as ProvidersService,
      models: {
        stopAllModels: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelsService,
    })
  })

  it('renders the page chrome', () => {
    renderPage()

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
    expect(screen.getByTestId('card')).toBeInTheDocument()
    expect(screen.getByTestId('card-header')).toBeInTheDocument()
  })

  it('lists local engines only', () => {
    mockProviders(localAndCloud)
    renderPage()

    const titles = screen
      .getAllByTestId('providers-avatar')
      .map((el) => el.getAttribute('data-provider'))
    expect(titles).toEqual(['llamacpp-upstream', 'llamacpp'])
  })

  it('does not offer the add-provider dialog', () => {
    mockProviders(localAndCloud)
    renderPage()

    // Creating a custom OpenAI-compatible provider moved to `/cloud`.
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dialog-trigger')).not.toBeInTheDocument()
    expect(screen.queryByTestId('input')).not.toBeInTheDocument()
  })

  it('renders no header actions when nothing is listed', () => {
    renderPage()

    // The catalog refresh moved to `/cloud` with the providers it describes.
    expect(screen.queryAllByTestId('button')).toHaveLength(0)
  })

  it('renders a settings button and a switch per local engine', () => {
    mockProviders(localAndCloud)
    renderPage()

    expect(screen.getAllByTestId('button')).toHaveLength(2)
    expect(screen.getAllByTestId('switch')).toHaveLength(2)
  })

  it('hides the settings button for a disabled engine', () => {
    mockProviders([
      { provider: 'llamacpp-upstream', active: true, models: [], persist: true },
      { provider: 'llamacpp', active: false, models: [], persist: true },
    ])
    renderPage()

    expect(screen.getAllByTestId('button')).toHaveLength(1)
    expect(screen.getAllByTestId('switch')).toHaveLength(2)
  })

  it('toggles a provider through the switch', () => {
    const updateProvider = mockProviders([
      { provider: 'llamacpp-upstream', active: true, models: [], persist: true },
    ])
    renderPage()

    fireEvent.click(screen.getByTestId('switch'))

    const [name, patch] = updateProvider.mock.calls[0]
    expect(name).toBe('llamacpp-upstream')
    expect(patch).toMatchObject({ active: false })
  })
})
