import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { MediaParamSpec } from '@/services/media/contract'
import { MediaParamGroups } from '../MediaParamGroup'

const rules = {
  native: [1024, 1024] as [number, number],
  multiple: 64,
  min_side: 512,
  max_side: 2048,
  pixel_budget: 1024 * 1024,
  comfortable_min_pixels: 768 * 768,
  comfortable_max_pixels: 1280 * 1280,
  vram_mb_per_megapixel: 1800,
  base_memory_mb: 8192,
}

const specs: MediaParamSpec[] = [
  {
    id: 'resolution',
    type: 'resolution',
    group: 'output',
    label: 'Resolution',
    default: '1024x1024',
    size_rules: rules,
    options: [
      { value: '1024x1024', label: '1:1 · 1024 × 1024 (native)', width: 1024, height: 1024, vram_mb: 10079 },
      { value: '1344x768', label: '16:9 · 1344 × 768', width: 1344, height: 768, vram_mb: 10050 },
      { value: 'custom', label: 'Custom size…' },
    ],
  },
  {
    id: 'output_size',
    type: 'enum',
    group: 'output',
    label: 'Output size',
    default: 'native',
    options: [
      { value: 'native', label: 'As rendered', long_edge: 0 },
      { value: '4k', label: '4K', long_edge: 3840 },
    ],
  },
  {
    id: 'custom_width',
    type: 'int',
    group: 'output',
    advanced: true,
    depends_on: [{ param: 'resolution', equals: 'custom' }],
  },
  { id: 'seed', type: 'seed', group: 'advanced', advanced: true },
]

function show(values: Record<string, unknown>) {
  render(<MediaParamGroups specs={specs} values={values} onChange={() => {}} onBlur={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /show advanced/i }))
  return screen.getByTestId('media-size-insight')
}

describe('SizeInsight', () => {
  it('stays hidden until the advanced section is opened', () => {
    render(<MediaParamGroups specs={specs} values={{}} onChange={() => {}} onBlur={() => {}} />)
    expect(screen.queryByTestId('media-size-insight')).toBeNull()
  })

  it('shows the preset size, its memory estimate and the 4K target', () => {
    const insight = show({ resolution: '1344x768', output_size: '4k' })
    expect(insight.textContent).toContain('1344 × 768')
    expect(insight.textContent).toContain('3840 × 2194')
    expect(insight.textContent).toContain('9.8 GB')
  })

  it('snaps a custom size and warns when it is too large', () => {
    const insight = show({ resolution: 'custom', custom_width: 3000, custom_height: 2000 })
    expect(insight.textContent).toContain('2048 × 1984')
    expect(insight.textContent).toMatch(/Larger than this model/)
  })
})
