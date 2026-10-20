import { render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import {
  makeCatalog,
  makeFilesFor,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'
import type { ModelSetupService } from '@/services/model-setup/types'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  expectSameWidth,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'

import { DownloadsPage } from './DownloadsPage'

const GB = 1024 ** 3

// Importing the registry store fires a background fetch.
vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { providers: [], hasInitialized: true, refresh: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        providers: [],
        hasInitialized: true,
        refresh: vi.fn(),
      }),
    }
  ),
  isKnownProvider: () => true,
  ensureRegistryLoaded: async () => [],
}))

// A worst-case id: a long-tail Hugging Face GGUF the catalog never named.
const LONG_ID =
  'unsloth/' + 'VeryLongFineTunedModelName'.repeat(5) + '-UD-Q4_K_XL'

const provider = (name: string, models: Partial<Model>[]): ModelProvider =>
  ({
    active: true,
    provider: name,
    persist: true,
    settings: [],
    models: models.map((model) => ({ id: 'unset', ...model })),
  }) as ModelProvider

function seed() {
  useModelProvider.setState({
    deletedModels: [],
    providers: [
      provider('llamacpp-upstream', [
        // A two-digit GB size.
        { id: LONG_ID, sizeBytes: 48.7 * GB },
        { id: 'unsloth/Qwen3.5-4B-Q4_K_M', sizeBytes: 2.5 * GB },
      ]),
      provider('mlx', [{ id: 'Qwen3.5-4B-4bit', sizeBytes: 2.4 * GB }]),
    ],
  })
  const catalog = makeCatalog([Z_IMAGE])
  const modelFiles = makeFilesFor(Z_IMAGE, 'q8_0')
  useImageGenerationStore.setState({
    catalog,
    modelFiles,
    installedArtifacts: listInstalledArtifacts(catalog, modelFiles),
  })
  useEmbeddingStore.setState({
    catalog: getBaselineEmbeddingCatalog(),
    installed: { [getBaselineEmbeddingCatalog().models[0].id]: true },
    bind: () => () => {},
  })
  useDecisionStore.setState({
    catalog: getBaselineDecisionCatalog(),
    installed: {},
    bind: () => () => {},
  })
  useEngineVersionsStore.setState({
    engines: {
      'llamacpp-upstream': {
        engine: 'llamacpp-upstream',
        kind: 'llamacpp',
        active_choice: 'client',
        builds: [
          {
            version: 'b6500',
            variant: 'win-cuda-12.4-x64',
            origin: 'downloaded',
            active: true,
            in_use: true,
            removable: false,
            not_removable_reason: 'in-use',
          },
          {
            version: 'b6400',
            variant: 'win-cuda-12.4-x64',
            origin: 'downloaded',
            active: false,
            in_use: false,
            removable: true,
          },
        ],
        active: null,
        latest: null,
        update: { needed: false, target: null, apply: 'swap' },
        source: null,
        source_error: null,
        error: null,
      },
    },
  })
  useDownloadStore.setState({
    downloads: {
      'unsloth/GLM-4.6-Q4_K_M': {
        id: 'unsloth/GLM-4.6-Q4_K_M',
        name: 'unsloth/GLM-4.6-Q4_K_M',
        progress: 0.617,
        current: 12.34 * GB,
        total: 20 * GB,
        speed: { bytesPerSecond: 0, atBytes: 0, atTime: 0 },
      },
    },
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
    downloadOriginByModelId: {},
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  seedServiceHub({
    decision: { isSupported: () => false } as never,
    modelSetup: {
      diskAvailable: async () => 87.3 * GB,
    } as unknown as ModelSetupService,
  })
  seed()
})

describe.each(['light', 'dark'] as const)('Downloads, %s theme', (theme) => {
  it.each(
    [1024, 1280].flatMap((width) =>
      [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({
        width,
        fontSize,
      }))
    )
  )(
    'keeps every row and action in place at $width px / $fontSize',
    async ({ width, fontSize }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      // The page column beside the 60 px rail and the 256 px sidebar.
      const { container } = render(
        withTranslations(
          <div className="app-shell flex w-full">
            <aside className="w-[316px] shrink-0">Sidebar</aside>
            <main className="min-w-0 flex-1">
              <DownloadsPage />
            </main>
          </div>
        )
      )
      await settle(container)
      // The free-space answer arrives after the first paint.
      await screen.findByText('87.3 GB')
      await settle(container)

      const main = container.querySelector('main') as HTMLElement
      expectNoHorizontalOverflow(main)

      // Three summary tiles, one height, values on one line.
      const tiles = [
        ...container.querySelectorAll('[data-testid="downloads-summary"] > *'),
      ] as HTMLElement[]
      expect(tiles).toHaveLength(3)
      expectSameHeight(tiles)
      for (const label of ['Total storage', 'Downloaded items', 'Free space']) {
        expectOneLine(screen.getByLabelText(label))
      }

      // Search and category sit on one line.
      expectVerticallyCentered(
        screen.getByLabelText('Download category'),
        screen.getByLabelText('Search downloads')
      )

      const table = container.querySelector('table') as HTMLElement
      const rows = screen.getAllByTestId('downloads-row')

      // The long id truncates; its size and Remove keep their place.
      const longName = screen.getByTitle(LONG_ID)
      expectOneLine(longName)
      const longRow = rows.find((row) => row.contains(longName)) as HTMLElement
      expectOneLine(within(longRow).getByText('48.7 GB'))
      expectFits(
        within(longRow).getByRole('button', { name: /^Remove / }),
        table
      )

      // The running download's readout is one line in the Storage column.
      const running = rows[0]
      expectOneLine(within(running).getByText('62%'))
      expectOneLine(within(running).getByText('12.34 / 20.00 GB'))

      // A build the core keeps says why on its detail line, on one line.
      const kept = rows.find((row) =>
        within(row).queryByText(/b6500/)
      ) as HTMLElement
      expectOneLine(within(kept).getByText(/a model runs from it/))

      // Remove and Cancel form one column of equal controls.
      const actions = rows.map(
        (row) => row.querySelector('td:last-child button') as HTMLElement
      )
      expectSameWidth(actions)
      const lefts = actions.map((button) =>
        Math.round(button.getBoundingClientRect().left)
      )
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(1)
      for (const [index, button] of actions.entries()) {
        expectFits(button, rows[index])
      }
    }
  )
})
