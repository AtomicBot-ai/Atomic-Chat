import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { getModelDisplayName } from '@/lib/utils'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

// Define basic types to avoid missing declarations
type ModelProvider = {
  provider: string
  active: boolean
  models: Array<{
    id: string
    displayName?: string
    capabilities: string[]
  }>
  settings: unknown[]
}

type Model = {
  id: string
  displayName?: string
  capabilities?: string[]
}

type MockHookReturn = {
  providers: ModelProvider[]
  selectedProvider: string
  selectedModel: Model
  getProviderByName: (name: string) => ModelProvider | undefined
  selectModelProvider: () => void
  getModelBy: (id: string) => Model | undefined
  updateProvider: () => void
}

// Mock the dependencies
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

// The component subscribes with selectors, so the mock has to apply them.
const mockModelProvider = (state: MockHookReturn) => {
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

// Mock UI components
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

/**
 * Renders the picker and steps from the model row into the list. The panel
 * opens on the row whenever a model is selected — the list is one click in —
 * and the list is what these tests are about.
 */
const renderPicker = () => {
  const result = render(<DropdownModelProvider />)
  const row = screen.queryByRole('button', { name: 'common:changeModel' })
  if (row) fireEvent.click(row)
  return result
}

describe('DropdownModelProvider - Display Name Integration', () => {
  const mockProviders: ModelProvider[] = [
    {
      provider: 'llamacpp',
      active: true,
      models: [
        {
          id: 'model1.gguf',
          displayName: 'Custom Model 1',
          capabilities: ['completion'],
        },
        {
          id: 'model2-very-long-filename.gguf',
          displayName: 'Short Name',
          capabilities: ['completion'],
        },
        {
          id: 'model3.gguf',
          // No displayName - should fall back to ID
          capabilities: ['completion'],
        },
      ],
      settings: [],
    },
  ]

  const mockSelectedModel = {
    id: 'model1.gguf',
    displayName: 'Custom Model 1',
    capabilities: ['completion'],
  }

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

    // Reset the mock for each test
    mockModelProvider({
      providers: mockProviders,
      selectedProvider: 'llamacpp',
      selectedModel: mockSelectedModel,
      getProviderByName: vi.fn((name: string) =>
        mockProviders.find((p: ModelProvider) => p.provider === name)
      ),
      selectModelProvider: vi.fn(),
      getModelBy: vi.fn((id: string) =>
        mockProviders[0].models.find((m: Model) => m.id === id)
      ),
      updateProvider: vi.fn(),
    } as MockHookReturn)
  })

  afterEach(() => {
    cleanup()
  })

  it.each(['llamacpp', 'llamacpp-upstream'])(
    'gives %s an accessible settings button with transparent rest and a separated status slot',
    (provider) => {
      const configured = { ...mockProviders[0], provider }
      mockModelProvider({
        providers: [configured],
        selectedProvider: provider,
        selectedModel: mockSelectedModel,
        getProviderByName: () => configured,
        selectModelProvider: vi.fn(),
        getModelBy: vi.fn(),
        updateProvider: vi.fn(),
      })
      renderPicker()
      const gear = screen.getByRole('button', {
        name: 'common:modelPicker.providerSettings',
      })
      expect(gear).toHaveClass(
        'bg-transparent',
        'hover:bg-secondary-foreground/8',
        'focus-visible:bg-secondary-foreground/8'
      )
      expect(gear.parentElement).toHaveClass('gap-3')
    }
  )

  it('should display custom model name in the trigger button', () => {
    renderPicker()

    // Should show the display name in both trigger and dropdown
    expect(screen.getAllByText('Custom Model 1')).toHaveLength(2) // One in trigger, one in dropdown
    // Model ID should not be visible as text (it's only in title attributes)
    expect(screen.queryByDisplayValue('model1.gguf')).not.toBeInTheDocument()
  })

  it('uses a compact label and keeps the full ID in the tooltip when no displayName is set', () => {
    mockModelProvider({
      providers: mockProviders,
      selectedProvider: 'llamacpp',
      selectedModel: mockProviders[0].models[2], // model3 without displayName
      getProviderByName: vi.fn((name: string) =>
        mockProviders.find((p: ModelProvider) => p.provider === name)
      ),
      selectModelProvider: vi.fn(),
      getModelBy: vi.fn((id: string) =>
        mockProviders[0].models.find((m: Model) => m.id === id)
      ),
      updateProvider: vi.fn(),
    } as MockHookReturn)

    renderPicker()

    expect(screen.getAllByText('Model3')).toHaveLength(2) // Trigger and dropdown
    expect(screen.getAllByTitle('model3.gguf').length).toBeGreaterThanOrEqual(2)
  })

  it('should show display names in the model list items', () => {
    renderPicker()

    // Check if the display names are shown in the options
    expect(screen.getAllByText('Custom Model 1')).toHaveLength(2) // Selected: Trigger + dropdown
    expect(screen.getByText('Short Name')).toBeInTheDocument() // Only in dropdown
    expect(screen.getByText('Model3')).toBeInTheDocument() // Only in dropdown
  })

  it('deduplicates favorites by model id and prefers the nicknamed copy', () => {
    const duplicateProviders: ModelProvider[] = [
      {
        provider: 'llamacpp',
        active: true,
        models: [
          {
            id: 'shared-model.gguf',
            capabilities: ['completion'],
          },
        ],
        settings: [],
      },
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [
          {
            id: 'shared-model.gguf',
            displayName: 'Shared Model',
            capabilities: ['completion'],
          },
        ],
        settings: [],
      },
    ]

    vi.mocked(useFavoriteModel).mockReturnValue({
      favoriteModels: [{ id: 'shared-model.gguf' } as Model],
      addFavorite: vi.fn(),
      removeFavorite: vi.fn(),
      isFavorite: vi.fn(),
      toggleFavorite: vi.fn(),
    })
    mockModelProvider({
      providers: duplicateProviders,
      selectedProvider: 'llamacpp',
      selectedModel: duplicateProviders[0].models[0],
      getProviderByName: vi.fn((name: string) =>
        duplicateProviders.find((provider) => provider.provider === name)
      ),
      selectModelProvider: vi.fn(),
      getModelBy: vi.fn(),
      updateProvider: vi.fn(),
    } as MockHookReturn)

    renderPicker()

    // One favorite and one provider row remain, but both now use the same
    // compact human label instead of exposing the raw filename.
    expect(screen.getAllByText('Shared Model')).toHaveLength(2)
    expect(screen.queryByText('shared-model.gguf')).toBeNull()
    expect(screen.getAllByTitle('shared-model.gguf')).toHaveLength(2)
  })

  it('should use getModelDisplayName utility correctly', () => {
    // Test the utility function directly with different model scenarios
    const modelWithDisplayName = {
      id: 'long-model-name.gguf',
      displayName: 'Short Name',
    } as Model

    const modelWithoutDisplayName = {
      id: 'model-without-display-name.gguf',
    } as Model

    const modelWithEmptyDisplayName = {
      id: 'model-with-empty.gguf',
      displayName: '',
    } as Model

    expect(getModelDisplayName(modelWithDisplayName)).toBe('Short Name')
    expect(getModelDisplayName(modelWithoutDisplayName)).toBe(
      'model-without-display-name.gguf'
    )
    expect(getModelDisplayName(modelWithEmptyDisplayName)).toBe(
      'model-with-empty.gguf'
    )
  })

  it('should maintain model ID for internal operations while showing display name', () => {
    const mockSelectModelProvider = vi.fn()

    mockModelProvider({
      providers: mockProviders,
      selectedProvider: 'llamacpp',
      selectedModel: mockSelectedModel,
      getProviderByName: vi.fn((name: string) =>
        mockProviders.find((p: ModelProvider) => p.provider === name)
      ),
      selectModelProvider: mockSelectModelProvider,
      getModelBy: vi.fn((id: string) =>
        mockProviders[0].models.find((m: Model) => m.id === id)
      ),
      updateProvider: vi.fn(),
    } as MockHookReturn)

    renderPicker()

    // Verify that display name is shown in UI
    expect(screen.getAllByText('Custom Model 1')).toHaveLength(2) // Trigger + dropdown

    // The actual model ID should still be preserved for backend operations
    // This would be tested in the click handlers, but that requires more complex mocking
    expect(mockSelectedModel.id).toBe('model1.gguf')
  })

  it('should handle updating display model when selection changes', () => {
    // Set up mock for model2 selection
    mockModelProvider({
      providers: mockProviders,
      selectedProvider: 'llamacpp',
      selectedModel: mockProviders[0].models[1], // model2 with displayName "Short Name"
      getProviderByName: vi.fn((name: string) =>
        mockProviders.find((p: ModelProvider) => p.provider === name)
      ),
      selectModelProvider: vi.fn(),
      getModelBy: vi.fn((id: string) =>
        mockProviders[0].models.find((m: Model) => m.id === id)
      ),
      updateProvider: vi.fn(),
    } as MockHookReturn)

    // Render with model2 selected
    renderPicker()

    // Check trigger shows Short Name
    expect(
      screen.getByRole('button', { name: /short name/i })
    ).toHaveTextContent('Short Name')
    // Short Name appears in dropdown (at least 1 occurrence)
    expect(screen.getAllByText('Short Name').length).toBeGreaterThanOrEqual(1)
    // Custom Model 1 is also in the dropdown
    expect(screen.getAllByText('Custom Model 1').length).toBeGreaterThanOrEqual(
      1
    )
  })

  it('keeps a long provider title on one line and leaves the gear after it', () => {
    // A future in-process engine can carry a long display name; it must not
    // wrap and push the status dot or settings control.
    const chatgptProviders: ModelProvider[] = [
      {
        provider: 'a-very-long-local-inference-engine-name',
        active: true,
        models: [{ id: 'gpt-5-codex', capabilities: ['completion'] }],
        settings: [],
        persist: true,
      },
    ] as ModelProvider[]
    mockModelProvider({
      providers: chatgptProviders,
      selectedProvider: 'a-very-long-local-inference-engine-name',
      selectedModel: chatgptProviders[0].models[0],
      getProviderByName: vi.fn((name: string) =>
        chatgptProviders.find((p) => p.provider === name)
      ),
      selectModelProvider: vi.fn(),
      getModelBy: vi.fn(),
      updateProvider: vi.fn(),
    } as MockHookReturn)

    renderPicker()

    const title = screen.getByText('A-very-long-local-inference-engine-name')
    expect(title).toHaveClass('truncate')
    expect(title).toHaveAttribute(
      'title',
      'A-very-long-local-inference-engine-name'
    )

    const header = title.parentElement?.parentElement
    expect(header).not.toBeNull()
    const gear = header!.querySelector('svg.tabler-icon-settings')
    expect(gear).not.toBeNull()
    expect(
      title.compareDocumentPosition(gear!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
