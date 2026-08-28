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
  useThreads: vi.fn(() => ({ updateCurrentThreadModel: vi.fn() })),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: vi.fn(() => ({ favoriteModels: [] })),
}))

vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: {
    WEB_AUTO_MODEL_SELECTION: false,
    MODEL_PROVIDER_SETTINGS: true,
    projects: true,
  },
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

const local = {
  provider: 'llamacpp-upstream',
  active: true,
  api_key: '',
  models: [{ id: 'upstream.gguf', capabilities: ['completion'] }],
  settings: [],
}

/** Signed out: the backend holds no token, so the catalogue is empty. */
const subscriptionSignedOut = {
  provider: 'chatgpt',
  active: true,
  api_key: '',
  models: [],
  settings: [],
}

const renderWith = (providers: Record<string, unknown>[]) => {
  mockModelProvider({
    providers,
    selectedProvider: 'llamacpp-upstream',
    selectedModel: local.models[0],
    getProviderByName: vi.fn((name: string) =>
      providers.find((p) => p.provider === name)
    ),
    selectModelProvider: vi.fn(),
    getModelBy: vi.fn(),
    updateProvider: vi.fn(),
  })
  render(<DropdownModelProvider />)
}

const providerHeaders = () =>
  Array.from(
    screen
      .getByTestId('popover-content')
      .querySelectorAll('[data-testid^="provider-avatar-"]')
  ).map((el) => el.getAttribute('data-testid')?.replace('provider-avatar-', ''))

describe('DropdownModelProvider - connected providers only', () => {
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
  })

  afterEach(() => cleanup())

  it('leaves out cloud providers the user has not connected', () => {
    // The registry ships its whole catalogue `active: true`, so without a
    // connection check the picker fills with headers that list nothing.
    renderWith([
      local,
      subscriptionSignedOut,
      {
        provider: 'openai',
        active: true,
        api_key: '',
        models: [{ id: 'gpt-4o', capabilities: ['completion'] }],
        settings: [{ key: 'api-key' }],
      },
    ])

    expect(providerHeaders()).toEqual(['llamacpp-upstream'])
  })

  it('lists a signed-in subscription, which carries no API key of its own', () => {
    // The bearer token lives in the Rust backend; the model list arriving on
    // sign-in is what "connected" means here.
    renderWith([
      local,
      { ...subscriptionSignedOut, models: [{ id: 'gpt-5.1-codex', capabilities: [] }] },
    ])

    expect(providerHeaders()).toEqual(['llamacpp-upstream', 'chatgpt'])
    expect(screen.getByText('gpt-5.1-codex')).toBeInTheDocument()
  })

  it('waits for a loopback server to answer before giving it a section', () => {
    // Ollama needs no key, so "connected" says nothing about whether it is
    // running. Its catalogue is the proof.
    const ollama = {
      provider: 'ollama',
      active: true,
      api_key: '',
      base_url: 'http://localhost:11434/v1',
      models: [] as { id: string; capabilities: string[] }[],
      settings: [],
    }

    renderWith([local, ollama])
    expect(providerHeaders()).toEqual(['llamacpp-upstream'])

    cleanup()
    renderWith([
      local,
      { ...ollama, models: [{ id: 'llama3', capabilities: ['completion'] }] },
    ])
    expect(providerHeaders()).toEqual(['llamacpp-upstream', 'ollama'])
  })

  it('keeps a keyed cloud provider and its models', () => {
    renderWith([
      local,
      {
        provider: 'anthropic',
        active: true,
        api_key: 'sk-test',
        models: [{ id: 'claude-opus-5', capabilities: ['completion'] }],
        settings: [{ key: 'api-key' }],
      },
    ])

    expect(providerHeaders()).toEqual(['llamacpp-upstream', 'anthropic'])
    expect(screen.getByText('claude-opus-5')).toBeInTheDocument()
  })
})
