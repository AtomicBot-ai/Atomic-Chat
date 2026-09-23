import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeFakeDiffusion,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_Q4_ID,
  makeVideoItem,
  makeVideoLoadedStatus,
  makeVideoRecipe,
  WAN_Q4_ID,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { seedServiceHub } from '@/test/service-hub'
import type { ServiceHub } from '@/services'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'videos:viewer.details.framesValue'
        ? `${values?.frames} @ ${values?.fps} fps`
        : key,
  }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}))
// jsdom decodes no video; the poster capture has its own tests. A test may
// hold the capture back to look at the tile before the poster lands.
const poster = vi.hoisted(() => ({
  release: null as null | (() => void),
  hold: false,
}))
vi.mock('@/lib/video/poster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/video/poster')>()),
  capturePosterForClip: vi.fn(
    () =>
      new Promise<string>((resolve) => {
        if (poster.hold) poster.release = () => resolve('UE5H')
        else resolve('UE5H')
      })
  ),
}))

import { useVideoGallery } from '@/hooks/useVideoGallery'
import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoGalleryGrid } from '../VideoGalleryGrid'
import { VideoViewer } from '../VideoViewer'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The right column of the page: the viewer over the grid, both on the store. */
function Gallery({ onOfferLoad = vi.fn() }: { onOfferLoad?: (id: string) => void }) {
  const gallery = useVideoGallery()
  const requestPoster = useVideoGenerationStore((state) => state.requestPoster)
  return (
    <>
      <VideoViewer
        item={gallery.selected}
        selectedIds={gallery.selectedIds}
        onOfferLoad={onOfferLoad}
      />
      <VideoGalleryGrid
        items={gallery.items}
        selectedId={gallery.selectedId}
        selectedIds={gallery.selectedIds}
        hasMore={gallery.hasMore}
        loading={gallery.loading}
        onSelect={gallery.toggleSelect}
        onOpen={gallery.select}
        onLoadMore={() => void gallery.loadMore()}
        onVisibleWithoutPoster={requestPoster}
      />
    </>
  )
}

describe('VideoViewer', () => {
  let fake: FakeDiffusion
  const save = vi.fn(async () => '/Users/me/Movies/out.webm')
  const revealItemInDir = vi.fn(async () => undefined)
  const openPath = vi.fn(async () => undefined)
  const first = makeVideoItem({
    id: 'vjob-1',
    recipe: makeVideoRecipe({ prompt: 'a red door', seed: 42, frames: 49, frameCount: 49 }),
  })
  const second = makeVideoItem({
    id: 'vjob-2',
    posterPath: null,
    frameCount: 121,
    durationSecs: 121 / 24,
    recipe: makeVideoRecipe({
      jobId: 'vjob-2',
      prompt: 'a blue window',
      seed: 7,
      frames: 121,
      frameCount: 121,
      model: {
        modelId: WAN_Q4_ID,
        family: 'wan2.2-ti2v-5b',
        displayName: 'Wan 2.2 TI2V 5B Q4_K_M',
        filename: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
      },
    }),
  })

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useVideoForm.persist.rehydrate()
    await useVideoSetting.persist.rehydrate()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM })
    useVideoSetting.setState({ selectedArtifactId: LTX_Q4_ID })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({ status: makeVideoLoadedStatus() })
    useVideoGenerationStore.getState().reset()
    poster.hold = false
    poster.release = null
    fake = makeFakeDiffusion()
    // The core answers with the same clip, now carrying its poster.
    fake.setVideoPoster.mockImplementation(async (id) => ({
      ...([first, second].find((item) => item.id === id) ?? makeVideoItem({ id })),
      posterPath: `/data/videos/${id}.thumb.png`,
    }))
    fake.listVideoGallery.mockImplementation(async ({ offset, limit }) => ({
      items: [first, second].slice(offset, offset + limit),
      hasMore: false,
      total: 2,
    }))
    seedServiceHub({
      diffusion: fake,
      dialog: { open: vi.fn(), save } as unknown as ReturnType<ServiceHub['dialog']>,
      opener: {
        open: vi.fn(),
        openPath,
        revealItemInDir,
      } as unknown as ReturnType<ServiceHub['opener']>,
    })
    useVideoGalleryStore.getState().reset()
  })

  it('plays the selected clip from the asset protocol with its poster, and says nothing about the prompt', async () => {
    render(<Gallery />)
    const viewer = await screen.findByTestId('video-viewer')
    const player = viewer.querySelector('video')!
    expect(player.getAttribute('src')).toMatch(/vjob-1\.webm$/)
    expect(player.getAttribute('src')).toMatch(/^asset:/)
    expect(player.getAttribute('poster')).toMatch(/vjob-1\.thumb\.png$/)
    expect(player).toHaveAttribute('controls')
    expect(player).toHaveAttribute('preload', 'metadata')
    expect(screen.getByTestId('video-dimension-badge')).toHaveTextContent('768×512 · 24 fps')
    expect(screen.getByTestId('video-viewer-frame')).toHaveClass('overflow-hidden', 'rounded-lg')
  })

  it('offers the system player when the webview cannot decode the clip', async () => {
    render(<Gallery />)
    const player = (await screen.findByTestId('video-viewer')).querySelector('video')!
    fireEvent.error(player)
    expect(screen.getByTestId('video-playback-unsupported')).toHaveTextContent(
      'videos:viewer.playbackUnsupported'
    )
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-open-in-player'))
    })
    expect(openPath).toHaveBeenCalledWith('/data/videos/vjob-1.webm')
    // The next clip gets a fresh chance.
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-tile-vjob-2'))
    })
    expect(screen.getByTestId('video-player')).toBeInTheDocument()
  })

  it('shows a tile without a poster as a mark, asks for the poster once it is on screen, and fills it in', async () => {
    poster.hold = true
    render(<Gallery />)
    await screen.findByTestId('video-viewer')
    const tile = screen.getByTestId('video-tile-vjob-2')
    expect(tile.querySelector('img')).toBeNull()
    expect(screen.getByTestId('video-tile-poster-missing')).toBeInTheDocument()
    expect(tile.querySelector('[data-testid="video-tile-duration"]')).toHaveTextContent('5.0s')
    expect(screen.getByTestId('video-tile-vjob-1').querySelector('img')?.getAttribute('src')).toMatch(
      /vjob-1\.thumb\.png$/
    )
    // jsdom has no IntersectionObserver: the tile asked at once; the capture is still running.
    await waitFor(() => expect(poster.release).not.toBeNull())
    expect(fake.setVideoPoster).not.toHaveBeenCalled()
    await act(async () => {
      poster.release?.()
    })
    await waitFor(() => expect(fake.setVideoPoster).toHaveBeenCalledWith('vjob-2', 'UE5H'))
    await waitFor(() =>
      expect(
        screen.getByTestId('video-tile-vjob-2').querySelector('img')?.getAttribute('src')
      ).toMatch(/vjob-2\.thumb\.png$/)
    )
    expect(screen.queryByTestId('video-tile-poster-missing')).not.toBeInTheDocument()
  })

  it('restores the recipe into the form, the requested frame count included', async () => {
    render(<Gallery />)
    await screen.findByTestId('video-viewer')
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-recipe-trigger'))
    })
    expect(await screen.findByText('49 @ 24 fps')).toBeInTheDocument()
    const restore = await screen.findByTestId('video-recipe-restore')
    expect(restore).toHaveTextContent('videos:viewer.restore')
    await act(async () => {
      await userEvent.click(restore)
    })
    expect(useVideoForm.getState()).toMatchObject({
      prompt: 'a red door',
      frames: 49,
      seedText: '42',
    })
    expect(toast.success).toHaveBeenCalledWith('videos:viewer.restored')
  })

  it('switches the selected model and offers to load it when the recipe used another', async () => {
    const onOfferLoad = vi.fn()
    render(<Gallery onOfferLoad={onOfferLoad} />)
    await screen.findByTestId('video-viewer')
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-tile-vjob-2'))
    })
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-recipe-trigger'))
    })
    const restore = await screen.findByTestId('video-recipe-restore')
    expect(restore).toHaveTextContent('videos:viewer.restoreAndLoad')
    await act(async () => {
      await userEvent.click(restore)
    })
    expect(useVideoSetting.getState().selectedArtifactId).toBe(WAN_Q4_ID)
    expect(onOfferLoad).toHaveBeenCalledWith(WAN_Q4_ID)
    expect(useVideoForm.getState().prompt).toBe('a blue window')
  })

  it('offers the export name to the save dialog and copies the file there', async () => {
    render(<Gallery />)
    await screen.findByTestId('video-viewer')
    await act(async () => {
      await userEvent.click(screen.getByText('videos:viewer.saveAs'))
    })
    expect(save.mock.calls[0][0]).toMatchObject({
      defaultPath: expect.stringMatching(/^AtomicChat_\d{8}-\d{6}_42\.webm$/),
    })
    await waitFor(() =>
      expect(fake.exportVideoGalleryItem).toHaveBeenCalledWith(
        'vjob-1',
        '/Users/me/Movies/out.webm'
      )
    )
    expect(toast.success).toHaveBeenCalledWith('videos:viewer.saved')
  })

  it('reveals the file on disk', async () => {
    render(<Gallery />)
    await screen.findByTestId('video-viewer')
    await act(async () => {
      await userEvent.click(screen.getByText('videos:viewer.reveal'))
    })
    expect(revealItemInDir.mock.calls[0][0]).toBe('/data/videos/vjob-1.webm')
  })

  it('deletes after confirmation and moves on to the next tile', async () => {
    render(<Gallery />)
    await screen.findByTestId('video-viewer')
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-viewer-delete'))
    })
    await act(async () => {
      await userEvent.click(await screen.findByTestId('gallery-delete-confirm'))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('video-tile-vjob-1')).not.toBeInTheDocument()
    )
    expect(fake.deleteVideoGalleryItems).toHaveBeenCalledWith(['vjob-1'])
    expect(useVideoGalleryStore.getState().selectedId).toBe('vjob-2')
  })

  it('steps through the gallery with the arrow keys, opens delete with Delete, and leaves text fields alone', async () => {
    render(
      <>
        <input data-testid="field" />
        <Gallery />
      </>
    )
    await screen.findByTestId('video-viewer')
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(useVideoGalleryStore.getState().selectedId).toBe('vjob-2')
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(useVideoGalleryStore.getState().selectedId).toBe('vjob-1')
    const field = screen.getByTestId('field')
    field.focus()
    fireEvent.keyDown(field, { key: 'ArrowRight' })
    expect(useVideoGalleryStore.getState().selectedId).toBe('vjob-1')
    fireEvent.keyDown(document, { key: 'Delete' })
    expect(await screen.findByTestId('gallery-delete-confirm')).toBeInTheDocument()
  })

  it('shows an empty state without a clip', () => {
    render(<VideoViewer item={null} selectedIds={[]} onOfferLoad={vi.fn()} />)
    expect(screen.getByTestId('video-viewer-empty')).toHaveTextContent('videos:viewer.empty')
  })
})
