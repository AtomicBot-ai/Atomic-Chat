/**
 * Geometry assertions for the real-browser layout suite.
 *
 * Every helper reads the live layout — `getBoundingClientRect`, `scrollWidth`,
 * `Range` rects — so it is only meaningful under `vitest.layout.config.ts`
 * (headless Chromium, the app's CSS, the bundled Inter). Under jsdom every
 * box is 0×0 and each of these would pass or fail for nothing.
 *
 * A failure message carries the measured pixels, so a red test names the
 * fault ("button right edge 471.5 is 23.5 px past the dialog's 448") rather
 * than pointing at a screenshot. The rules these assert are written out in
 * `docs/ui-layout-rules.md`.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'
import { expect } from 'vitest'

import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'

/**
 * Render `children` with the app's English strings. Without a provider the
 * translation context echoes keys, and `setup:recommend.fitBadgeNo` is a
 * different width from "Won't fit" — a layout test must measure the words
 * the user sees.
 */
export function withTranslations(children: ReactNode): ReactElement {
  return createElement(
    TranslationContext.Provider,
    { value: { t: i18n.t, i18n } },
    children
  )
}

/** The app's default `--font-size-base`: `fontSizeOptions` "Medium". */
export const DEFAULT_FONT_SIZE = '16px'
/** Settings → Interface → Font size "Extra Large". */
export const XL_FONT_SIZE = '20px'

export type Theme = 'light' | 'dark'

const px = (n: number) => `${Math.round(n * 100) / 100} px`

function rect(el: Element): DOMRect {
  return el.getBoundingClientRect()
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const testId = el.getAttribute('data-testid')
  const label = el.getAttribute('aria-label')
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
  const name = testId
    ? `[data-testid="${testId}"]`
    : label
      ? `[aria-label="${label}"]`
      : text
        ? `"${text.length > 40 ? `${text.slice(0, 37)}…` : text}"`
        : ''
  return `<${tag}>${name ? ` ${name}` : ''}`
}

/**
 * Set the app's type scale the way Settings → Interface does at runtime.
 * The CSS has no fallback for `--font-size-base`; the setup file applies the
 * default before every test.
 */
export function setFontSize(size: string): void {
  document.documentElement.style.setProperty('--font-size-base', size)
}

/** Toggle the app's `dark` class on `<html>`, as `useTheme` does. */
export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/**
 * Wait until the layout under `root` is final: fonts loaded, enter animations
 * (`animate-in`, `zoom-in-95`) finished, two frames painted. Call it after
 * `render` and before the first measurement — a Radix dialog scales from 95 %
 * for its first 150 ms, and a rect read mid-animation is 5 % wrong.
 */
export async function settle(root: Element = document.body): Promise<void> {
  await document.fonts.ready
  await Promise.allSettled(
    root.getAnimations({ subtree: true }).map((animation) => animation.finished)
  )
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

/**
 * Nothing under `root` spills sideways: no element that can scroll (or that
 * lets its content show) is wider inside than out — that is the horizontal
 * scrollbar on a dialog whose grid child carries a nowrap title — and every
 * descendant's box sits inside the root's box. Elements that clip on purpose
 * (`truncate`, `overflow-hidden`) are measured by their box only, since
 * their content is meant to be wider than they are.
 */
export function expectNoHorizontalOverflow(
  root: HTMLElement,
  tolerance = 1
): void {
  const bounds = rect(root)
  const elements: Element[] = [root, ...root.querySelectorAll('*')]
  for (const el of elements) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue

    // `scrollWidth` is only meaningful on a box that lays out content; an
    // SVG's is 0. Its box is still held inside the root below.
    const clips = style.overflowX === 'hidden' || style.overflowX === 'clip'
    if (
      el instanceof HTMLElement &&
      !clips &&
      el.scrollWidth > el.clientWidth + tolerance
    ) {
      expect.fail(
        `${describe(el)} is ${px(el.scrollWidth - el.clientWidth)} wider inside than out ` +
          `(scrollWidth ${el.scrollWidth}, clientWidth ${el.clientWidth}): ` +
          'a child does not shrink — a nowrap title without `min-w-0` on the way down, ' +
          'or a fixed width larger than its column.'
      )
    }

    if (el === root) continue
    const box = rect(el)
    if (box.width === 0 && box.height === 0) continue
    if (box.right > bounds.right + tolerance) {
      expect.fail(
        `${describe(el)} right edge ${px(box.right)} is ${px(box.right - bounds.right)} past ` +
          `${describe(root)}'s right edge ${px(bounds.right)}.`
      )
    }
    if (box.left < bounds.left - tolerance) {
      expect.fail(
        `${describe(el)} left edge ${px(box.left)} is ${px(bounds.left - box.left)} before ` +
          `${describe(root)}'s left edge ${px(bounds.left)}.`
      )
    }
  }
}

/** Distinct line tops of the text laid out inside `el`, clipped lines included. */
function lineTops(el: Element): number[] {
  const range = document.createRange()
  range.selectNodeContents(el)
  const tops = new Set<number>()
  for (const line of range.getClientRects()) {
    if (line.width === 0 || line.height === 0) continue
    tops.add(Math.round(line.top))
  }
  range.detach()
  return [...tops].sort((a, b) => a - b)
}

/**
 * The text in `el` occupies one line: its content lays out on a single line
 * box — a `line-clamp-1` hint whose copy would run to a second line fails
 * here even though the clamp hides it, because the cut-off words are the
 * fault — and the element is no taller than 1.5 × its font size.
 */
export function expectOneLine(el: HTMLElement): void {
  const tops = lineTops(el)
  if (tops.length > 1) {
    expect.fail(
      `${describe(el)} wraps onto ${tops.length} lines (line tops ${tops.map(px).join(', ')}). ` +
        'Shorten the copy, truncate, or drop the least important part.'
    )
  }
  const fontSize = parseFloat(getComputedStyle(el).fontSize)
  const height = rect(el).height
  if (height > fontSize * 1.5 + 0.5) {
    expect.fail(
      `${describe(el)} is ${px(height)} tall at font-size ${px(fontSize)}: ` +
        `more than one line (limit ${px(fontSize * 1.5)}).`
    )
  }
}

/**
 * All `els` share one width, within `tolerance` px: the action buttons of a
 * list read as one column (`ROUTE_ROW_ACTION_CLASS`), not as pills of
 * assorted sizes.
 */
export function expectSameWidth(els: Element[], tolerance = 1): void {
  expectSameExtent(els, 'width', tolerance)
}

/** All `els` share one height, within `tolerance` px: cards in one grid row. */
export function expectSameHeight(els: Element[], tolerance = 1): void {
  expectSameExtent(els, 'height', tolerance)
}

function expectSameExtent(
  els: Element[],
  extent: 'width' | 'height',
  tolerance: number
): void {
  if (els.length < 2) {
    expect.fail(
      `expectSame${extent}: need at least two elements, got ${els.length}`
    )
  }
  const sizes = els.map((el) => rect(el)[extent])
  const min = Math.min(...sizes)
  const max = Math.max(...sizes)
  if (max - min > tolerance) {
    expect.fail(
      `${extent}s differ by ${px(max - min)}: ` +
        els.map((el, i) => `${describe(el)} ${px(sizes[i])}`).join(', ')
    )
  }
}

/**
 * The vertical centres of `a` and `b` coincide within `tolerance` px: an
 * icon level with its title, a badge level with the name beside it.
 */
export function expectVerticallyCentered(
  a: Element,
  b: Element,
  tolerance = 1.5
): void {
  const ra = rect(a)
  const rb = rect(b)
  const centreA = ra.top + ra.height / 2
  const centreB = rb.top + rb.height / 2
  const delta = centreA - centreB
  if (Math.abs(delta) > tolerance) {
    expect.fail(
      `${describe(a)} centre ${px(centreA)} sits ${px(Math.abs(delta))} ` +
        `${delta < 0 ? 'above' : 'below'} ${describe(b)} centre ${px(centreB)}` +
        ` (tolerance ${px(tolerance)}).`
    )
  }
}

/** How a button's label sits inside it, in px. */
export type TextPlacement = {
  /** Gap between the button's top edge and the text's content area. */
  top: number
  /** Gap between the text's content area and the button's bottom edge. */
  bottom: number
  /** Gap between the button's top edge and the ink of a capital letter. */
  capTop: number
  /** Gap between the baseline and the button's bottom edge. */
  baselineBottom: number
}

/**
 * Measure where a button's text sits. `top`/`bottom` come from the text's
 * `Range.getBoundingClientRect()` — the content area the browser centres —
 * and are what `expectTextCentered` asserts. `capTop`/`baselineBottom` are
 * what the eye judges: the ink of a capital against the button's edges,
 * from the font's cap height on a canvas measured with the button's font.
 */
export function measureTextPlacement(button: HTMLElement): TextPlacement {
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let textRect: DOMRect | null = null
  let sample: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.trim()) continue
    range.selectNodeContents(text)
    const r = range.getBoundingClientRect()
    if (r.width === 0) continue
    sample ??= text
    textRect = textRect
      ? new DOMRect(
          Math.min(textRect.left, r.left),
          Math.min(textRect.top, r.top),
          0,
          Math.max(textRect.bottom, r.bottom) - Math.min(textRect.top, r.top)
        )
      : r
  }
  range.detach()
  if (!textRect || !sample) {
    expect.fail(`${describe(button)} has no visible text to measure.`)
  }

  const box = rect(button)
  const style = getComputedStyle(sample.parentElement ?? button)
  const context = document.createElement('canvas').getContext('2d')
  if (!context) expect.fail('canvas 2d context unavailable')
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const metrics = context.measureText('H')
  const baseline = textRect.top + metrics.fontBoundingBoxAscent
  const capTop = baseline - metrics.actualBoundingBoxAscent

  return {
    top: textRect.top - box.top,
    bottom: box.bottom - textRect.bottom,
    capTop: capTop - box.top,
    baselineBottom: box.bottom - baseline,
  }
}

/**
 * A button's label sits in the middle of it: the gap above the text's box
 * equals the gap below it, within `tolerance` px. The message also reports
 * the cap-height ink gaps, which is where "the text sits high" shows even
 * when the boxes are centred.
 */
export function expectTextCentered(button: HTMLElement, tolerance = 1): void {
  const p = measureTextPlacement(button)
  const delta = p.top - p.bottom
  if (Math.abs(delta) > tolerance) {
    expect.fail(
      `${describe(button)} text sits ${px(Math.abs(delta))} too ${delta < 0 ? 'high' : 'low'}: ` +
        `gap above ${px(p.top)}, below ${px(p.bottom)} ` +
        `(cap ink from top ${px(p.capTop)}, baseline from bottom ${px(p.baselineBottom)}).`
    )
  }
}

/**
 * `el`'s box lies inside `container`'s box on all four sides, within
 * `tolerance` px: a button fully inside its dialog, a badge inside its row.
 */
export function expectFits(
  el: Element,
  container: Element,
  tolerance = 1
): void {
  const inner = rect(el)
  const outer = rect(container)
  const faults: string[] = []
  if (inner.left < outer.left - tolerance)
    faults.push(`left ${px(inner.left)} < ${px(outer.left)}`)
  if (inner.right > outer.right + tolerance)
    faults.push(`right ${px(inner.right)} > ${px(outer.right)}`)
  if (inner.top < outer.top - tolerance)
    faults.push(`top ${px(inner.top)} < ${px(outer.top)}`)
  if (inner.bottom > outer.bottom + tolerance)
    faults.push(`bottom ${px(inner.bottom)} > ${px(outer.bottom)}`)
  if (faults.length > 0) {
    expect.fail(
      `${describe(el)} does not fit inside ${describe(container)}: ${faults.join('; ')}.`
    )
  }
}
