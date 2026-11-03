import { afterEach, describe, expect, it } from 'vitest'
import { render, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import { ConnectorCard } from './ConnectorCard'
import { MCP_CONNECTORS } from '@/constants/mcp-connectors'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectSameHeight,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

afterEach(async () => {
  await page.viewport(1280, 800)
})

const exa = MCP_CONNECTORS.find((c) => c.serverKey === 'exa')!
const linear = MCP_CONNECTORS.find((c) => c.serverKey === 'linear')!
const github = MCP_CONNECTORS.find((c) => c.serverKey === 'github')!
const atomicMail = MCP_CONNECTORS.find((c) => c.serverKey === 'atomicmail')!

const RAIL = 60
const SIDEBAR = 240
/** The Connectors page's scroll area: the window less the rail and the open sidebar. */
const pageWidth = (window: number) => window - RAIL - SIDEBAR

const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

for (const width of [1024, 1280]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      describe(`${width}px / ${font} / ${theme}`, () => {
        it('keeps state controls at the top-right, status in the byline slot, and both columns equal', async () => {
          await page.viewport(width, 900)
          setFontSize(font)
          setTheme(theme)
          const { container } = render(
            withTranslations(
              <main style={{ width: width - 256 }} className="p-4">
                <div className="mx-auto grid max-w-3xl auto-rows-fr grid-cols-2 gap-3">
                  <ConnectorCard connector={exa} busy={false} />
                  <ConnectorCard connector={linear} busy={false} />
                  <ConnectorCard
                    connector={exa}
                    installed={{
                      key: 'exa',
                      config: { ...exa.config, active: false },
                    }}
                    busy={false}
                  />
                  <ConnectorCard
                    connector={linear}
                    installed={{
                      key: 'linear',
                      config: { ...linear.config, active: true },
                    }}
                    status={{ name: 'linear', status: 'connected' }}
                    busy={false}
                  />
                  <ConnectorCard
                    connector={exa}
                    installed={{
                      key: 'exa',
                      config: { ...exa.config, active: true },
                    }}
                    status={{
                      name: 'exa',
                      status: 'error',
                      error: 'Connection refused by remote server',
                    }}
                    busy={false}
                  />
                  <ConnectorCard connector={github} busy={false} />
                </div>
              </main>
            )
          )
          await settle(container)
          const cards = Array.from(
            container.querySelectorAll<HTMLElement>('.bg-card')
          )
          expect(cards).toHaveLength(6)
          expectSameHeight(cards)
          expectNoHorizontalOverflow(container)
          const descriptions = cards.map(
            (card) =>
              Array.from(card.children).find((el) => el.tagName === 'P')!
          )
          // Copy wraps to its own length (at most three lines); what lines
          // up across the grid is where each description starts.
          descriptions.forEach((el) => {
            const lineHeight = parseFloat(getComputedStyle(el).lineHeight)
            expect(el.getBoundingClientRect().height).toBeLessThanOrEqual(
              lineHeight * 3 + 0.5
            )
          })
          const descriptionOffsets = descriptions.map(
            (el, i) =>
              el.getBoundingClientRect().top -
              cards[i].getBoundingClientRect().top
          )
          expect(
            Math.max(...descriptionOffsets) - Math.min(...descriptionOffsets)
          ).toBeLessThanOrEqual(1)
          expectVerticallyCentered(
            within(cards[2]).getByTitle('Server actions'),
            within(cards[2]).getByRole('switch')
          )
          cards.forEach((card, index) => {
            const query = within(card)
            const header = card.firstElementChild as HTMLElement
            if ([0, 1, 5].includes(index)) {
              expect(query.queryByRole('switch')).toBeNull()
              expect(query.queryByText('Not set up')).toBeNull()
              expect(query.getAllByRole('button')).toHaveLength(1)
              return
            }
            const menu = query.getByTitle('Server actions')
            const toggle = query.getByRole('switch')
            expectVerticallyCentered(menu, toggle)
            const menuBox = menu.getBoundingClientRect()
            const toggleBox = toggle.getBoundingClientRect()
            expect(toggleBox.left - menuBox.right).toBeGreaterThanOrEqual(8)
            // 16 px of padding inside the card's border.
            expect(toggleBox.right).toBeCloseTo(
              card.getBoundingClientRect().right - card.clientLeft - 16,
              0
            )
            expect(
              menuBox.top - header.getBoundingClientRect().top
            ).toBeLessThanOrEqual(16)
            const status = query.getByText(
              index === 2 ? 'Inactive' : index === 3 ? 'Connected' : 'Error'
            )
            expect(query.queryByText(/^By /)).toBeNull()
            const referenceByline = within(cards[0]).getByText(/^By /)
            // The status pill and the taller byline share the slot's centre
            // line, which badges beside either also sit on.
            const centre = (el: Element, of: Element) => {
              const box = el.getBoundingClientRect()
              return box.top + box.height / 2 - of.getBoundingClientRect().top
            }
            expect(centre(status, card)).toBeCloseTo(
              centre(referenceByline, cards[0]),
              1
            )
            expect(
              status.getBoundingClientRect().left -
                card.getBoundingClientRect().left
            ).toBeCloseTo(
              referenceByline.getBoundingClientRect().left -
                cards[0].getBoundingClientRect().left,
              0
            )
            expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(
              descriptions[index].getBoundingClientRect().top
            )
          })
        })
      })
    }
  }
}

it.each(['light', 'dark'] as const)(
  'reserves action geometry at Extra Large with long translated copy and loading (%s)',
  async (theme) => {
    await page.viewport(1024, 900)
    setFontSize(XL_FONT_SIZE)
    setTheme(theme)
    const connector = {
      ...exa,
      name: 'Very long connector display name with more words',
      author: 'A provider with a very long author byline',
    }
    const t: typeof i18n.t = ((key: string, options: never) =>
      key === 'mcp-connectors:setUp'
        ? 'Jetzt einrichten'
        : i18n.t(key, options)) as typeof i18n.t
    const card = (configured: boolean, busy: boolean) => (
      <TranslationContext.Provider value={{ t, i18n }}>
        <div style={{ width: 362 }}>
          <ConnectorCard
            connector={connector}
            installed={
              configured
                ? { key: 'exa', config: { ...exa.config, active: true } }
                : undefined
            }
            busy={busy}
          />
        </div>
      </TranslationContext.Provider>
    )
    const view = render(card(false, false))
    await settle(view.container)
    const initial = view.container
      .querySelector('.bg-card')!
      .getBoundingClientRect()
    expectNoHorizontalOverflow(view.container)
    const setup = within(view.container).getByRole('button', {
      name: 'Jetzt einrichten',
    })
    expect(setup.scrollWidth).toBeLessThanOrEqual(setup.clientWidth)
    view.rerender(card(true, false))
    await settle(view.container)
    const menu = within(view.container)
      .getByTitle('Server actions')
      .getBoundingClientRect()
    const toggle = within(view.container)
      .getByRole('switch')
      .getBoundingClientRect()
    view.rerender(card(true, true))
    // A busy spinner rotates indefinitely; wait for paint, not its animation.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    expectNoHorizontalOverflow(view.container)
    expect(
      view.container.querySelector('.bg-card')!.getBoundingClientRect().height
    ).toBeCloseTo(initial.height, 0)
    expect(
      within(view.container)
        .getByTitle('Server actions')
        .getBoundingClientRect().left
    ).toBeCloseTo(menu.left, 0)
    expect(
      within(view.container).getByRole('switch').getBoundingClientRect().width
    ).toBeCloseTo(toggle.width, 0)
  }
)

// QA 2.2.23 #01: at the minimum window with the sidebar open the featured
// "Atomic Mail" card read "Atomic …" — its Featured badge shared the title
// row with the name and Set Up, so the short product name lost the width.
for (const width of [1024, 1280]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`keeps a featured product name whole beside its badge and actions (${width}px / ${font} / ${theme})`, async () => {
        await page.viewport(width, 900)
        setFontSize(font)
        setTheme(theme)
        const { container } = render(
          withTranslations(
            <main style={{ width: pageWidth(width) }} className="p-4">
              <div className="mx-auto grid max-w-3xl auto-rows-fr grid-cols-2 gap-3">
                <ConnectorCard
                  connector={exa}
                  installed={{
                    key: 'exa',
                    config: { ...exa.config, active: false },
                  }}
                  busy={false}
                />
                <ConnectorCard connector={atomicMail} busy={false} />
                <ConnectorCard
                  connector={atomicMail}
                  installed={{
                    key: 'atomicmail',
                    config: { ...atomicMail.config, active: false },
                  }}
                  activationError="spawn npx ENOENT: the command was not found on PATH"
                  onRetry={() => {}}
                  onEdit={() => {}}
                  busy={false}
                />
                <ConnectorCard
                  connector={atomicMail}
                  installed={{
                    key: 'atomicmail',
                    config: { ...atomicMail.config, active: true },
                  }}
                  connecting
                  busy
                />
              </div>
            </main>
          )
        )
        await settle(container)
        expectNoHorizontalOverflow(container)
        const cards = Array.from(
          container.querySelectorAll<HTMLElement>('.bg-card')
        )
        expect(cards).toHaveLength(4)
        cards.forEach((card) => {
          const query = within(card)
          const heading = query.getByRole('heading')
          // `truncate` clips silently; a clipped name is wider inside than out.
          expect(
            heading.scrollWidth,
            `"${heading.textContent}" is clipped to ${heading.clientWidth} px`
          ).toBeLessThanOrEqual(heading.clientWidth)
          const badge = query.getByText('Featured')
          const badgeBox = badge.getBoundingClientRect()
          const cardBox = card.getBoundingClientRect()
          expect(badgeBox.left).toBeGreaterThanOrEqual(cardBox.left)
          expect(badgeBox.right).toBeLessThanOrEqual(cardBox.right)
          expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth)
          for (const control of [
            ...query.queryAllByRole('button'),
            ...query.queryAllByRole('switch'),
          ]) {
            expect(
              overlaps(badgeBox, control.getBoundingClientRect()),
              `Featured overlaps "${control.textContent || control.getAttribute('aria-label')}"`
            ).toBe(false)
          }
          expect(
            overlaps(badgeBox, heading.getBoundingClientRect()),
            'Featured overlaps the name'
          ).toBe(false)
          // Level with the state or byline it follows, not hung below it.
          expectVerticallyCentered(
            badge,
            query.queryByTestId('connector-status') ?? query.getByText(/^By /),
            0.5
          )
        })
        // Retry and Edit of the failed card stay inside it.
        const failed = within(cards[2])
        for (const name of ['Retry', 'Edit']) {
          const button = failed.getByRole('button', { name })
          expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
            cards[2].getBoundingClientRect().right - 16 + 1
          )
        }
      })
    }
  }
}
