import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import type { ModelsService } from '@/services/models/types'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  resumeDownload: vi.fn(),
  abortDownload: vi.fn(async () => {}),
}))

vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'common:selectAModel') return 'Select Model'
      if (key === 'onboarding-handoff:picker.downloading')
        return `Downloading ${vars?.percent}%`
      if (key === 'onboarding-handoff:picker.paused')
        return `Paused ${vars?.percent}%`
      if (key === 'onboarding-handoff:picker.interrupted')
        return 'Download interrupted'
      if (key === 'onboarding-handoff:picker.trigger')
        return `${vars?.name} · ${vars?.status}`
      return vars ? `${key}:${JSON.stringify(vars)}` : key
    },
  }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: () => ({ favoriteModels: [] }),
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))
vi.mock('../ProvidersAvatar', () => ({ default: () => null }))
vi.mock('../ModelSupportStatus', () => ({ ModelSupportStatus: () => null }))
vi.mock('@/lib/downloadResume', () => ({
  resumeDownload: mocks.resumeDownload,
}))

const chat: OnboardingJob = {
  key: 'chat',
  kind: 'chat',
  title: 'Qwen3.5 4B',
  taskId: 'Qwen3.5-4B-Q4_K_M',
  phase: 'running',
}

type PickerState = {
  providers: ModelProvider[]
  selectedProvider: string
  selectedModel: Model | undefined
  getProviderByName: (name: string) => ModelProvider | undefined
  selectModelProvider: ReturnType<typeof vi.fn>
  updateProvider: ReturnType<typeof vi.fn>
}

let state: PickerState
const mockProviders = (overrides: Partial<PickerState> = {}) => {
  const providers = overrides.providers ?? [
    {
      provider: 'llamacpp-upstream',
      active: true,
      models: [],
      settings: [],
    } as unknown as ModelProvider,
  ]
  state = {
    providers,
    selectedProvider: '',
    selectedModel: undefined,
    getProviderByName: (name: string) =>
      providers.find((provider) => provider.provider === name),
    selectModelProvider: vi.fn(),
    updateProvider: vi.fn(),
    ...overrides,
  }
  vi.mocked(useModelProvider).mockImplementation(((selector?: any) =>
    selector ? selector(state) : state) as never)
}

const trigger = () =>
  document.querySelector(
    '[data-test-id="model-picker-trigger"]'
  ) as HTMLButtonElement

const downloadAt = (progress: number) =>
  useDownloadStore.setState({
    downloads: {
      [chat.taskId]: {
        id: chat.taskId,
        name: chat.taskId,
        progress,
        current: progress * 100,
        total: 100,
      },
    },
  } as never)

describe('DropdownModelProvider while the first run downloads its model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal('IS_MACOS', false)
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      resumeParams: {},
      downloadOriginByModelId: {},
    })
    seedServiceHub({
      models: {
        getActiveModels: vi.fn().mockResolvedValue([]),
        checkMmprojExists: vi.fn().mockResolvedValue(false),
        abortDownload: mocks.abortDownload,
      } as unknown as ModelsService,
    })
    useOnboardingStore.getState().reset()
    const run = useOnboardingStore.getState()
    run.begin('full', 'model')
    run.enqueue(chat)
    run.handOff('chat')
    downloadAt(0.42)
    mockProviders()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reads how far the download is, with a spinner, and names the model', () => {
    render(<DropdownModelProvider />)

    expect(trigger()).toHaveTextContent('Downloading 42%')
    expect(trigger()).toHaveAccessibleName('Qwen3.5 4B · Downloading 42%')
    expect(screen.getByTestId('model-picker-pending-spinner')).toHaveClass(
      'animate-spin',
      'motion-reduce:animate-none'
    )
    expect(screen.getByTestId('model-picker-pill-shell')).toHaveClass('w-44')
  })

  it('says Paused with the progress kept, and the spinner stops', () => {
    useDownloadStore.setState({ pausedDownloads: new Set([chat.taskId]) })
    render(<DropdownModelProvider />)

    expect(trigger()).toHaveTextContent('Paused 42%')
    expect(screen.getByTestId('model-picker-pending-spinner')).not.toHaveClass(
      'animate-spin'
    )
  })

  it('says the download was interrupted, and offers Retry', () => {
    useOnboardingStore.getState().setJobPhase(chat.key, 'failed')
    render(<DropdownModelProvider />)

    expect(trigger()).toHaveTextContent('Download interrupted')
    expect(screen.getByTestId('model-picker-pending')).toHaveTextContent(
      'onboarding-handoff:picker.retry'
    )
  })

  it('shows the model with its progress at the top of the panel, not again in the list', () => {
    useDownloadStore.setState({
      localDownloadingModels: new Set([chat.taskId]),
    })
    render(<DropdownModelProvider />)

    const section = screen.getByRole('region', {
      name: 'onboarding-handoff:picker.section',
    })
    expect(section).toHaveTextContent('Qwen3.5 4B')
    expect(section).toHaveTextContent('42%')
    expect(
      screen.getByRole('progressbar', {
        name: 'onboarding-handoff:picker.progress:{"name":"Qwen3.5 4B"}',
      })
    ).toHaveAttribute('aria-valuenow', '42')
    expect(
      screen.queryByTestId('model-picker-downloading')
    ).not.toBeInTheDocument()
  })

  it('pauses and resumes from the panel', () => {
    const { rerender } = render(<DropdownModelProvider />)

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-handoff:picker.pause' })
    )
    expect(useDownloadStore.getState().pausedDownloads.has(chat.taskId)).toBe(
      true
    )
    rerender(<DropdownModelProvider />)

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-handoff:picker.resume' })
    )
    expect(mocks.resumeDownload).toHaveBeenCalledWith(
      { id: chat.taskId, name: chat.taskId },
      expect.anything()
    )
    expect(trigger()).toHaveTextContent('Paused 42%')
  })

  it('goes back to the model name once something is selected', () => {
    const model = { id: 'gpt-5' } as Model
    mockProviders({
      providers: [
        {
          provider: 'openai',
          active: true,
          api_key: 'configured',
          models: [model],
          settings: [],
        } as unknown as ModelProvider,
      ],
      selectedProvider: 'openai',
      selectedModel: model,
    })
    render(<DropdownModelProvider />)

    expect(trigger()).not.toHaveTextContent('Downloading')
    expect(screen.queryByTestId('model-picker-pending')).not.toBeInTheDocument()
  })

  it('is gone once the model is ready', () => {
    useOnboardingStore.getState().setJobPhase(chat.key, 'done')
    render(<DropdownModelProvider />)

    expect(trigger()).toHaveTextContent('Select Model')
    expect(screen.queryByTestId('model-picker-pending')).not.toBeInTheDocument()
  })

  it('keeps a model selected while it asked which models are running', async () => {
    let answer: (ids: string[]) => void = () => {}
    seedServiceHub({
      models: {
        getActiveModels: vi.fn(
          () =>
            new Promise<string[]>((resolve) => {
              answer = resolve
            })
        ),
        checkMmprojExists: vi.fn().mockResolvedValue(false),
      } as unknown as ModelsService,
    })
    const { rerender } = render(<DropdownModelProvider />)

    // The run's model lands and is selected before the answer comes back.
    const model = { id: chat.taskId } as Model
    mockProviders({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as unknown as ModelProvider,
      ],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: model,
      selectModelProvider: state.selectModelProvider,
    })
    // A new prop gets the memoized picker past its bail-out, as a store
    // update would.
    rerender(<DropdownModelProvider className="landed" />)
    await act(async () => answer([]))

    expect(state.selectModelProvider).not.toHaveBeenCalledWith('', '')
    expect(trigger()).toHaveTextContent('Qwen3.5 4B')
  })
})
