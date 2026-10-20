import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import { refreshAppManagedProviders } from '@/lib/provider-visibility'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { withTranslations } from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { Route as ProvidersRoute } from '../index'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => config,
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode
    to: string
    params?: Record<string, string>
    className?: string
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (href, [key, value]) => href.replace(`$${key}`, value),
        to
      )}
      className={className}
    >
      {children}
    </a>
  ),
}))

// The panels are their own pages' subject; here they only have to open.
vi.mock('@/containers/images/MediaSettingsPanel', () => ({
  MediaSettingsPanel: () => <div data-testid="media-settings-panel" />,
}))
vi.mock('@/containers/VoiceSettingsPanel', () => ({
  VoiceSettingsPanel: () => <div data-testid="voice-settings-panel" />,
}))

vi.mock('@/lib/provider-visibility', () => ({
  refreshAppManagedProviders: vi.fn().mockResolvedValue(false),
}))

const platform = vi.hoisted(() => ({
  mediaGeneration: true,
  voiceInput: true,
  turboquantEngine: true,
}))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key in platform
          ? platform[key as keyof typeof platform]
          : target[key as keyof typeof target],
    }),
  }
})

const engine = (
  provider: string,
  active = true,
  models: string[] = []
): ModelProvider =>
  ({
    provider,
    active,
    persist: true,
    models: models.map((id) => ({ id })),
    settings: [],
  }) as unknown as ModelProvider

const cloud = (provider: string): ModelProvider =>
  ({
    provider,
    active: true,
    models: [],
    settings: [],
  }) as unknown as ModelProvider

const versions = (
  engineId: string,
  active: string | null,
  target?: string
): EngineVersions =>
  ({
    engine: engineId,
    builds: [],
    active: active ? { version: active, variant: 'macos-arm64' } : null,
    latest: null,
    update: {
      needed: Boolean(target),
      target: target ? { version: target, variant: 'macos-arm64' } : null,
      apply: 'swap',
    },
  }) as unknown as EngineVersions

let loaded: Record<string, string[]>
const getActiveModels = vi.fn(async (provider?: string) =>
  provider ? (loaded[provider] ?? []) : []
)
const stopAllModels = vi.fn().mockResolvedValue(undefined)

const renderPage = () => {
  const Page = ProvidersRoute.component as React.ComponentType
  return render(withTranslations(<Page />))
}

const row = (testId: string) => screen.getByTestId(testId)
const statusOf = (testId: string) =>
  row(testId).querySelector('[data-status]')?.getAttribute('data-status')

describe('Inference engines overview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    i18n.changeLanguage('en')
    platform.mediaGeneration = true
    platform.voiceInput = true
    platform.turboquantEngine = true
    loaded = {}
    useModelProvider.setState({
      providers: [
        engine('llamacpp', false),
        engine('llamacpp-upstream', true, ['qwen', 'gemma']),
        cloud('openai'),
      ],
    })
    useEngineVersionsStore.setState({ engines: {} })
    useImageGenerationStore.setState({ status: null })
    useAppState.setState({ activeModels: [] })
    seedServiceHub({
      providers: {
        getProviders: vi.fn().mockResolvedValue([]),
      } as unknown as ProvidersService,
      models: {
        getActiveModels,
        stopAllModels,
      } as unknown as ModelsService,
    })
  })

  it('titles the page and groups engines by what they serve', () => {
    renderPage()

    expect(
      screen.getByRole('heading', { level: 1, name: 'Inference engines' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Language models' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Media models' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Voice models' })
    ).toBeInTheDocument()
  })

  it('lists local language engines only, upstream llama.cpp first', () => {
    useModelProvider.setState({
      providers: [
        engine('llamacpp'),
        engine('llamacpp-upstream'),
        engine('mlx'),
        cloud('openai'),
        { ...cloud('ollama'), base_url: 'http://localhost:11434/v1' },
      ],
    })
    renderPage()

    const listed = within(
      screen.getByRole('region', { name: 'Language models' })
    )
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('data-testid'))
    // IS_MACOS is false under Vitest: MLX is not listed; cloud providers,
    // Ollama included, live under Cloud providers.
    expect(listed).toEqual([
      'engine-row-llamacpp-upstream',
      'engine-row-llamacpp',
    ])
  })

  it('leaves the TurboQuant engine out where the platform has none', () => {
    platform.turboquantEngine = false
    renderPage()

    expect(screen.queryByTestId('engine-row-llamacpp')).not.toBeInTheDocument()
    expect(row('engine-row-llamacpp-upstream')).toBeInTheDocument()
  })

  it("opens each engine's own settings page, disabled ones too", () => {
    renderPage()

    expect(
      within(row('engine-row-llamacpp-upstream')).getByRole('link', {
        name: 'llama.cpp',
      })
    ).toHaveAttribute('href', '/settings/providers/llamacpp-upstream')
    expect(
      within(row('engine-row-llamacpp')).getByRole('link')
    ).toHaveAttribute('href', '/settings/providers/llamacpp')
  })

  it('shows the model count, the active build and an update offer', () => {
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': versions('llamacpp-upstream', 'b10840', 'b10909'),
        'llamacpp': versions('llamacpp', 'b9000'),
      },
    })
    renderPage()

    const upstream = within(row('engine-row-llamacpp-upstream'))
    expect(upstream.getByText('2 models · Build b10840')).toBeInTheDocument()
    expect(upstream.getByText('Update available')).toBeInTheDocument()
    const fork = within(row('engine-row-llamacpp'))
    expect(fork.getByText('0 models · Build b9000')).toBeInTheDocument()
    expect(fork.queryByText('Update available')).not.toBeInTheDocument()
  })

  it('names no build before the core has answered', () => {
    renderPage()

    expect(
      within(row('engine-row-llamacpp-upstream')).getByText('2 models')
    ).toBeInTheDocument()
  })

  it('reads Running from the models loaded on each enabled engine', async () => {
    loaded = { 'llamacpp-upstream': ['qwen'] }
    renderPage()

    await waitFor(() =>
      expect(statusOf('engine-row-llamacpp-upstream')).toBe('running')
    )
    expect(statusOf('engine-row-llamacpp')).toBe('disabled')
    // A disabled engine is not asked.
    expect(getActiveModels).not.toHaveBeenCalledWith('llamacpp')
  })

  it('asks again when a model loads or unloads anywhere', async () => {
    renderPage()
    await waitFor(() => expect(getActiveModels).toHaveBeenCalled())
    expect(statusOf('engine-row-llamacpp-upstream')).toBe('idle')

    loaded = { 'llamacpp-upstream': ['qwen'] }
    act(() => useAppState.setState({ activeModels: ['qwen'] }))

    await waitFor(() =>
      expect(statusOf('engine-row-llamacpp-upstream')).toBe('running')
    )
  })

  it('turns an engine on and off from its switch', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      within(row('engine-row-llamacpp')).getByRole('switch', {
        name: 'Turn llama.cpp turboquant on or off',
      })
    )

    expect(
      useModelProvider
        .getState()
        .providers.find((p) => p.provider === 'llamacpp')?.active
    ).toBe(true)
    expect(stopAllModels).not.toHaveBeenCalled()
  })

  it('stops every model before turning the TurboQuant engine off', async () => {
    useModelProvider.setState({
      providers: [engine('llamacpp-upstream'), engine('llamacpp', true)],
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(within(row('engine-row-llamacpp')).getByRole('switch'))

    expect(stopAllModels).toHaveBeenCalledTimes(1)
    expect(
      useModelProvider
        .getState()
        .providers.find((p) => p.provider === 'llamacpp')?.active
    ).toBe(false)
  })

  it('opens the media settings in place, with the engine build and status', async () => {
    useEngineVersionsStore.setState({
      engines: { 'sd-cpp': versions('sd-cpp', 'master-883', 'master-900') },
    })
    useImageGenerationStore.setState({
      status: { model: { state: 'ready', loaded: { id: 'flux' } } } as never,
    })
    const user = userEvent.setup()
    renderPage()

    const media = within(row('engine-row-sd-cpp'))
    expect(media.getByText('stable-diffusion.cpp')).toBeInTheDocument()
    expect(
      media.getByText('Images and videos · Build master-883')
    ).toBeInTheDocument()
    expect(media.getByText('Update available')).toBeInTheDocument()
    expect(statusOf('engine-row-sd-cpp')).toBe('running')
    expect(screen.queryByTestId('media-settings-panel')).not.toBeInTheDocument()

    const toggle = media.getByRole('button', { expanded: false })
    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('media-settings-panel')).toBeInTheDocument()
  })

  it('opens the voice settings in place and says whether the model runs', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPage()
    expect(statusOf('engine-row-voice')).toBe('notInstalled')
    unmount()

    useModelProvider.setState({
      providers: [
        engine('llamacpp-upstream', true, [
          'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M',
        ]),
      ],
    })
    loaded = {
      'llamacpp-upstream': ['ggml-org/Voxtral-Mini-3B-2507-Q4_K_M'],
    }
    renderPage()
    await waitFor(() => expect(statusOf('engine-row-voice')).toBe('running'))

    await user.click(
      within(row('engine-row-voice')).getByRole('button', { expanded: false })
    )
    expect(screen.getByTestId('voice-settings-panel')).toBeInTheDocument()
  })

  it('leaves out Media and Voice where the platform has neither', () => {
    platform.mediaGeneration = false
    platform.voiceInput = false
    renderPage()

    expect(
      screen.queryByRole('region', { name: 'Media models' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'Voice models' })
    ).not.toBeInTheDocument()
  })

  it('offers no start, stop or restart: an engine runs while a model is loaded', () => {
    renderPage()

    for (const label of [/^start/i, /^stop/i, /^restart/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('lists a gated engine that shows itself once the page asks again', async () => {
    // A TensorRT-LLM descriptor published since the app started: asking the
    // gated engines on open puts the provider in the store.
    vi.mocked(refreshAppManagedProviders).mockImplementationOnce(async () => {
      useModelProvider.setState({
        providers: [
          ...useModelProvider.getState().providers,
          engine('tensorrt-llm'),
        ],
      })
      return true
    })
    renderPage()

    expect(
      await screen.findByTestId('engine-row-tensorrt-llm')
    ).toBeInTheDocument()
  })
})
