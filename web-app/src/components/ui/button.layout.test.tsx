import { describe, it } from 'vitest'
import { render } from '@testing-library/react'

import { Button } from '@/components/ui/button'
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
