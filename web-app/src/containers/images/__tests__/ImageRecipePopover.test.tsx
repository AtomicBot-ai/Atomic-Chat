import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { makeRecipe } from '@/lib/diffusion/__tests__/image-fixtures'
import type { ImageRecipe } from '@/services/diffusion/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))

import { ImageRecipePopover } from '../ImageRecipePopover'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Open Details and read its rows as label → value. */
async function detailsOf(recipe: ImageRecipe): Promise<Map<string, string>> {
  render(
    <ImageRecipePopover
      recipe={recipe}
      modelDiffers={false}
      onRestore={vi.fn()}
    />
  )
  await act(async () => {
    await userEvent.click(screen.getByTestId('image-recipe-trigger'))
  })
  const list = (
    await screen.findByTestId('image-recipe-restore')
  ).parentElement!.querySelector('dl')!
  const rows = new Map<string, string>()
  for (const term of within(list).getAllByRole('term')) {
    rows.set(term.textContent ?? '', term.nextElementSibling?.textContent ?? '')
  }
  return rows
}

/** Nano Banana through OpenRouter, as the core records it: no steps, CFG or seed sent. */
const cloudRecipe = makeRecipe({
  steps: 0,
  cfgScale: 0,
  guidance: null,
  seed: -1,
  batchSeed: -1,
  batchSize: 1,
  samplingMethod: null,
  model: {
    modelId: 'google/gemini-3.1-flash-image',
    family: 'openrouter' as ImageRecipe['model']['family'],
    displayName: 'Nano Banana 2.1',
    filename: '',
  },
  engine: { kind: 'remote', provider: 'openrouter', api: 'openrouter-images' },
})

describe('ImageRecipePopover', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  it('leaves out the steps, CFG and seed a provider was never sent', async () => {
    const rows = await detailsOf(cloudRecipe)
    expect(rows.has('images:viewer.details.steps')).toBe(false)
    expect(rows.has('images:viewer.details.cfg')).toBe(false)
    expect(rows.has('images:viewer.details.seed')).toBe(false)
    expect(rows.has('images:viewer.details.batchSeed')).toBe(false)
    // What the provider did report stays.
    expect(rows.get('images:viewer.details.model')).toBe('Nano Banana 2.1')
    expect(rows.get('images:viewer.details.size')).toBe('1024×768')
    expect(rows.has('images:viewer.details.engine')).toBe(true)
  })

  it('shows the knobs a provider was sent, a zero seed included', async () => {
    const rows = await detailsOf({
      ...cloudRecipe,
      steps: 28,
      cfgScale: 4.5,
      seed: 1,
      batchSeed: 0,
      index: 1,
      batchSize: 2,
    })
    expect(rows.get('images:viewer.details.steps')).toBe('28')
    expect(rows.get('images:viewer.details.cfg')).toBe('4.5')
    expect(rows.get('images:viewer.details.seed')).toBe('1')
    expect(rows.get('images:viewer.details.batchSeed')).toBe('0 · 2/2')
  })

  it('keeps a local result’s explicit zeros', async () => {
    const rows = await detailsOf(
      makeRecipe({ steps: 8, cfgScale: 0, seed: 0, batchSeed: 0, batchSize: 1 })
    )
    expect(rows.get('images:viewer.details.steps')).toBe('8')
    expect(rows.get('images:viewer.details.cfg')).toBe('0')
    expect(rows.get('images:viewer.details.seed')).toBe('0')
  })
})
