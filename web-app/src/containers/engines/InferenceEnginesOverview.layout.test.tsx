import { render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import {
  XL_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

import { InferenceEnginesOverview } from './InferenceEnginesOverview'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params: _params,
    ...props
  }: {
    children: React.ReactNode
    to: string
    params?: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

const getActiveModels = vi.fn(async (provider?: string) =>
  provider === 'llamacpp-upstream' ? ['qwen'] : []
)
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    providers: () => ({ getProviders: async () => [] }),
    models: () => ({ getActiveModels, stopAllModels: async () => {} }),
  }),
  getServiceHub: () => ({}),
  isServiceHubInitialized: () => false,
}))

// The panels have layout tests of their own; here they stand in with a block
// as wide as their column allows.
vi.mock('@/containers/images/MediaSettingsPanel', () => ({
  MediaSettingsPanel: () => (
    <div data-testid="media-settings-panel" className="h-40 w-full" />
  ),
}))
vi.mock('@/containers/VoiceSettingsPanel', () => ({
  VoiceSettingsPanel: () => (
    <div data-testid="voice-settings-panel" className="h-40 w-full" />
  ),
}))

vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key === 'mediaGeneration' ||
        key === 'voiceInput' ||
        key === 'turboquantEngine'
          ? true
          : target[key as keyof typeof target],
    }),
  }
})

const engine = (provider: string, active: boolean, models: number) =>
  ({
    provider,
    active,
    persist: true,
    settings: [],
    models: Array.from({ length: models }, (_, i) => ({ id: `m${i}` })),
  }) as unknown as ModelProvider

// Worst-case copy: a managed engine's build is its descriptor id.
const LONG_BUILD = 'vllm-0.11.2-cu128-py312-ubuntu24.04-x86_64-2026.10.14'

const versions = (
  id: string,
  active: string,
  update: boolean
): EngineVersions =>
  ({
    engine: id,
    builds: [],
    active: { version: active, variant: 'macos-arm64' },
    latest: null,
    update: {
      needed: update,
      target: update ? { version: `${active}-next`, variant: 'x' } : null,
      apply: 'swap',
    },
  }) as unknown as EngineVersions

function seed() {
  useModelProvider.setState({
    providers: [
      engine('llamacpp-upstream', true, 128),
      engine('llamacpp', false, 3),
      engine('atomic-prism', true, 1),
      engine('foundry-local', true, 12),
      engine('vllm', true, 0),
      engine('tensorrt-llm', false, 0),
    ],
  })
  useEngineVersionsStore.setState({
    engines: {
      'llamacpp-upstream': versions('llamacpp-upstream', 'b10840', true),
      'llamacpp': versions('llamacpp', 'b9999-9.9.9', false),
      'atomic-prism': versions('atomic-prism', 'prism-b10777', true),
      'vllm': versions('vllm', LONG_BUILD, true),
      'sd-cpp': versions('sd-cpp', 'master-883-137f740-a36f1b1a', true),
    },
  })
  useImageGenerationStore.setState({ status: null })
  useAppState.setState({ activeModels: [] })
}

async function renderPage(width: number, fontSize: string, language: string) {
  await page.viewport(width, 800)
  setFontSize(fontSize)
  i18n.changeLanguage(language)
  seed()
  // The page column beside the 60 px rail and the 256 px sidebar.
  const { container } = render(
    <div className="flex w-full">
      <aside className="w-[316px] shrink-0">Sidebar</aside>
      <main data-testid="column" className="min-w-0 flex-1">
        {withTranslations(<InferenceEnginesOverview />)}
      </main>
    </div>
  )
  // The status comes from an async ask after the first render.
  await vi.waitFor(() =>
    expect(container.querySelector('[data-status="running"]')).not.toBeNull()
  )
  await settle(container)
  return screen.getByTestId('column')
}

const rows = (column: HTMLElement) =>
  Array.from(column.querySelectorAll<HTMLElement>('li[data-testid]'))

beforeEach(() => {
  getActiveModels.mockClear()
})

describe.each(['en', 'ru'])(
  'the inference engines overview in %s',
  (language) => {
    it.each(
      [1024, 1280].flatMap((width) =>
        ['16px', XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
      )
    )(
      'keeps every row on one line inside its card at $width px / $fontSize',
      async ({ width, fontSize }) => {
        const column = await renderPage(width, fontSize, language)

        expectNoHorizontalOverflow(column)
        // The title truncates by design; at these widths it never has to.
        const title = column.querySelector('h1')!
        expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth)
        for (const heading of column.querySelectorAll<HTMLElement>(
          'h2 > span'
        )) {
          expectOneLine(heading)
        }

        const all = rows(column)
        expect(all).toHaveLength(8)
        for (const row of all) {
          const status = row.querySelector<HTMLElement>('[data-status]')!
          expectOneLine(status.lastElementChild as HTMLElement)
          expectFits(status, row)
          const chevron = row.querySelector(
            'svg.lucide-chevron-right, svg.lucide-chevron-down'
          )!
          expectFits(chevron, row)
          const toggle = row.querySelector('[role="switch"]')
          if (toggle) expectFits(toggle, row)
          for (const badge of within(row).queryAllByText(
            i18n.t('providers:overview.updateAvailable')
          )) {
            expectOneLine(badge)
            expectFits(badge.parentElement!, row)
          }
        }

        // One stable status column: the right edges line up across groups,
        // the media and voice rows keeping the switch's slot.
        const rights = all.map(
          (row) =>
            row.querySelector('[data-status]')!.getBoundingClientRect().right
        )
        for (const right of rights)
          expect(Math.abs(right - rights[0])).toBeLessThanOrEqual(1)

        expectSameHeight(all)
      }
    )
  }
)

describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
  it('opens the media settings inside the card without widening it', async () => {
    setTheme(theme)
    const column = await renderPage(1024, XL_FONT_SIZE, 'en')
    const media = screen.getByTestId('engine-row-sd-cpp')
    const before = media.getBoundingClientRect().width

    within(media).getByRole('button').click()
    await settle(column)

    const panel = screen.getByTestId('media-settings-panel')
    expectFits(panel, media)
    expect(media.getBoundingClientRect().width).toBeCloseTo(before, 0)
    expectNoHorizontalOverflow(column)
  })
})
