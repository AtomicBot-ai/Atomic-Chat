import { act, render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  ACE,
  MOSS,
  QWEN,
  SFX,
  SFX_WIRE,
  makeFakeAudio,
  makeFile,
  makeItem,
  makeJob,
} from '@/lib/audio/__tests__/audio-fixtures'
import { audioDownloadTaskId } from '@/lib/audio/models'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectSameWidth,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://${path}`,
}))
vi.mock('@/lib/notifications', () => ({ notifyUnlessWatching: vi.fn() }))

import { AudioGenerationPage } from './AudioGenerationPage'

const CLIP =
  'A very long description of a sound that goes on past what a tile can show, and then some more'

/** A page with a model on disk, one downloading and one still to fetch. */
async function seedStudio() {
  useAudioGenerationStore.getState().reset()
  seedServiceHub({ audio: makeFakeAudio() })
  useDownloadStore.setState({
    downloads: {
      [audioDownloadTaskId(`${MOSS}:q8_0`)]: {
        name: 'x',
        progress: 1,
        current: 1,
        total: 1,
      },
    },
  })
  render(withTranslations(<AudioGenerationPage />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  useAudioGenerationStore.setState({
    modelFiles: [makeFile(QWEN), makeFile(SFX)],
    gallery: [
      makeItem('sfx', { mode: 'effects', modelId: SFX_WIRE, text: CLIP }),
      makeItem('song', { mode: 'music', modelId: `${ACE}:q8_0`, text: CLIP }),
    ],
    galleryTotal: 2,
    selectedId: 'sfx',
  })
}

describe('Audios studio geometry', () => {
  beforeEach(async () => {
    await page.viewport(1024, 800)
  })

  it.each([
    { fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'holds the form and the results at 1024 px, $fontSize/$theme',
    async ({ fontSize, theme }) => {
      setFontSize(fontSize)
      setTheme(theme)
      await seedStudio()
      await settle()

      expectNoHorizontalOverflow(screen.getByTestId('audio-form-scroller'))
      expectNoHorizontalOverflow(screen.getByTestId('audio-viewer-section'))
      expectNoHorizontalOverflow(screen.getByTestId('audio-gallery-grid'))
    }
  )

  it.each([
    { fontSize: DEFAULT_FONT_SIZE, theme: 'dark' as const },
    { fontSize: XL_FONT_SIZE, theme: 'light' as const },
  ])(
    'keeps one action slot in the model list whatever a row’s state, $fontSize/$theme',
    async ({ fontSize, theme }) => {
      setFontSize(fontSize)
      setTheme(theme)
      await seedStudio()
      act(() => {
        useAudioGenerationStore.setState({
          modelFiles: [makeFile(QWEN)],
        })
      })
      screen.getByTestId('audio-models-toggle').click()
      await settle()

      const list = await screen.findByTestId('audio-models-list')
      expectNoHorizontalOverflow(list)
      const slots = [QWEN, MOSS].map(
        (id) =>
          within(screen.getByTestId(`audio-model-${id}`)).getByTestId(
            'audio-model-action'
          ) as HTMLElement
      )
      expectSameWidth(slots)
    }
  )

  it('leaves the selected tile’s ring room under the top of the gallery’s scroll box', async () => {
    setFontSize(DEFAULT_FONT_SIZE)
    setTheme('dark')
    await seedStudio()
    await settle()

    const grid = screen.getByTestId('audio-gallery-grid')
    const scroller = grid.parentElement!
    const tile = within(grid).getAllByRole('button', { pressed: true })[0]
    const ring = 2 // ring-2: drawn outside the tile, where the scroll box clips it
    expect(
      tile.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    ).toBeGreaterThanOrEqual(ring)
  })

  it('shows a job’s phase in the pane without moving the gallery off the page', async () => {
    setFontSize(DEFAULT_FONT_SIZE)
    setTheme('light')
    await seedStudio()
    act(() => {
      useAudioGenerationStore.setState({
        generating: true,
        currentJob: makeJob({
          state: 'generating',
          progress: { phase: 'generating', elapsedMs: 0 },
        }),
      })
    })
    await settle()

    const pane = screen.getByTestId('audio-job-status-pane')
    expect(pane.getBoundingClientRect().height).toBeGreaterThan(0)
    expectNoHorizontalOverflow(screen.getByTestId('audio-viewer-section'))
    expect(screen.getByTestId('audio-gallery-grid')).toBeVisible()
  })
})
