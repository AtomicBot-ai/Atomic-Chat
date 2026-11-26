import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  makeCatalog,
  makeFilesFor,
  MODELS_ROOT,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  diffusionDownloadTaskId,
  listInstalledArtifacts,
} from '@/lib/diffusion/models'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { MediaFamilyDetailPanel } from './MediaFamilyDetailPanel'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
// No network in the layout suite: the README section says it is unavailable.
vi.stubGlobal(
  'fetch',
  vi.fn(async () => {
    throw new Error('offline')
  })
)
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'vram_8',
    ready: true,
    profile: {
      tier: 'vram_8',
      memoryKind: 'vram',
      budgetMib: 16 * 1024,
      systemRamMib: 32 * 1024,
      vramMib: 16 * 1024,
      hardCeiling: false,
    },
  }),
}))

// Worst-case copy: a long name, a two-digit GB size, the longest quant label
// the catalog carries, one quant in each state.
const FAMILY: DiffusionCatalogFamily = {
  ...Z_IMAGE,
  name: 'Z-Image Turbo Extended Edition With A Very Long Family Name',
  description:
    'Fast 6B text-to-image model; 8 steps, no negative prompt. Ships with a 2.4 GB GGUF text encoder.',
  license: 'apache-2.0',
  transformer: {
    ...Z_IMAGE.transformer,
    quants: [
      ...Z_IMAGE.transformer.quants,
      {
        id: 'ud_q4_k_xl',
        label: 'UD_Q4_K_XL',
        filename: 'z-image-turbo-UD-Q4_K_XL.gguf',
        bytes: 12_300_000_000,
      },
    ],
  },
}

const INSTALLED = 'z-image:q4_k_m'
const DOWNLOADING = 'z-image:q8_0'

/** The Hub's right column: the window less the sidebar and the 420 px list. */
const panelWidth = (windowWidth: number) => windowWidth - 256 - 420

function seed() {
  const files = makeFilesFor(Z_IMAGE, 'q4_k_m')
  useImageGenerationStore.getState().reset()
  useImageGenerationStore.setState({
    catalog: makeCatalog([FAMILY]),
    modelFiles: files,
    installedArtifacts: listInstalledArtifacts(makeCatalog([FAMILY]), files),
    paths: {
      dataFolder: '/data',
      modelsRoot: MODELS_ROOT,
      backendsRoot: '/data/diffusion/backends',
      imagesDir: '/data/images',
      videosDir: '/data/videos',
    },
  })
  const taskId = diffusionDownloadTaskId(DOWNLOADING)
  useDownloadStore.setState({
    downloads: {
      [taskId]: {
        id: taskId,
        name: DOWNLOADING,
        progress: 1,
        current: 10_800_000_000,
        total: 10_800_000_000,
      },
    },
  })
}

for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
  for (const windowWidth of [1024, 1280]) {
    describe(`${font} ${windowWidth}px window`, () => {
      beforeEach(() => {
        setFontSize(font)
        setTheme('light')
        seed()
      })

      it('keeps the picked quant, its action and the open list inside the panel', async () => {
        render(
          withTranslations(
            <div
              data-testid="panel-frame"
              style={{ width: panelWidth(windowWidth) }}
            >
              <MediaFamilyDetailPanel family={FAMILY} onFindLoras={vi.fn()} />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })
        const frame = screen.getByTestId('panel-frame')
        expectNoHorizontalOverflow(frame)
        expectFits(screen.getByRole('button', { name: 'Find LoRA' }), frame)

        /** The action slot of the quant row, whichever quant it shows. */
        const actions = () =>
          document.querySelector<HTMLElement>(
            '[data-testid="media-quant-actions"]'
          )!
        const pick = async (quantId: string) => {
          await userEvent.click(
            screen.getByRole('button', { name: 'Download Options' })
          )
          await act(async () => {
            await settle()
          })
          await userEvent.click(
            screen.getByTestId(`media-quant-option-z-image:${quantId}`)
          )
          await act(async () => {
            await settle()
          })
        }

        // It opens on the installed quant, with Open.
        expect(
          screen.getByTestId('media-quant-z-image:q4_k_m')
        ).toBeInTheDocument()
        expect(actions().textContent).toBe('Open')
        // Measured as each state shows: the node goes when the state changes.
        const slotWidth = () =>
          actions()
            .querySelector('[data-slot="button"]')!
            .getBoundingClientRect().width
        const widths = [slotWidth()]

        // The open list stays inside the panel and shows the longest label whole.
        await userEvent.click(
          screen.getByRole('button', { name: 'Download Options' })
        )
        await act(async () => {
          await settle()
        })
        expectNoHorizontalOverflow(frame)
        const longest = screen
          .getByTestId('media-quant-option-z-image:ud_q4_k_xl')
          .querySelector<HTMLElement>('.font-mono')!
        expect(longest.scrollWidth).toBeLessThanOrEqual(longest.clientWidth)
        await userEvent.click(
          screen.getByTestId('media-quant-option-z-image:q4_k_m')
        )

        // Progress and Download take the same slot as Open.
        await pick('q8_0')
        expect(actions().textContent).toBe('100%')
        widths.push(slotWidth())
        await pick('ud_q4_k_xl')
        expect(actions().textContent).toBe('Download')
        widths.push(slotWidth())
        expectNoHorizontalOverflow(frame)
        for (const width of widths) expect(width).toBeCloseTo(widths[0], 0)
      })
    })
  }
}
