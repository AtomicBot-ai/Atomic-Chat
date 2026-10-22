import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DownloadProgressRow } from './DownloadProgressRow'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
  for (const theme of ['light', 'dark'] as const) {
    describe(`download marquee ${font} ${theme}`, () => {
      it('scrolls overflowing copy while the percent and actions stay fixed', async () => {
        setFontSize(font)
        setTheme(theme)
        render(
          withTranslations(
            <ul style={{ width: 352 }} data-testid="panel">
              <DownloadProgressRow
                id="AtomicChat/Qwen3_8-Flash-Next-AD-4_27bpw-Q4_K_M-M64"
                progress={0.94}
                current={83.55 * 1024 ** 3}
                total={88.88 * 1024 ** 3}
                pausable
                stage={{ kind: 'retrying', attempt: 7, maxAttempts: 0 }}
              />
            </ul>
          )
        )
        await act(async () => {
          await settle()
        })
        const percent = screen.getByTestId('download-percent')
        const x = percent.getBoundingClientRect().x
        const tracks = screen.getAllByTestId('overflow-text-track')
        expect(
          tracks.filter((track) => track.getAnimations().length > 0).length
        ).toBeGreaterThanOrEqual(2)
        for (const track of tracks) {
          for (const animation of track.getAnimations()) {
            const frames = (animation.effect as KeyframeEffect).getKeyframes()
            const duration = Number(
              animation.effect!.getComputedTiming().duration
            )
            const viewport = track.parentElement!
            const primary = track.querySelector(
              '[data-testid="overflow-text-primary"]'
            )!
            const repeat = track.querySelector(
              '[data-testid="overflow-text-repeat"]'
            )!
            expect(repeat.getAttribute('aria-hidden')).toBe('true')
            expect(
              Math.abs(
                repeat.getBoundingClientRect().width -
                  primary.getBoundingClientRect().width
              )
            ).toBeLessThanOrEqual(1)
            expect(repeat.getBoundingClientRect().width).toBeGreaterThan(
              viewport.clientWidth
            )
            // Both edges pause for 1.5 seconds, independently of text length.
            expect(Number(frames[1].offset) * duration).toBeCloseTo(1500)
            expect(
              (Number(frames[3].offset) - Number(frames[2].offset)) * duration
            ).toBeCloseTo(1500)
            animation.currentTime =
              ((Number(frames[2].offset) + Number(frames[3].offset)) / 2) *
              duration
            expect(
              Math.abs(
                primary.getBoundingClientRect().right -
                  viewport.getBoundingClientRect().right
              )
            ).toBeLessThanOrEqual(1)
            // Immediately before wrapping, the next copy has arrived at the
            // same left edge as the first: there is no backwards jump.
            animation.currentTime = duration - 0.001
            expect(
              Math.abs(
                repeat.getBoundingClientRect().left -
                  viewport.getBoundingClientRect().left
              )
            ).toBeLessThanOrEqual(1)
            animation.currentTime = duration + 750
            expect(
              Math.abs(
                primary.getBoundingClientRect().left -
                  viewport.getBoundingClientRect().left
              )
            ).toBeLessThanOrEqual(1)
          }
        }
        expect(percent.getBoundingClientRect().x).toBe(x)
        expect(percent.getAnimations()).toHaveLength(0)
        expect(percent.textContent).toBe('94%')
        const panel = screen.getByTestId('panel')
        expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)
      })
      it('leaves short names still', async () => {
        render(
          withTranslations(
            <ul style={{ width: 352 }}>
              <DownloadProgressRow
                id="org/tiny"
                progress={0}
                current={0}
                total={0}
              />
            </ul>
          )
        )
        await act(async () => {
          await settle()
        })
        expect(screen.getByText('tiny').getAnimations()).toHaveLength(0)
      })
    })
  }
}
