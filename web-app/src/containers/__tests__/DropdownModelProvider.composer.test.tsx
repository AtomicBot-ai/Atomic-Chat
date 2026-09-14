import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
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

// The panel is always in the DOM here; what these tests are about is which
// of its two views it shows. Its open state is driven from the test — the
// real Popover needs a pointer stack jsdom does not provide.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange: (open: boolean) => void
  }) => (
    <div>
      <button
        type="button"
        data-testid="popover-open"
        onClick={() => onOpenChange(true)}
      />
      <button
        type="button"
        data-testid="popover-close"
        onClick={() => onOpenChange(false)}
      />
      {children}
    </div>
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
  default: () => null,
}))

vi.mock('../ModelSupportStatus', () => ({
  ModelSupportStatus: () => <div data-testid="model-support-status" />,
}))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const thinkingModel = {
  id: 'qwen3.gguf',
  displayName: 'Qwen 3',
  capabilities: ['completion'],
  reasoning: { supportsThinking: true },
}

const providers = [
  {
    provider: 'llamacpp-upstream',
    active: true,
    api_key: '',
    models: [thinkingModel, { id: 'other.gguf', capabilities: ['completion'] }],
    settings: [],
  },
]

const selectModel = (selected: typeof thinkingModel | undefined) =>
  mockModelProvider({
    providers,
    selectedProvider: selected ? 'llamacpp-upstream' : '',
    selectedModel: selected,
    getProviderByName: vi.fn((name: string) =>
      providers.find((p) => p.provider === name)
    ),
    selectModelProvider: vi.fn(),
    getModelBy: vi.fn(),
    updateProvider: vi.fn(),
  })

const pill = () =>
  document.querySelector('[data-test-id="model-picker-trigger"]') as HTMLElement
const modelRow = () =>
  screen.queryByRole('button', { name: 'common:changeModel' })
const searchField = () => screen.queryByPlaceholderText('common:searchModels')

describe('DropdownModelProvider - the composer pill', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    seedServiceHub({
      models: {
        checkMmprojExists: vi.fn().mockResolvedValue(false),
        checkMmprojExistsAndUpdateOffloadMMprojSetting: vi
          .fn()
          .mockResolvedValue(undefined),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
    })
    localStorage.clear()
    await useGeneralSetting.persist.rehydrate()
    useGeneralSetting.setState({
      disableReasoning: false,
      reasoningBudget: 'medium',
    })
    useLeftPanel.setState({ open: false })
    useRunSettingsPanel.setState({ isOpen: false })
    selectModel(thinkingModel)
  })

  afterEach(() => {
    cleanup()
  })

  it('names the model and its reasoning level', () => {
    render(<DropdownModelProvider />)

    expect(pill()).toHaveTextContent('Qwen 3')
    expect(pill()).toHaveTextContent('common:reasoningEffort.medium')
  })

  it('opens on the model row with the effort slider under it', () => {
    render(<DropdownModelProvider />)

    // The row names the model and leads into the list, which is not on screen
    // yet. The level is the effort heading's alone: said twice, one of them
    // is noise.
    expect(modelRow()).toHaveTextContent('Qwen 3')
    expect(modelRow()).not.toHaveTextContent('common:reasoningEffort.medium')
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      'common:reasoningEffort.medium'
    )
    expect(searchField()).toBeNull()
    expect(screen.queryByText('other.gguf')).toBeNull()
  })

  it('steps into the model list and back', () => {
    render(<DropdownModelProvider />)

    fireEvent.click(modelRow()!)

    expect(searchField()).toBeInTheDocument()
    expect(screen.getByText('other.gguf')).toBeInTheDocument()
    expect(screen.queryByRole('slider')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'common:back' }))

    expect(searchField()).toBeNull()
    expect(modelRow()).toBeInTheDocument()
    expect(screen.getByRole('slider')).toBeInTheDocument()
  })

  it('relabels the pill only once the panel closes', () => {
    render(<DropdownModelProvider />)
    fireEvent.click(screen.getByTestId('popover-open'))

    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' })

    // The setting and the panel move at once; the pill, which the panel
    // hangs off, holds still until the panel is gone.
    expect(useGeneralSetting.getState().reasoningBudget).toBe('max')
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      'common:reasoningEffort.max'
    )
    expect(pill()).toHaveTextContent('common:reasoningEffort.medium')

    fireEvent.click(screen.getByTestId('popover-close'))

    expect(pill()).toHaveTextContent('common:reasoningEffort.max')
  })

  it('carries no level while reasoning is off', () => {
    useGeneralSetting.setState({ disableReasoning: true })

    render(<DropdownModelProvider />)

    // The bulb is off: the level would not apply, so the pill drops it and
    // the slider sits on its first stop, one step from thinking again.
    expect(pill()).toHaveTextContent('Qwen 3')
    expect(pill()).not.toHaveTextContent('common:reasoningEffort.medium')
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      'common:reasoningEffort.off'
    )
    expect(modelRow()).toBeInTheDocument()
  })

  it('folds down to the model mark while both side bars are open', () => {
    useLeftPanel.setState({ open: true })
    useRunSettingsPanel.setState({ isOpen: true })

    render(<DropdownModelProvider />)

    // The name leaves the pill but not the pill's name, nor its hover title.
    expect(pill()).not.toHaveTextContent('Qwen 3')
    expect(pill()).toHaveTextContent('common:reasoningEffort.medium')
    expect(pill()).toHaveAccessibleName('Qwen 3')
    expect(pill()).toHaveAttribute('title', 'qwen3.gguf')
    expect(
      within(pill()).getByTestId('provider-avatar-llamacpp-upstream')
    ).toBeInTheDocument()
  })

  it('keeps the name with one bar open, or with nothing to fold down to', () => {
    useLeftPanel.setState({ open: true })
    const oneBar = render(<DropdownModelProvider />)
    expect(pill()).toHaveTextContent('Qwen 3')
    oneBar.unmount()

    useRunSettingsPanel.setState({ isOpen: true })
    selectModel(undefined)
    render(<DropdownModelProvider />)
    expect(pill()).toHaveTextContent('common:selectAModel')
  })

  it('carries no level for a model without a thinking phase', () => {
    selectModel({ ...thinkingModel, reasoning: { supportsThinking: false } })

    render(<DropdownModelProvider />)

    expect(pill()).not.toHaveTextContent('common:reasoningEffort.medium')
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('opens straight on the list while nothing is selected', () => {
    selectModel(undefined)

    render(<DropdownModelProvider />)

    // A row that could only say "select a model" is a click for nothing, and
    // a level with no model to think at it is a promise about nothing.
    expect(pill()).toHaveTextContent('common:selectAModel')
    expect(pill()).not.toHaveTextContent('common:reasoningEffort.medium')
    expect(searchField()).toBeInTheDocument()
    expect(modelRow()).toBeNull()
  })
})
