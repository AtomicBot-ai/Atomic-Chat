import { render, screen, within } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
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

// The audit's case: a catalog model's file, stopped part way.
const NEMOTRON_ID = vi.hoisted(
  () => 'AtomicChat/NVIDIA-Nemotron-3_5-Lightning-30B-A3B-Q4_K_M'
)

// What the disk holds without an owner: downloads that never finished, under
// long ids, and a draft MLX speculative decoding may load.
vi.mock('@/lib/downloads-disk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/downloads-disk')>()),
  scanDownloadsDisk: async () => ({
    mlxModelBytes: {},
    partials: [
      {
        root: 'llamacpp/models',
        id: 'mradermacher/gemma-4-31B-it-qat-q4_0-unquantized-heretic_i1-Q3_K_S',
        paths: ['/data/llamacpp/models/x'],
        bytes: 13.2 * 1024 ** 3,
      },
      {
        root: 'llamacpp/models',
        id: NEMOTRON_ID,
        paths: ['/data/llamacpp/models/AtomicChat/nemotron'],
        bytes: 18.4 * 1024 ** 3,
      },
    ],
    drafts: [
      {
        id: 'z-lab_Qwen3.5-9B-DFlash',
        path: '/data/mlx/models/z-lab_Qwen3.5-9B-DFlash',
        bytes: 2 * 1024 ** 3,
      },
    ],
  }),
}))

// A worst-case id: a long-tail Hugging Face GGUF the catalog never named.
const LONG_ID =
  'unsloth/' + 'VeryLongFineTunedModelName'.repeat(5) + '-UD-Q4_K_XL'

/**
 * `text`, somewhere in `root`, is laid out inside the box that clips it: not
 * cut off under an ellipsis. Its own `Range` rect is where the browser put
 * it, past the box's edge when the line was cut short before it.
 */
function expectTextShown(root: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + text.length)
    const box = range.getBoundingClientRect()
    let clip = node.parentElement
    while (clip && getComputedStyle(clip).overflowX === 'visible') {
      clip = clip.parentElement
    }
    const bounds = (clip ?? root).getBoundingClientRect()
    expect(
      box.right,
      `"${text}" ends past the right edge of the box that clips it`
    ).toBeLessThanOrEqual(bounds.right + 0.5)
    return
  }
  expect.fail(`"${text}" is not in ${root.textContent}`)
}

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
        // The same model and quant from another owner.
        { id: 'bartowski/Qwen3.5-4B-Q4_K_M', sizeBytes: 2.5 * GB },
      ]),
      {
        ...provider('mlx', [{ id: 'Qwen3.5-4B-4bit', sizeBytes: 2.4 * GB }]),
        settings: [
          {
            key: 'dflash_enabled',
            title: 'DFlash Draft',
            description: '',
            controller_type: 'checkbox',
            controller_props: { value: true },
          } as ProviderSetting,
        ],
      },
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
    controlRequests: [],
    dismissedDownloads: new Set(),
    resumeParams: {
      'unsloth/GLM-4.6-Q4_K_M': {
        provider: 'llamacpp-upstream',
        modelPath:
          'https://huggingface.co/unsloth/model/resolve/main/model.gguf',
      },
    },
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
      [DEFAULT_FONT_SIZE, XL_FONT_SIZE].flatMap((fontSize) =>
        [false, true].map((paused) => ({
          width,
          fontSize,
          paused,
        }))
      )
    )
  )(
    'keeps every row and action in place at $width px / $fontSize, paused=$paused',
    async ({ width, fontSize, paused }) => {
      useDownloadStore.setState({
        pausedDownloads: new Set(paused ? ['unsloth/GLM-4.6-Q4_K_M'] : []),
      })
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

      // The long id truncates; its size and Remove keep their place. The
      // quant is its own fact under the name, so the cut never reaches it.
      const longName = screen.getByTitle(LONG_ID)
      expectOneLine(longName)
      const longRow = rows.find((row) => row.contains(longName)) as HTMLElement
      expectTextShown(longRow, 'Q4_K_XL')
      expectOneLine(within(longRow).getByText('48.7 GB'))
      expectFits(
        within(longRow).getByRole('button', { name: /^Remove / }),
        table
      )

      // The running download's readout is one line in the Storage column.
      const running = rows[0]
      expectOneLine(within(running).getByText(paused ? 'Paused' : '62%'))
      expectOneLine(within(running).getByText('12.34 / 20.00 GB'))
      const control = within(running).getByRole('button', {
        name: paused ? 'Resume download' : 'Pause download',
      })
      const cancel = within(running).getByRole('button', {
        name: 'Cancel download',
      })
      expectFits(control, running)
      expectFits(cancel, running)
      expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(
        cancel.getBoundingClientRect().left
      )

      // A build the core keeps says why on its detail line, on one line.
      const kept = rows.find((row) =>
        within(row).queryByText(/b6500/)
      ) as HTMLElement
      expectOneLine(within(kept).getByText(/a model runs from it/))

      // Unfinished downloads and a draft in use say what they are on one line.
      const partials = await screen.findAllByText(/incomplete download/)
      expect(partials).toHaveLength(2)
      for (const line of partials) expectOneLine(line)
      expectOneLine(screen.getByText(/speculative decoding is on/))
      const partialRow = rows.find((row) =>
        within(row).queryByTitle(/heretic_i1-Q3_K_S$/)
      )
      expect(partialRow).toBeDefined()
      expectOneLine(within(partialRow as HTMLElement).getByText('13.2 GB'))
      expectTextShown(partialRow as HTMLElement, 'Q3_K_S')

      // An unfinished catalog file reads as its model and its quant, both in
      // full; the id they come from is on the name and behind the copy button.
      const nemotronName = screen.getByTitle(NEMOTRON_ID)
      const nemotron = rows.find((row) =>
        row.contains(nemotronName)
      ) as HTMLElement
      const titleTrack = nemotronName.querySelector(
        '[data-testid="overflow-text-track"]'
      ) as HTMLElement
      const titlePrimary = titleTrack.querySelector(
        '[data-testid="overflow-text-primary"]'
      ) as HTMLElement
      if (titlePrimary.scrollWidth > nemotronName.clientWidth + 1) {
        // The readable model name can itself overflow at Extra Large fonts.
        // Both ends must become readable while the action slot stays fixed.
        const [animation] = titleTrack.getAnimations()
        expect(animation).toBeDefined()
        animation.pause()
        const frames = (animation.effect as KeyframeEffect).getKeyframes()
        const duration = Number(animation.effect!.getComputedTiming().duration)
        animation.currentTime = 750
        expect(
          Math.abs(
            titlePrimary.getBoundingClientRect().left -
              nemotronName.getBoundingClientRect().left
          )
        ).toBeLessThanOrEqual(1)
        animation.currentTime =
          ((Number(frames[2].offset) + Number(frames[3].offset)) / 2) * duration
        expect(
          Math.abs(
            titlePrimary.getBoundingClientRect().right -
              nemotronName.getBoundingClientRect().right
          )
        ).toBeLessThanOrEqual(1)
        expect(
          titleTrack.querySelector('[data-testid="overflow-text-repeat"]')
        ).toHaveAttribute('aria-hidden', 'true')
      } else {
        expectTextShown(nemotron, 'NVIDIA Nemotron 3.5 Lightning 30B A3B')
      }
      expectTextShown(nemotron, 'Q4_K_M')
      expectOneLine(within(nemotron).getByText(/Q4_K_M · incomplete download/))
      const copy = within(nemotron).getByRole('button', {
        name: `Copy ${NEMOTRON_ID}`,
      })
      expectFits(copy, table)
      expectVerticallyCentered(copy, nemotronName)

      // One model and quant from two owners: each line names its owner.
      for (const owner of ['unsloth', 'bartowski']) {
        const row = within(table)
          .getByTitle(`${owner}/Qwen3.5-4B-Q4_K_M`)
          .closest('tr') as HTMLElement
        const line = within(row).getByText(`llama.cpp · Q4_K_M · ${owner}`)
        expectOneLine(line)
        expectTextShown(row, owner)
      }

      // Remove and Cancel form one column of equal controls.
      const actions = rows.map(
        (row) =>
          row.querySelector('td:last-child button:last-child') as HTMLElement
      )
      expectSameWidth(actions)
      const lefts = actions.map((button) =>
        Math.round(button.getBoundingClientRect().left)
      )
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(1)
      for (const [index, button] of actions.entries()) {
        expectFits(button, rows[index])
      }

      // The confirmation spells out the exact file; the longest id wraps
      // inside the dialog instead of widening it.
      await userEvent.click(
        within(longRow).getByRole('button', { name: /^Remove / })
      )
      const dialog = await screen.findByRole('dialog')
      await settle(dialog)
      expectFits(within(dialog).getByText(LONG_ID), dialog)
      expectNoHorizontalOverflow(dialog)
    }
  )
})
