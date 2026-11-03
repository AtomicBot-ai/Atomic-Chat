import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { makeVideoRecipe } from '@/lib/diffusion/__tests__/video-fixtures'
import type { VideoRecipe } from '@/services/diffusion/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))

import { VideoRecipePopover } from '../VideoRecipePopover'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Open Details and read its rows as label → value. */
async function detailsOf(recipe: VideoRecipe): Promise<Map<string, string>> {
  render(
    <VideoRecipePopover
      recipe={recipe}
      modelDiffers={false}
      onRestore={vi.fn()}
    />
  )
  await act(async () => {
    await userEvent.click(screen.getByTestId('video-recipe-trigger'))
  })
  const list = (
    await screen.findByTestId('video-recipe-restore')
  ).parentElement!.querySelector('dl')!
  const rows = new Map<string, string>()
  for (const term of within(list).getAllByRole('term')) {
    rows.set(term.textContent ?? '', term.nextElementSibling?.textContent ?? '')
  }
  return rows
}

/** A provider's clip as the core records it: the form's steps and CFG, no seed. */
const cloudClip = makeVideoRecipe({
  frames: 0,
  frameCount: 0,
  fps: 0,
  steps: 8,
  cfgScale: 1,
  seed: -1,
  samplingMethod: null,
  durationSecs: 8,
  model: {
    modelId: 'veo-3.1-fast',
    family: 'gemini' as VideoRecipe['model']['family'],
    displayName: 'Veo 3.1 Fast',
    filename: '',
  },
  engine: { kind: 'remote', provider: 'gemini', api: 'gemini-veo' },
})

describe('VideoRecipePopover', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  it('leaves out the seed, steps and CFG a provider was never sent', async () => {
    const rows = await detailsOf(cloudClip)
    expect(rows.has('videos:viewer.details.seed')).toBe(false)
    expect(rows.has('videos:viewer.details.steps')).toBe(false)
    expect(rows.has('videos:viewer.details.cfg')).toBe(false)
    expect(rows.get('videos:viewer.details.model')).toBe('Veo 3.1 Fast')
    expect(rows.has('videos:viewer.details.duration')).toBe(true)
  })

  it('shows a seed a provider was sent, zero included', async () => {
    const rows = await detailsOf({ ...cloudClip, seed: 0 })
    expect(rows.get('videos:viewer.details.seed')).toBe('0')
  })

  it('keeps a local clip’s explicit zeros', async () => {
    const rows = await detailsOf(
      makeVideoRecipe({ steps: 8, cfgScale: 0, seed: 0 })
    )
    expect(rows.get('videos:viewer.details.steps')).toBe('8')
    expect(rows.get('videos:viewer.details.cfg')).toBe('0')
    expect(rows.get('videos:viewer.details.seed')).toBe('0')
  })
})
