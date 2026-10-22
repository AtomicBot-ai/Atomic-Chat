import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import {
  LTX_Q4_ID,
  makeVideoItem,
  makeVideoLoadedStatus,
} from '@/lib/diffusion/__tests__/video-fixtures'
import type { GalleryVideoItem } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { VideoGenerationPage } from './VideoGenerationPage'

/** The clip the mocked gallery has open. */
let openClip: GalleryVideoItem = makeVideoItem()

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => path,
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/hooks/useImageEngine', () => ({
  useImageEngine: () => ({ installed: true }),
}))
vi.mock('@/hooks/useVideoGallery', () => ({
  useVideoGallery: () => ({
    items: [openClip],
    hasMore: false,
    total: 1,
    loading: false,
    initialized: true,
    selected: openClip,
    selectedId: openClip.id,
    selectedIds: [openClip.id],
    loadMore: vi.fn(),
    reload: vi.fn(),
    select: vi.fn(),
    toggleSelect: vi.fn(),
    step: vi.fn(),
    remove: vi.fn(),
  }),
}))
vi.mock('@/hooks/useServiceHub', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/hooks/useServiceHub')>()
  const serviceHub = {
    dialog: () => ({ save: vi.fn() }),
    diffusion: () => ({}),
    opener: () => ({ revealItemInDir: vi.fn(), openPath: vi.fn() }),
  }
  return {
    ...original,
    useServiceHub: () => serviceHub,
    getServiceHub: () => serviceHub,
  }
})
vi.mock('./VideoPromptForm', () => ({
  VideoPromptForm: () => <div data-testid="video-prompt-form" />,
}))
vi.mock('./VideoGalleryGrid', () => ({
  VideoGalleryGrid: () => (
    <div className="h-40" data-testid="video-gallery-grid" />
  ),
}))

const posterSvg = (width: number, height: number) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#4a6d8c"/></svg>`
  )

const clipOf = (width: number, height: number) =>
  makeVideoItem({
    id: `clip-${width}x${height}`,
    width,
    height,
    posterPath: posterSvg(width, height),
    path: 'data:video/webm;base64,',
  })

describe('video page viewer geometry', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useVideoForm.persist.rehydrate()
    await useVideoSetting.persist.rehydrate()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM })
    useVideoSetting.setState({ selectedArtifactId: LTX_Q4_ID })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({ status: makeVideoLoadedStatus() })
    useVideoGenerationStore.getState().reset()
    useVideoGalleryStore.getState().reset()
    openClip = makeVideoItem()
  })

  // The window the audit measured (1024 × 740 with the sidebar open) and the
  // default 1280 layout, each shape at Medium and Extra Large.
  const cases = [
    { shape: 'landscape', width: 1216, height: 704 },
    { shape: 'square', width: 768, height: 768 },
    { shape: 'portrait', width: 704, height: 1216 },
  ].flatMap((shape) => [
    {
      ...shape,
      viewport: 1024,
      viewportHeight: 740,
      font: XL_FONT_SIZE,
      theme: 'dark' as const,
    },
    {
      ...shape,
      viewport: 1280,
      viewportHeight: 800,
      font: DEFAULT_FONT_SIZE,
      theme: 'light' as const,
    },
  ])

  it.each(cases)(
    'keeps the actions under the $shape clip and gives the gallery the rest at $viewport px, $font',
    async ({ width, height, viewport, viewportHeight, font, theme }) => {
      await page.viewport(viewport, viewportHeight)
      setFontSize(font)
      setTheme(theme)
      openClip = clipOf(width, height)
      const view = render(
        withTranslations(
          <div style={{ marginLeft: 256, width: viewport - 256 }}>
            <VideoGenerationPage search={{}} />
          </div>
        )
      )
      await act(async () => {
        await settle(view.container)
      })

      const root = screen.getByTestId('video-generation-page')
      const viewerSection = screen.getByTestId('video-viewer-section')
      const section = viewerSection.getBoundingClientRect()
      const pane = viewerSection.parentElement!.getBoundingClientRect()
      const gallery = viewerSection.nextElementSibling!.getBoundingClientRect()
      const region = screen
        .getByTestId('video-viewer-region')
        .getBoundingClientRect()
      const frame = screen
        .getByTestId('video-viewer-frame')
        .getBoundingClientRect()
      const toolbar = screen
        .getByTestId('video-recipe-trigger')
        .parentElement!.getBoundingClientRect()

      expect(frame.width / frame.height).toBeCloseTo(width / height, 1)
      expect(frame.left).toBeGreaterThanOrEqual(region.left - 1)
      expect(frame.right).toBeLessThanOrEqual(region.right + 1)
      // Details, Save as, Show in folder and Delete hug the clip's bottom edge.
      expect(toolbar.top - frame.bottom).toBeGreaterThanOrEqual(-0.5)
      expect(toolbar.top - frame.bottom).toBeLessThanOrEqual(8.5)
      expect(section.bottom - toolbar.bottom).toBeLessThanOrEqual(8.5)
      expect(gallery.top).toBeCloseTo(section.bottom, 0)
      expect(gallery.bottom).toBeCloseTo(pane.bottom, 0)
      expect(section.bottom - pane.top).toBeLessThanOrEqual(
        pane.height * 0.6 + 1
      )
      const capped = section.bottom - pane.top >= pane.height * 0.6 - 1
      expect(capped || frame.width >= region.width - 1).toBe(true)
      expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1)
      expectNoHorizontalOverflow(root)
    }
  )

  it('holds the live preview in the block of the clip it becomes', async () => {
    await page.viewport(1024, 740)
    openClip = clipOf(1216, 704)
    useVideoForm.setState({ width: 1216, height: 704 })
    const view = render(
      withTranslations(
        <div style={{ marginLeft: 256, width: 1024 - 256 }}>
          <VideoGenerationPage search={{}} />
        </div>
      )
    )
    await act(async () => {
      await settle(view.container)
    })
    const viewerSection = screen.getByTestId('video-viewer-section')
    const shown = viewerSection.getBoundingClientRect()
    const shownFrame = screen
      .getByTestId('video-viewer-frame')
      .getBoundingClientRect()

    act(() => {
      useVideoGalleryStore.getState().selectLive()
      useVideoGenerationStore.setState({ generating: true })
    })
    const preview = await screen.findByTestId('image-generation-preview')
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const live = viewerSection.getBoundingClientRect()
    const liveFrame = (
      preview.firstElementChild as HTMLElement
    ).getBoundingClientRect()
    expect(live.height).toBeCloseTo(shown.height, 0)
    expect(liveFrame.width).toBeCloseTo(shownFrame.width, 0)
    expect(liveFrame.height).toBeCloseTo(shownFrame.height, 0)
    expect(liveFrame.top - live.top).toBeCloseTo(shownFrame.top - shown.top, 0)
    expectNoHorizontalOverflow(screen.getByTestId('video-generation-page'))
  })
})
