import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Cloud } from 'lucide-react'
import { HUGGINGFACE_LOGO_SRC } from '@/lib/model-logo'
import { ChatGptMark } from '@/components/icons/chatgpt-mark'
import { ModelFitIndicator } from './ModelFitIndicator'
import { RouteRow } from './RouteRow'
import { SetupModelRow } from './SetupModelRow'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameWidth,
  expectSameHeight,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
const title = 'Qwen3.5 397B A17B Instruct Ultra Long Model Name Q4_K_M'
const noop = () => {}
for (const font of ['16px', '20px']) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1024, 1280]) {
      describe(`${font} ${theme} ${width}px with sidebar`, () => {
        it('keeps long titles, badges, sizes and download states inside stable rows', async () => {
          setFontSize(font)
          setTheme(theme)
          const rows = (downloading = false) =>
            withTranslations(
              <div style={{ width: width - 256 }}>
                <div className="mx-auto w-full max-w-[640px] px-6">
                  <div
                    data-testid="card"
                    className="rounded-lg border bg-secondary/50 px-3 py-2 [scrollbar-gutter:stable]"
                  >
                    {(['ok', 'warn', 'no'] as const).map((level, i) => (
                      <SetupModelRow
                        key={level}
                        icon={<Cloud className="size-8 shrink-0" />}
                        title={title}
                        hero={i === 0}
                        downloadSize="19.7 GB"
                        fitMark={
                          <ModelFitIndicator
                            level={level}
                            label={level}
                            reason="Memory explanation"
                          />
                        }
                        summary="Balanced speed and quality"
                        progressText={
                          downloading && i === 0
                            ? '100% · 19.7 GB / 19.7 GB'
                            : null
                        }
                        rowDownloading={downloading && i === 0}
                        disabled={false}
                        onDownload={noop}
                        buttonLabel={i === 2 ? 'Herunterladen' : 'Download'}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )
          const { rerender } = render(rows())
          await settle()
          const card = screen.getByTestId('card')
          const actions = () =>
            Array.from(
              card.querySelectorAll<HTMLElement>('[data-slot="button"]')
            )
          expectSameWidth(actions())
          for (const action of actions()) {
            const label = action.querySelector<HTMLElement>('span')!
            expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
          }
          const original = actions()[0].getBoundingClientRect()
          const rowRects = Array.from(card.children).map((el) =>
            el.getBoundingClientRect()
          )
          for (const row of Array.from(card.children)) {
            const name = row.querySelector('h2')!
            const badge = row.querySelector<HTMLElement>('[data-fit]')!
            expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
            const size = row.querySelector<HTMLElement>(
              '[data-testid="setup-model-size"]'
            )!
            expectOneLine(size)
            expectOneLine(badge.querySelector('span')!)
            expectVerticallyCentered(name, size)
            expect(size.getBoundingClientRect().left).toBeGreaterThanOrEqual(
              badge.getBoundingClientRect().right
            )
            expectVerticallyCentered(name, badge)
            expect(badge.getBoundingClientRect().left).toBeGreaterThanOrEqual(
              name.getBoundingClientRect().right
            )
          }
          expectNoHorizontalOverflow(card)
          rerender(rows(true))
          await settle()
          expectSameWidth(actions())
          expect(actions()[0].getBoundingClientRect().width).toBeCloseTo(
            original.width
          )
          expect(actions()[0].getBoundingClientRect().left).toBeCloseTo(
            original.left
          )
          Array.from(card.children).forEach((el, i) => {
            expect(el.getBoundingClientRect().height).toBeCloseTo(
              rowRects[i].height
            )
            expect(el.getBoundingClientRect().width).toBeCloseTo(
              rowRects[i].width
            )
          })
          const downloading = screen.getByText('Downloading…')
          expect(downloading.scrollWidth).toBeLessThanOrEqual(
            downloading.clientWidth
          )
          expect((actions()[0] as HTMLButtonElement).disabled).toBe(true)
          expect(actions()[0].querySelector('svg')).toBeNull()
          expectOneLine(screen.getByText('100% · 19.7 GB / 19.7 GB'))
          expectNoHorizontalOverflow(card)
        })
        it('uses equal route logo footprints and keeps the provider hint on one line', async () => {
          setFontSize(font)
          setTheme(theme)
          render(
            withTranslations(
              <div style={{ width: width - 256 }}>
                <div className="mx-auto w-full max-w-[640px] px-6">
                  <div
                    data-testid="routes"
                    className="border px-3 py-2 [scrollbar-gutter:stable]"
                  >
                    {[
                      <img src={HUGGINGFACE_LOGO_SRC} alt="" />,
                      <ChatGptMark />,
                      <Cloud />,
                    ].map((icon, i) => (
                      <RouteRow
                        layout="onboarding"
                        key={i}
                        icon={icon}
                        title={
                          [
                            'Hugging Face models',
                            'ChatGPT subscription',
                            'Cloud provider',
                          ][i]
                        }
                        hint={
                          i === 2
                            ? 'OpenRouter, Anthropic, OpenAI, and more'
                            : 'Sign in, no API key needed'
                        }
                        action={['Browse', 'Connect', 'Add API Key'][i]}
                        label={['Browse', 'Connect', 'Add API Key'][i]}
                        onClick={noop}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )
          )
          await settle()
          const card = screen.getByTestId('routes')
          const logos = Array.from(card.querySelectorAll('svg, img'))
          expectSameWidth(logos)
          expectSameHeight(logos)
          for (const logo of logos) {
            expectVerticallyCentered(
              logo,
              logo.parentElement!.nextElementSibling!
            )
          }
          const hint = screen.getByText(
            'OpenRouter, Anthropic, OpenAI, and more'
          )
          expect(hint.scrollWidth).toBeLessThanOrEqual(hint.clientWidth)
          expectOneLine(
            screen.getByText('OpenRouter, Anthropic, OpenAI, and more')
          )
          expectNoHorizontalOverflow(card)
          expectSameWidth(
            Array.from(card.querySelectorAll('[data-slot="button"]'))
          )
        })
      })
    }
  }
}
