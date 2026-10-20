import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => config,
  useNavigate: () => navigate,
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
// So is a language engine's: the engine's page renders it, settings only.
vi.mock('@/containers/engines/EngineDetail', () => ({
  EngineDetail: ({
    providerName,
    embedded,
  }: {
    providerName: string
    embedded?: boolean
  }) => (
    <div
      data-testid={`engine-detail-${providerName}`}
      data-embedded={String(embedded)}
    />
  ),
}))

const { installEngineUpdate, updater, toast } = vi.hoisted(() => ({
  installEngineUpdate: vi.fn(),
  updater: {
    recheckOptimalBackend: vi.fn(),
    downloadRecommendedBackend: vi.fn(),
    recommendationPhase: 'idle',
  },
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('@/hooks/useEngineUpdate', () => ({ installEngineUpdate }))
vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => updater,
}))
vi.mock('sonner', () => ({ toast }))

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

const renderPage = () => {
  const Page = ProvidersRoute.component as React.ComponentType
  return render(withTranslations(<Page />))
}

const row = (testId: string) => screen.getByTestId(testId)
const statusOf = (testId: string) =>
  row(testId).querySelector('[data-status]')?.getAttribute('data-status')
/** Stand in for the core's answer to "Check for updates". */
const answerVersions = (engines: Record<string, EngineVersions>) => {
  const refresh = vi.fn(async () => {
    useEngineVersionsStore.setState({ engines, error: null, loading: false })
  })
  useEngineVersionsStore.setState({ refresh })
  return refresh
}

describe('Inference engines overview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    i18n.changeLanguage('en')
    platform.mediaGeneration = true
    platform.voiceInput = true
    platform.turboquantEngine = true
    updater.recommendationPhase = 'idle'
    useModelProvider.setState({
      providers: [
        engine('llamacpp', false),
        engine('llamacpp-upstream', true, ['qwen', 'gemma']),
        cloud('openai'),
      ],
    })
    useEngineVersionsStore.setState({
      engines: {},
      error: null,
      loading: false,
      refresh: vi.fn().mockResolvedValue(undefined),
    })
    useImageGenerationStore.setState({ status: null })
    installEngineUpdate.mockResolvedValue(undefined)
    seedServiceHub({
      providers: {
        getProviders: vi.fn().mockResolvedValue([]),
      } as unknown as ProvidersService,
      models: {
        getActiveModels: vi.fn().mockResolvedValue([]),
        stopAllModels: vi.fn().mockResolvedValue(undefined),
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

  it("unfolds an engine's settings underneath it, without its models", async () => {
    const user = userEvent.setup()
    renderPage()

    expect(
      screen.queryByTestId('engine-detail-llamacpp-upstream')
    ).not.toBeInTheDocument()
    const expand = within(row('engine-row-llamacpp-upstream')).getByRole(
      'button',
      { name: 'Show llama.cpp settings' }
    )
    await user.click(expand)

    expect(expand).toHaveAttribute('aria-expanded', 'true')
    const panel = within(row('engine-row-llamacpp-upstream')).getByRole(
      'region',
      { name: 'llama.cpp settings' }
    )
    expect(
      within(panel).getByTestId('engine-detail-llamacpp-upstream')
    ).toHaveAttribute('data-embedded', 'true')

    await user.click(
      within(row('engine-row-llamacpp-upstream')).getByRole('button', {
        name: 'Hide llama.cpp settings',
      })
    )
    expect(
      screen.queryByTestId('engine-detail-llamacpp-upstream')
    ).not.toBeInTheDocument()
  })

  it('says whether each build is current, and names the model count and build', () => {
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': versions('llamacpp-upstream', 'b10840', 'b10909'),
        'llamacpp': versions('llamacpp', 'b9000'),
      },
    })
    renderPage()

    const upstream = within(row('engine-row-llamacpp-upstream'))
    expect(upstream.getByText('2 models · Build b10840')).toBeInTheDocument()
    expect(statusOf('engine-row-llamacpp-upstream')).toBe('available')
    expect(upstream.getByText('Update available')).toBeInTheDocument()
    expect(
      upstream.getByRole('button', { name: 'Update llama.cpp' })
    ).toBeInTheDocument()
    const fork = within(row('engine-row-llamacpp'))
    expect(
      fork.getByText('0 models · Build b9000 · Disabled')
    ).toBeInTheDocument()
    expect(statusOf('engine-row-llamacpp')).toBe('upToDate')
    expect(fork.queryByRole('button', { name: /^Update/ })).toBeNull()
  })

  it('says nothing about a build before the core has answered', () => {
    renderPage()

    expect(
      within(row('engine-row-llamacpp-upstream')).getByText('2 models')
    ).toBeInTheDocument()
    expect(statusOf('engine-row-llamacpp-upstream')).toBeUndefined()
  })

  it('installs an offered update through the core and asks for the new answer', async () => {
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': versions('llamacpp-upstream', 'b10840', 'b10909'),
      },
    })
    const refresh = answerVersions({
      'llamacpp-upstream': versions('llamacpp-upstream', 'b10909'),
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Update llama.cpp' }))

    expect(installEngineUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'llamacpp-upstream',
        targetBackend: 'b10909/macos-arm64',
        apply: 'swap',
      })
    )
    await waitFor(() =>
      expect(statusOf('engine-row-llamacpp-upstream')).toBe('upToDate')
    )
    expect(refresh).toHaveBeenCalled()
  })

  it("sends a reinstall to the engine's page to be confirmed there", async () => {
    useModelProvider.setState({ providers: [engine('vllm')] })
    useEngineVersionsStore.setState({
      engines: {
        vllm: {
          ...versions('vllm', '0.11.0', '0.12.0'),
          update: {
            needed: true,
            target: { version: '0.12.0', variant: 'cuda' },
            apply: 'reinstall',
          },
        } as unknown as EngineVersions,
      },
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: /^Update/ }))

    expect(installEngineUpdate).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'vllm' },
      search: { engineUpdate: true },
    })
  })

  it('says when an update would not install, and offers it again', async () => {
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': versions('llamacpp-upstream', 'b10840', 'b10909'),
      },
    })
    installEngineUpdate.mockRejectedValue(new Error('disk full'))
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Update llama.cpp' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not update the engine', {
        description: 'disk full',
      })
    )
    expect(statusOf('engine-row-llamacpp-upstream')).toBe('available')
  })

  it('checks every engine for updates from the header and says what it found', async () => {
    const refresh = answerVersions({
      'llamacpp-upstream': versions('llamacpp-upstream', 'b10840', 'b10909'),
      'sd-cpp': versions('sd-cpp', 'master-883', 'master-900'),
      // Not on this page: TurboQuant is off but still listed; MLX is not.
      'mlx': versions('mlx', 'v0.3.1', 'v0.3.2'),
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    expect(refresh).toHaveBeenCalledWith({ force: true })
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Engines with an update: 2')
    )
    expect(statusOf('engine-row-sd-cpp')).toBe('available')
  })

  it('says all engines are current when the check finds nothing', async () => {
    answerVersions({ 'llamacpp-upstream': versions('llamacpp-upstream', 'b1') })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('All engines are up to date')
    )
  })

  it('says when the check could not reach the core', async () => {
    useEngineVersionsStore.setState({
      refresh: vi.fn(async () => {
        useEngineVersionsStore.setState({
          error: { code: 'NETWORK', message: 'offline' },
        })
      }),
    })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not check for engine updates',
        { description: 'offline' }
      )
    )
  })

  it('offers Find optimal backend on the llama.cpp rows on Linux and Windows, and installs what it finds', async () => {
    vi.stubGlobal('IS_LINUX', true)
    updater.recheckOptimalBackend.mockResolvedValue({
      currentBackend: 'b1/linux-x64-cpu',
      recommendedBackend: 'b1/linux-x64-cuda',
      recommendedCategory: 'cuda',
    })
    updater.downloadRecommendedBackend.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage()

    expect(
      within(row('engine-row-llamacpp')).getByRole('button', {
        name: 'Find optimal backend',
      })
    ).toBeInTheDocument()
    await user.click(
      within(row('engine-row-llamacpp-upstream')).getByRole('button', {
        name: 'Find optimal backend',
      })
    )

    expect(updater.recheckOptimalBackend).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(updater.downloadRecommendedBackend).toHaveBeenCalledWith(
        'b1/linux-x64-cuda'
      )
    )
  })

  it('offers no Find optimal backend on macOS', () => {
    renderPage()

    expect(
      screen.queryByRole('button', { name: 'Find optimal backend' })
    ).not.toBeInTheDocument()
  })

  it('opens the media settings in place, with the engine build and its update', async () => {
    useEngineVersionsStore.setState({
      engines: { 'sd-cpp': versions('sd-cpp', 'master-883', 'master-900') },
    })
    const user = userEvent.setup()
    renderPage()

    const media = within(row('engine-row-sd-cpp'))
    expect(media.getByText('stable-diffusion.cpp')).toBeInTheDocument()
    expect(
      media.getByText('Images and videos · Build master-883')
    ).toBeInTheDocument()
    expect(statusOf('engine-row-sd-cpp')).toBe('available')
    expect(
      media.getByRole('button', { name: 'Update stable-diffusion.cpp' })
    ).toBeInTheDocument()
    expect(screen.queryByTestId('media-settings-panel')).not.toBeInTheDocument()

    await user.click(
      media.getByRole('button', { name: 'Show stable-diffusion.cpp settings' })
    )

    expect(screen.getByTestId('media-settings-panel')).toBeInTheDocument()
  })

  it('opens the voice settings in place and says whether the model is there', async () => {
    useEngineVersionsStore.setState({
      engines: { 'llamacpp-upstream': versions('llamacpp-upstream', 'b10840') },
    })
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
    renderPage()
    // Voxtral runs on stock llama.cpp: its build is that engine's.
    expect(statusOf('engine-row-voice')).toBe('upToDate')

    await user.click(
      within(row('engine-row-voice')).getByRole('button', {
        name: /^Show .* settings$/,
      })
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
