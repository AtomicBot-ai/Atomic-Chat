import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

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
 * (`index.css`) — regular actions, fields and selects 36px, compact icon
 * actions 24px, large actions 40px — whatever height a call site asked for,
 * and icon buttons stay square.
 */
describe('Control scale inside the app shell (real browser)', () => {
  const box = (el: Element) => {
    const { width, height } = el.getBoundingClientRect()
    return { width: Math.round(width), height: Math.round(height) }
  }

  it('puts actions, fields and selects on 36/24/40 and keeps icons square', async () => {
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
      expect(box(get(id)).height, id).toBe(36)
    }
    expect(box(get('icon'))).toEqual({ width: 36, height: 36 })
    expect(box(get('icon-sm'))).toEqual({ width: 36, height: 36 })
    expect(box(get('xs')).height).toBe(24)
    expect(box(get('icon-xs-size7'))).toEqual({ width: 24, height: 24 })
    expect(box(get('lg')).height).toBe(40)
    expect(box(get('icon-lg'))).toEqual({ width: 40, height: 40 })
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
