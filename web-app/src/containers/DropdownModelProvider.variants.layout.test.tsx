import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from '@vitest/browser/context'

import DropdownModelProvider from './DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/containers/ModelSupportStatus', () => ({
  ModelSupportStatus: () => null,
}))
vi.mock('@/containers/ActiveModelIndicator', () => ({
  ActiveModelIndicator: () => null,
}))
vi.mock('@/containers/ReasoningEffortPanel', () => ({ default: () => null }))
vi.mock('@/hooks/useReasoningEffort', () => ({
  useReasoningEffort: () => ({ levelLabel: '' }),
}))

/**
 * QA 09 (2.2.23): the installed models the audit saw, with the variants that
 * only a quant or an owner tells apart. `quant` is what each row must show.
 */
const variants = [
  {
    id: 'ollama/gemma-4-12b-uncensored-heretic-abliterated-q4_K_M',
    source: 'ollama',
    quant: 'q4_K_M',
  },
  { id: 'ollama/heretic-12b-latest', source: 'ollama' },
  { id: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS', quant: 'IQ4_XS' },
  { id: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-Q4_K_M', quant: 'Q4_K_M' },
  { id: 'gemma-4-E4B-it-IQ4_XS', quant: 'IQ4_XS' },
  {
    id: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q6_K',
    source: 'lmstudio',
    quant: 'Q6_K',
  },
] as const
const prism = {
  id: 'prism-ml/prism-ml/Ternary-Bonsai-1_7B-PQ2_0',
  quant: 'PQ2_0',
} as const

const asModel = ({ id, ...rest }: { id: string; source?: string }) =>
  ({
    id,
    ...('source' in rest ? { source: rest.source } : {}),
    capabilities: ['completion'],
  }) as Model

const providers = [
  {
    provider: 'llamacpp-upstream',
    active: true,
    models: variants.map(asModel),
    settings: [],
  },
  {
    provider: 'atomic-prism',
    active: true,
    models: [asModel(prism)],
    settings: [],
  },
] as unknown as ModelProvider[]
const selected = asModel(variants[2])

/** The picker row for `id`: the option whose tooltip is the full id. */
function option(panel: HTMLElement, id: string): HTMLElement {
  const row = panel.querySelector<HTMLElement>(
    `[role="radio"][title="${CSS.escape(id)}"]`
  )
  if (!row) expect.fail(`no picker option has the title ${id}`)
  return row
}

/**
 * `text` is laid out inside every box that clips it on the way up to `root`:
 * an ellipsis (`truncate`) or a clamp (`line-clamp-*`) does not hide it. The
 * clipped glyphs keep their layout position, so a `Range` over them reports
 * where they would be — past the box that cuts them off.
 */
function expectTextShown(root: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    const at = data.indexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + text.length)
    const glyphs = range.getBoundingClientRect()
    range.detach()
    for (
      let el = node.parentElement;
      el && root.contains(el);
      el = el.parentElement
    ) {
      const style = getComputedStyle(el)
      if (style.overflowX === 'visible' && style.overflowY === 'visible')
        continue
      const clip = el.getBoundingClientRect()
      if (
        glyphs.left < clip.left - 1 ||
        glyphs.right > clip.right + 1 ||
        glyphs.top < clip.top - 1 ||
        glyphs.bottom > clip.bottom + 1
      ) {
        expect.fail(
          `"${text}" in "${root.title}" is laid out at x ${Math.round(glyphs.left)}–${Math.round(glyphs.right)}, ` +
            `y ${Math.round(glyphs.top)}–${Math.round(glyphs.bottom)}, outside the box that clips it ` +
            `(x ${Math.round(clip.left)}–${Math.round(clip.right)}, y ${Math.round(clip.top)}–${Math.round(clip.bottom)}): ` +
            `"${data}" is cut off before it.`
        )
      }
    }
    return
  }
  expect.fail(`"${text}" is not written anywhere in "${root.title}"`)
}

async function openModelList(): Promise<HTMLElement> {
  // A 256 px sidebar stays open; the composer sits at the bottom right of
  // the chat column, like the desktop app at its minimum window.
  render(
    withTranslations(
      <div className="flex h-screen">
        <aside className="w-64 shrink-0" aria-label="Sidebar" />
        <main className="flex min-w-0 flex-1 items-end justify-end p-4">
          <DropdownModelProvider />
        </main>
      </div>
    )
  )
  fireEvent.click(
    document.querySelector('[data-test-id="model-picker-trigger"]')!
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Change model' }))
  const search = await screen.findByPlaceholderText('Search models...')
  const panel = search.closest('[data-slot="popover-content"]') as HTMLElement
  await settle(panel)
  return panel
}

beforeEach(() => {
  useModelLoad.setState({ modelSelectionDeferred: true })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
  })
  useLeftPanel.setState({ open: true })
  useRunSettingsPanel.setState({ isOpen: false })
  useModelProvider.setState({
    providers,
    selectedProvider: 'llamacpp-upstream',
    selectedModel: selected,
  })
  seedServiceHub({
    models: {
      getActiveModels: async () => [],
      checkMmprojExists: async () => false,
      checkMmprojExistsAndUpdateOffloadMMprojSetting: async () => undefined,
    } as unknown as ModelsService,
  })
})

describe('model picker rows tell installed variants apart', () => {
  for (const width of [1024, 1280]) {
    for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${width}px, ${font}, ${theme}: every quant and the whole name are visible`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          const panel = await openModelList()

          // The rows grow downwards; the panel keeps its bounded width.
          expect(panel.getBoundingClientRect().width).toBeCloseTo(352, 0)

          for (const variant of [...variants, prism]) {
            const row = option(panel, variant.id)
            if ('quant' in variant) expectTextShown(row, variant.quant)
            expectNoHorizontalOverflow(row)
          }

          // The audit's long Ollama name reads in full, on two lines at most,
          // and its badge sits under it rather than taking its width.
          const long = option(panel, variants[0].id)
          const name = part(long, 'model-option-name')
          for (const word of ['Gemma', 'Uncensored', 'Heretic', 'Abliterated'])
            expectTextShown(long, word)
          const lineHeight = parseFloat(getComputedStyle(name).lineHeight)
          expect(name.getBoundingClientRect().height).toBeLessThanOrEqual(
            2 * lineHeight + 1
          )
          const badge = long.querySelector<HTMLElement>(
            '[title="Detected from Ollama"]'
          )!
          expect(badge.getBoundingClientRect().top).toBeGreaterThanOrEqual(
            name.getBoundingClientRect().bottom - 1
          )

          // Quant, owner and source share one muted line under the name.
          for (const variant of variants) {
            const row = option(panel, variant.id)
            const [first, ...rest] = Array.from(
              part(row, 'model-option-details').children
            ) as HTMLElement[]
            // The source badge is a pill taller than a text line; the
            // quant and owner text beside it must stay on one line.
            if (!first.title.startsWith('Detected from')) expectOneLine(first)
            for (const next of rest) expectVerticallyCentered(next, first)
            expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(
              part(row, 'model-option-name').getBoundingClientRect().bottom - 1
            )
          }
          const lmstudio = option(panel, variants[5].id)
          expectTextShown(lmstudio, 'lmstudio-community')
          expectTextShown(lmstudio, 'LM Studio')

          // Two quants of one repo no longer read the same.
          const iq4 = option(panel, variants[2].id)
          const q4 = option(panel, variants[3].id)
          expect(iq4.innerText).not.toBe(q4.innerText)

          // The check mark stays level with the two-line title block.
          expect(iq4).toHaveAttribute('aria-checked', 'true')
          const mark = iq4.querySelector(
            '[data-testid="model-selection-llamacpp-upstream:unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS"]'
          )!
          expectVerticallyCentered(
            mark,
            part(iq4, 'model-option-name').parentElement!
          )

          expectNoHorizontalOverflow(panel)
          expectNoHorizontalOverflow(document.body)
        })
      }
    }
  }
})

function part(root: HTMLElement, testId: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!el) expect.fail(`"${root.title}" has no [data-testid="${testId}"]`)
  return el
}
