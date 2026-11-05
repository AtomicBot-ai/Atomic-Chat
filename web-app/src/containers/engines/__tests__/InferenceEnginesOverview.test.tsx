import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import type { EngineBuild, EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    providers: () => ({ getProviders: async () => [] }),
  }),
  getServiceHub: () => ({}),
  isServiceHubInitialized: () => false,
}))
// An engine's settings form is its page's, with tests of its own.
vi.mock('@/containers/engines/EngineDetail', () => ({
  EngineDetail: () => null,
}))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key === 'turboquantEngine' || key === 'audioGeneration'
          ? true
          : key === 'mediaGeneration' || key === 'voiceInput'
            ? false
            : target[key as keyof typeof target],
    }),
  }
})

const { InferenceEnginesOverview } = await import('../InferenceEnginesOverview')

const engine = (provider: string) =>
  ({
    provider,
    active: true,
    persist: true,
    settings: [],
    models: [{ id: 'qwen' }],
  }) as unknown as ModelProvider

const engineBuild = (
  version: string,
  origin: EngineBuild['origin']
): EngineBuild => ({
  version,
  variant: 'macos-arm64',
  origin,
  active: false,
  in_use: false,
  removable: origin !== 'bundled',
  ...(origin === 'bundled' && { not_removable_reason: 'bundled' as const }),
})

const versions = (
  id: string,
  builds: EngineBuild[],
  active: EngineVersions['active']
): EngineVersions => ({
  engine: id as EngineVersions['engine'],
  kind: 'llamacpp',
  active_choice: 'client',
  builds,
  active,
  latest: null,
  update: { needed: false, target: null, apply: 'swap' },
  source: 'remote',
  source_error: null,
  error: null,
})

const statusOf = (provider: string) =>
  within(screen.getByTestId(`engine-row-${provider}`)).getByRole('status')

describe('the audio engine row', () => {
  const audioVersions = (update?: Partial<EngineVersions['update']>) => ({
    ...versions('audio-cpp', [engineBuild('v0.9.3', 'downloaded')], {
      version: 'v0.9.3',
      variant: 'macos-arm64',
    }),
    kind: 'engine-build' as const,
    active_choice: 'core' as const,
    ...(update
      ? {
          update: {
            needed: false,
            target: null,
            apply: 'swap' as const,
            ...update,
          },
        }
      : {}),
  })

  beforeEach(() => {
    useModelProvider.setState({ providers: [engine('llamacpp-upstream')] })
  })

  it('is not drawn while the core does not report the engine (core 0.20.5)', () => {
    act(() =>
      useEngineVersionsStore.setState({
        engines: {
          'llamacpp-upstream': versions('llamacpp-upstream', [], null),
        },
        error: null,
      })
    )

    render(<InferenceEnginesOverview />)

    expect(screen.getByTestId('engine-row-llamacpp-upstream')).toBeTruthy()
    expect(screen.queryByTestId('engine-row-audio-cpp')).toBeNull()
    expect(screen.queryByText('audios:engine.groupTitle')).toBeNull()
  })

  it('appears once the core reports it, and offers the core’s update', () => {
    act(() =>
      useEngineVersionsStore.setState({
        engines: {
          'audio-cpp': audioVersions({
            needed: true,
            target: { version: 'v0.9.4', variant: 'macos-arm64' },
          }),
        },
        error: null,
      })
    )

    render(<InferenceEnginesOverview />)

    const row = screen.getByTestId('engine-row-audio-cpp')
    expect(row.textContent).toContain('audio.cpp')
    expect(row.textContent).toContain('audios:engine.rowDescription')
    expect(within(row).getByRole('status')).toBeTruthy()
  })
})

describe('opening the page for one engine (the model picker’s gear)', () => {
  beforeEach(() => {
    useModelProvider.setState({
      providers: [engine('llamacpp-upstream'), engine('llamacpp')],
    })
    act(() => useEngineVersionsStore.setState({ engines: {}, error: null }))
  })

  const settingsOf = (provider: string) =>
    within(screen.getByTestId(`engine-row-${provider}`)).queryByRole('region')

  it('unfolds that engine’s row and scrolls to it, leaving the others folded', () => {
    const original = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<InferenceEnginesOverview openEngine="llamacpp-upstream" />)

      expect(settingsOf('llamacpp-upstream')).not.toBeNull()
      expect(settingsOf('llamacpp')).toBeNull()
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.contexts[0]).toBe(
        screen.getByTestId('engine-row-llamacpp-upstream')
      )
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('unfolds the row again for a later link to it, after it was folded', () => {
    const { rerender } = render(
      <InferenceEnginesOverview openEngine="llamacpp-upstream" />
    )
    act(() =>
      within(screen.getByTestId('engine-row-llamacpp-upstream'))
        .getByRole('button', {
          name: 'providers:overview.collapseSettings',
        })
        .click()
    )
    expect(settingsOf('llamacpp-upstream')).toBeNull()

    // The update banner's reinstall links here again, asking to confirm.
    rerender(
      <InferenceEnginesOverview openEngine="llamacpp-upstream" engineUpdate />
    )

    expect(settingsOf('llamacpp-upstream')).not.toBeNull()
  })

  it('keeps every row folded without one', () => {
    render(<InferenceEnginesOverview />)

    expect(settingsOf('llamacpp-upstream')).toBeNull()
    expect(settingsOf('llamacpp')).toBeNull()
  })
})

describe('the status of a language engine row', () => {
  beforeEach(() => {
    useModelProvider.setState({
      providers: [
        engine('llamacpp-upstream'),
        engine('llamacpp'),
        engine('atomic-prism'),
      ],
    })
  })

  // QA 2.2.21: TurboQuant held the bundled and a downloaded build, neither active, and its row
  // said "Not installed".
  it('says no build is active when builds are installed but none is', () => {
    act(() => {
      useEngineVersionsStore.setState({
        engines: {
          'llamacpp-upstream': versions(
            'llamacpp-upstream',
            [{ ...engineBuild('b11443', 'bundled'), active: true }],
            { version: 'b11443', variant: 'macos-arm64' }
          ),
          'llamacpp': versions(
            'llamacpp',
            [
              engineBuild('b10298-2.0.0', 'bundled'),
              engineBuild('b10269-1.6.0', 'downloaded'),
            ],
            null
          ),
          'atomic-prism': versions('atomic-prism', [], null),
        },
      })
    })

    render(<InferenceEnginesOverview />)

    expect(statusOf('llamacpp')).toHaveAttribute('data-status', 'noActiveBuild')
    expect(statusOf('llamacpp')).toHaveTextContent(
      'providers:overview.updateStatus.noActiveBuild'
    )
    // "Not installed" stays for an engine with nothing on disk.
    expect(statusOf('atomic-prism')).toHaveTextContent(
      'providers:overview.updateStatus.notInstalled'
    )
    expect(statusOf('llamacpp-upstream')).toHaveTextContent(
      'providers:overview.updateStatus.upToDate'
    )
  })
})
