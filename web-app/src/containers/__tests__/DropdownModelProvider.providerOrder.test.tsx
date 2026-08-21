import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

// The component subscribes with selectors, so the mock has to apply them.
const mockModelProvider = (state: Record<string, unknown>) => {
  vi.mocked(useModelProvider).mockImplementation(((selector?: any) =>
    selector ? selector(state) : state) as never)
}

vi.mock('@/hooks/useThreads', () => ({
  useThreads: vi.fn(() => ({
    updateCurrentThreadModel: vi.fn(),
  })),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({
    t: (key: string) => key,
  })),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: vi.fn(() => ({
    favoriteModels: [],
  })),
}))

vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: {
    WEB_AUTO_MODEL_SELECTION: false,
    MODEL_PROVIDER_SETTINGS: true,
    projects: true,
  },
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-trigger">{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))

vi.mock('../ProvidersAvatar', () => ({
  default: ({ provider }: { provider: any }) => (
    <div data-testid={`provider-avatar-${provider.provider}`} />
  ),
}))

vi.mock('../Capabilities', () => ({
  default: ({ capabilities }: { capabilities: string[] }) => (
    <div data-testid="capabilities">{capabilities.join(',')}</div>
  ),
}))

vi.mock('../ModelSetting', () => ({
  ModelSetting: () => <div data-testid="model-setting" />,
}))

vi.mock('../ModelSupportStatus', () => ({
  ModelSupportStatus: () => <div data-testid="model-support-status" />,
}))

vi.mock('../SamplerPopover', () => ({
  SamplerPopover: () => <div data-testid="sampler-popover" />,
}))

const providerHeaderOrder = () =>
  Array.from(
    screen
      .getByTestId('popover-content')
      .querySelectorAll('[data-testid^="provider-avatar-"]')
  ).map((el) => el.getAttribute('data-testid')?.replace('provider-avatar-', ''))

describe('DropdownModelProvider - provider ordering', () => {
  const mockProviders = [
    {
      provider: 'llamacpp',
      active: true,
      api_key: '',
      models: [{ id: 'turbo.gguf', capabilities: ['completion'] }],
      settings: [],
    },
    {
      provider: 'llamacpp-upstream',
      active: true,
      api_key: '',
      models: [{ id: 'upstream.gguf', capabilities: ['completion'] }],
      settings: [],
    },
    {
      provider: 'openai',
      active: true,
      api_key: 'sk-test',
      models: [{ id: 'gpt-4o', capabilities: ['completion'] }],
      settings: [],
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useFavoriteModel).mockReturnValue({
      favoriteModels: [],
      addFavorite: vi.fn(),
      removeFavorite: vi.fn(),
      isFavorite: vi.fn(),
      toggleFavorite: vi.fn(),
    })
    seedServiceHub({
      models: {
        checkMmprojExists: vi.fn().mockResolvedValue(false),
        checkMmprojExistsAndUpdateOffloadMMprojSetting: vi
          .fn()
          .mockResolvedValue(undefined),
      } as unknown as ModelsService,
    })

    mockModelProvider({
      providers: mockProviders,
      selectedProvider: 'llamacpp-upstream',
      selectedModel: mockProviders[1].models[0],
      getProviderByName: vi.fn((name: string) =>
        mockProviders.find((p) => p.provider === name)
      ),
      selectModelProvider: vi.fn(),
      getModelBy: vi.fn(),
      updateProvider: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders turboquant last, below the remote providers', () => {
    render(<DropdownModelProvider />)

    expect(providerHeaderOrder()).toEqual([
      'llamacpp-upstream',
      'openai',
      'llamacpp',
    ])
  })

  it('keeps upstream and turboquant apart', () => {
    render(<DropdownModelProvider />)

    const order = providerHeaderOrder()
    expect(
      Math.abs(order.indexOf('llamacpp') - order.indexOf('llamacpp-upstream'))
    ).toBeGreaterThan(1)
  })
})
