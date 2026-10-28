import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { expectTextCentered, measureTextPlacement, settle } from '@/test/layout'

/**
 * Real-browser layout: the label of every text-bearing `Button` sits in the
 * middle of the pill — the gap above the text equals the gap below it.
 * Danny's report: text sitting high inside buttons. jsdom cannot see it;
 * this suite measures the rendered box.
 */
const TEXT_SIZES = ['xs', 'sm', 'default', 'lg'] as const
const VARIANTS = [
  'default',
  'destructive',
  'outline',
  'secondary',
  'ghost',
  'link',
] as const

describe('Button text placement (real browser)', () => {
  it.each(TEXT_SIZES)(
    'size=%s: label centred in every variant',
    async (size) => {
      const { container } = render(
        <div className="flex flex-wrap items-start gap-3 p-4">
          {VARIANTS.map((variant) => (
            <Button
              key={variant}
              size={size}
              variant={variant}
              data-testid={`${size}-${variant}`}
            >
              Download 19.7 GB
            </Button>
          ))}
        </div>
      )
      await settle(container)

      const placements: string[] = []
      for (const variant of VARIANTS) {
        const button = container.querySelector<HTMLElement>(
          `[data-testid="${size}-${variant}"]`
        )!
        const p = measureTextPlacement(button)
        placements.push(
          `${variant}: box ${p.top.toFixed(2)}/${p.bottom.toFixed(2)}, ` +
            `cap ${p.capTop.toFixed(2)}/${p.baselineBottom.toFixed(2)}`
        )
        expectTextCentered(button)
      }
      // Leaves the measured gaps in the run log for the button session.
      console.info(`Button size=${size}: ${placements.join(' · ')}`)
    }
  )
})

/**
 * Real-browser layout: inside the app shell every control sits on one scale
 * (`index.css`) — regular actions, fields and selects 28px, compact icon
 * actions 24px, large actions 32px — whatever height a call site asked for,
 * and icon buttons stay square.
 */
describe('Control scale inside the app shell (real browser)', () => {
  const box = (el: Element) => {
    const { width, height } = el.getBoundingClientRect()
    return { width: Math.round(width), height: Math.round(height) }
  }

  it('puts actions, fields and selects on 28/24/32 and keeps icons square', async () => {
    const { container } = render(
      <div className="app-shell">
        <div className="flex flex-wrap items-start gap-3 p-4">
          <Button data-testid="default">Save</Button>
          <Button data-testid="sm" size="sm">
            Save
          </Button>
          <Button data-testid="sm-h7" size="sm" className="h-7">
            Save
          </Button>
          <Button data-testid="icon" size="icon" aria-label="Add" />
          <Button data-testid="icon-sm" size="icon-sm" aria-label="Add" />
          <Button data-testid="xs" size="xs">
            Save
          </Button>
          <Button
            data-testid="icon-xs-size7"
            size="icon-xs"
            className="size-7"
            aria-label="Add"
          />
          <Button data-testid="lg" size="lg">
            Save
          </Button>
          <Button data-testid="icon-lg" size="icon-lg" aria-label="Add" />
          <Input data-testid="input" className="h-8" />
          <select data-testid="select">
            <option>One</option>
          </select>
        </div>
      </div>
    )
    await settle(container)
    const get = (id: string) =>
      container.querySelector(`[data-testid="${id}"]`)!

    for (const id of ['default', 'sm', 'sm-h7', 'input', 'select']) {
      expect(box(get(id)).height, id).toBe(28)
    }
    expect(box(get('icon'))).toEqual({ width: 28, height: 28 })
    expect(box(get('icon-sm'))).toEqual({ width: 28, height: 28 })
    expect(box(get('xs')).height).toBe(24)
    expect(box(get('icon-xs-size7'))).toEqual({ width: 24, height: 24 })
    expect(box(get('lg')).height).toBe(32)
    expect(box(get('icon-lg'))).toEqual({ width: 32, height: 32 })
  })

  it('leaves the title bar sidebar toggle at 28px, like the control beside it', async () => {
    const { container } = render(
      <div className="app-shell">
        <div data-window-titlebar>
          <Button
            data-sidebar="trigger"
            size="icon"
            className="size-7"
            aria-label="Toggle sidebar"
          />
        </div>
      </div>
    )
    await settle(container)
    expect(box(container.querySelector('[data-sidebar="trigger"]')!)).toEqual({
      width: 28,
      height: 28,
    })
  })
})

/**
 * Real-browser: whatever takes a click shows the pointer (Tailwind 4 leaves a
 * bare `<button>` on the arrow, as the composer's model picker was), and a
 * control drawn at its icon's own size takes clicks 15% of its size beyond
 * each edge (`hit-area-15`).
 */
describe('Clickable affordances (real browser)', () => {
  it('shows the pointer on anything clickable that is not disabled or opted out', async () => {
    const { container } = render(
      <div className="flex gap-3 p-4">
        <button type="button" data-testid="bare">
          Qwen3 8B
        </button>
        <div role="button" tabIndex={0} data-testid="role">
          Restricted
        </div>
        <button type="button" disabled data-testid="disabled">
          Off
        </button>
        <button type="button" className="cursor-default" data-testid="opt-out">
          Plain
        </button>
      </div>
    )
    await settle(container)
    const cursor = (id: string) =>
      getComputedStyle(container.querySelector(`[data-testid="${id}"]`)!).cursor

    expect(cursor('bare')).toBe('pointer')
    expect(cursor('role')).toBe('pointer')
    expect(cursor('disabled')).not.toBe('pointer')
    expect(cursor('opt-out')).toBe('default')
  })

  it('lets an icon-only control take clicks 15% beyond its edges', async () => {
    const { container } = render(
      <div className="p-10">
        <button
          type="button"
          data-testid="close"
          className="hit-area-15 relative size-5"
        >
          <X className="size-5" />
          <span className="sr-only">Close</span>
        </button>
      </div>
    )
    await settle(container)
    const close = container.querySelector('[data-testid="close"]')!
    // 20px wide: the reach is 3px on every side.
    const { left, right, top, height, width } = close.getBoundingClientRect()
    const hits = (x: number, y: number) =>
      close.contains(document.elementFromPoint(x, y))

    expect(hits(left - 2, top + height / 2)).toBe(true)
    expect(hits(right + 2, top + height / 2)).toBe(true)
    expect(hits(left + width / 2, top - 2)).toBe(true)
    expect(hits(left - 4, top + height / 2)).toBe(false)
  })
})
