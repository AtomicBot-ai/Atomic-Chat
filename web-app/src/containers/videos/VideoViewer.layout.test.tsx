import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { makeItem } from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_Q4_ID,
  makeVideoItem,
  makeVideoLoadedStatus,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { ImageGalleryGrid } from '@/containers/images/ImageGalleryGrid'
import {
  expectNoHorizontalOverflow,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
  DEFAULT_FONT_SIZE,
} from '@/test/layout'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { VideoGalleryGrid } from './VideoGalleryGrid'
import { VideoViewer } from './VideoViewer'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => path,
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/hooks/useServiceHub', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks/useServiceHub')>()
  const serviceHub = {
    dialog: () => ({ save: vi.fn() }),
    diffusion: () => ({}),
    opener: () => ({ revealItemInDir: vi.fn(), openPath: vi.fn() }),
  }
  return { ...original, useServiceHub: () => serviceHub, getServiceHub: () => serviceHub }
})

const posterSvg = (width: number, height: number) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#4a6d8c"/></svg>`
  )

describe('video viewer geometry', () => {
  beforeEach(async () => {
    await page.viewport(1280, 800)
    localStorage.clear()
    await useVideoForm.persist.rehydrate()
    await useVideoSetting.persist.rehydrate()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM })
    useVideoSetting.setState({ selectedArtifactId: LTX_Q4_ID })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({ status: makeVideoLoadedStatus() })
  })

  it.each([
    { width: 768, height: 512, viewport: 1280, font: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { width: 704, height: 1216, viewport: 1024, font: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'holds the $width × $height clip at its aspect inside the region at $viewport px, toolbar intact',
    async ({ width, height, viewport, font, theme }) => {
      await page.viewport(viewport, 800)
      setFontSize(font)
      setTheme(theme)
      const item = makeVideoItem({
        width,
        height,
        posterPath: posterSvg(width, height),
        path: 'data:video/webm;base64,',
      })
      const view = render(
        withTranslations(
          <div style={{ marginLeft: 256, width: viewport - 256, height: 600 }}>
            <VideoViewer item={item} selectedIds={[]} onOfferLoad={vi.fn()} />
          </div>
        )
      )
      await act(async () => {
        await settle(view.container)
      })
      const region = screen.getByTestId('video-viewer-region').getBoundingClientRect()
      const box = screen.getByTestId('video-viewer-frame').getBoundingClientRect()
      const scale = Math.min(region.width / width, region.height / height)
      expect(box.width).toBeCloseTo(width * scale, 0)
      expect(box.height).toBeCloseTo(height * scale, 0)
      expect(box.top).toBeCloseTo(region.top, 1)
      expect(box.left + box.width / 2).toBeCloseTo(region.left + region.width / 2, 1)
      expect(box.right).toBeLessThanOrEqual(region.right + 1)
      expect(box.bottom).toBeLessThanOrEqual(region.bottom + 1)

      // Details, Save as, Show in folder, Delete all fit on one row.
      const toolbar = screen.getByTestId('video-recipe-trigger').parentElement!
      const buttons = Array.from(toolbar.querySelectorAll('button'))
      expect(buttons).toHaveLength(4)
      const tops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))
      expect(tops.size).toBe(1)
      expectNoHorizontalOverflow(view.container)
    }
  )

  it('folds the toolbar labels away below 32 rem and keeps the icons on one row', async () => {
    const item = makeVideoItem({ posterPath: posterSvg(768, 512), path: 'data:video/webm;base64,' })
    const view = render(
      withTranslations(
        <div style={{ width: 420, height: 500 }}>
          <VideoViewer item={item} selectedIds={[]} onOfferLoad={vi.fn()} />
        </div>
      )
    )
    await act(async () => {
      await settle(view.container)
    })
    const toolbar = screen.getByTestId('video-recipe-trigger').parentElement!
    for (const label of toolbar.querySelectorAll('button > span')) {
      expect(getComputedStyle(label).display).toBe('none')
    }
    const buttons = Array.from(toolbar.querySelectorAll('button'))
    const tops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))
    expect(tops.size).toBe(1)
    expectNoHorizontalOverflow(view.container)
  })

  it('draws video tiles the same size as image tiles, with the duration badge inside', async () => {
    const videos = ['a', 'b', 'c'].map((id) =>
      makeVideoItem({ id, posterPath: posterSvg(768, 512), width: 768, height: 512 })
    )
    const images = ['x', 'y', 'z'].map((id) =>
      makeItem({ id, thumbnailPath: posterSvg(1024, 1024), path: posterSvg(1024, 1024) })
    )
    const view = render(
      withTranslations(
        <div style={{ width: 640 }}>
          <div data-testid="videos">
            <VideoGalleryGrid
              items={videos}
              selectedId="a"
              selectedIds={['a']}
              hasMore={false}
              loading={false}
              onSelect={vi.fn()}
              onOpen={vi.fn()}
              onLoadMore={vi.fn()}
            />
          </div>
          <div data-testid="images">
            <ImageGalleryGrid
              items={images}
              selectedId="x"
              selectedIds={['x']}
              hasMore={false}
              loading={false}
              onSelect={vi.fn()}
              onOpen={vi.fn()}
              onLoadMore={vi.fn()}
            />
          </div>
        </div>
      )
    )
    await act(async () => {
      await settle(view.container)
    })
    const videoTile = screen.getByTestId('video-tile-a').getBoundingClientRect()
    const imageTile = screen.getByTestId('gallery-tile-x').getBoundingClientRect()
    expect(videoTile.width).toBeCloseTo(imageTile.width, 1)
    expect(videoTile.height).toBeCloseTo(imageTile.height, 1)
    expect(videoTile.width).toBeCloseTo(videoTile.height, 1)
    const badge = screen
      .getByTestId('video-tile-a')
      .querySelector('[data-testid="video-tile-duration"]')!
      .getBoundingClientRect()
    expect(badge.right).toBeLessThanOrEqual(videoTile.right)
    expect(badge.bottom).toBeLessThanOrEqual(videoTile.bottom)
    expect(badge.left).toBeGreaterThanOrEqual(videoTile.left)
    expectNoHorizontalOverflow(view.container)
  })
})
