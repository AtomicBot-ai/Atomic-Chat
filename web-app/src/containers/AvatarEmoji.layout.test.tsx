import { render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunSettingsPanel } from '@/containers/RunSettingsPanel'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectSameHeight,
  expectSameWidth,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createFileRoute: () => (config: any) => ({ ...config }),
}))

import { Route } from '@/routes/settings/assistant'

const AssistantsPage = Route.component as React.ComponentType

// QA 2.2.23 #12: "RC 2.2.0 QA Assistant" has no avatar and showed an empty
// tile; an avatar image that fails to load must not leave one either.
const ASSISTANTS = [
  { id: 'jan', name: 'Atomic Chat', avatar: '/images/transparent-logo.png' },
  { id: 'qa', name: 'RC 2.2.0 QA Assistant' },
  { id: 'writer', name: 'Writer', avatar: '✍️' },
  { id: 'broken', name: 'Researcher', avatar: '/images/no-such-avatar.png' },
].map(
  (assistant) =>
    ({
      ...assistant,
      created_at: 1,
      instructions: '',
      parameters: {},
    }) as unknown as Assistant
)

const RAIL = 60
const SIDEBAR = 240

beforeEach(() => {
  seedServiceHub({
    models: {
      stopModel: vi.fn(),
      startModel: vi.fn(),
      getActiveModels: vi.fn().mockResolvedValue([]),
    } as unknown as ModelsService,
  })
  useThreads.setState({ currentThreadId: undefined })
  useModelProvider.setState({
    providers: [],
    selectedProvider: 'llamacpp',
    selectedModel: undefined,
  })
  useAssistant.setState({
    assistants: ASSISTANTS,
    defaultAssistantId: 'jan',
    pendingAssistant: undefined,
  })
})

afterEach(async () => {
  await page.viewport(1280, 800)
})

/** What fills a tile: an image, an emoji, or the stand-in initial. */
const contentOf = (tile: HTMLElement) =>
  tile.firstElementChild as HTMLElement | null

const centre = (el: Element) => {
  const box = el.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

for (const width of [1024, 1280]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      describe(`${width}px / ${font} / ${theme}`, () => {
        it('gives every assistant in Settings a visible avatar, centred in its tile', async () => {
          await page.viewport(width, 900)
          setFontSize(font)
          setTheme(theme)
          const { container } = render(
            <main
              data-testid="column"
              style={{ width: width - RAIL - SIDEBAR }}
            >
              {withTranslations(<AssistantsPage />)}
            </main>
          )
          await settle(container)
          const tiles = screen.getAllByTestId('assistant-avatar-tile')
          expect(tiles).toHaveLength(ASSISTANTS.length)
          // The missing image's 404 arrives asynchronously.
          await vi.waitFor(() =>
            expect(
              tiles[3].querySelector('[data-slot="avatar-fallback"]')
            ).not.toBeNull()
          )
          expectNoHorizontalOverflow(screen.getByTestId('column'))

          tiles.forEach((tile, index) => {
            const content = contentOf(tile)
            expect(
              content,
              `${ASSISTANTS[index].name}'s tile is empty`
            ).not.toBeNull()
            const box = content!.getBoundingClientRect()
            expect(box.width).toBeGreaterThan(0)
            expect(box.height).toBeGreaterThan(0)
            // An emoji's line box is taller than its glyph; the image and
            // the stand-in initial are boxes of their own and must fit.
            if (content!.tagName === 'IMG' || content!.dataset.slot) {
              expectFits(content!, tile)
            }
            const c = centre(content!)
            const t = centre(tile)
            expect(Math.abs(c.x - t.x)).toBeLessThanOrEqual(1)
            expect(Math.abs(c.y - t.y)).toBeLessThanOrEqual(1)
          })

          const logo = within(tiles[0]).getByRole('img')
          const missing = contentOf(tiles[1])!
          const broken = contentOf(tiles[3])!
          expect(missing).toHaveTextContent(/^R$/)
          expect(broken).toHaveTextContent(/^R$/)
          // The initial takes the image's slot, so the name never moves.
          expectSameWidth([logo, missing, broken])
          expectSameHeight([logo, missing, broken])
        })

        it('shows the initial in the run settings assistant picker, level with the name', async () => {
          await page.viewport(width, 900)
          setFontSize(font)
          setTheme(theme)
          useAssistant.setState({ defaultAssistantId: 'qa' })
          const { container } = render(
            withTranslations(<RunSettingsPanel onClose={vi.fn()} />)
          )
          await settle(container)
          const trigger = screen
            .getByText('RC 2.2.0 QA Assistant')
            .closest('button') as HTMLElement
          const initial = trigger.querySelector<HTMLElement>(
            '[data-slot="avatar-fallback"]'
          )
          expect(initial, 'the picker shows no avatar').not.toBeNull()
          expect(initial).toHaveTextContent(/^R$/)
          const box = initial!.getBoundingClientRect()
          expect(box.width).toBeCloseTo(16, 0)
          expect(box.height).toBeCloseTo(16, 0)
          expectVerticallyCentered(
            initial!,
            within(trigger).getByText('RC 2.2.0 QA Assistant')
          )
          expectFits(initial!, trigger)
          expectNoHorizontalOverflow(trigger)
        })
      })
    }
  }
}
