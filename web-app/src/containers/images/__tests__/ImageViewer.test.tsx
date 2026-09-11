import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeFakeDiffusion,
  makeItem,
  makeLoadedStatus,
  makeRecipe,
  Q4_ID,
  Q8_ID,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'
import type { ServiceHub } from '@/services'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
// The jsdom bridge stub has no asset protocol; this is what the WebView does.
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}))

import { useImageGallery } from '@/hooks/useImageGallery'
import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useImageGalleryStore } from '@/stores/image-gallery-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageGalleryGrid } from '../ImageGalleryGrid'
import { ImageViewer } from '../ImageViewer'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The right column of the page: the viewer over the grid, both on the store. */
function Gallery({ onOfferLoad = vi.fn() }: { onOfferLoad?: (id: string) => void }) {
  const gallery = useImageGallery()
  return (
    <>
      <ImageViewer
        item={gallery.selected}
        selectedIds={gallery.selectedIds}
        onOfferLoad={onOfferLoad}
      />
      <ImageGalleryGrid
        items={gallery.items}
        selectedId={gallery.selectedId}
        selectedIds={gallery.selectedIds}
        hasMore={gallery.hasMore}
        loading={gallery.loading}
        onSelect={gallery.toggleSelect}
        onOpen={gallery.select}
        onLoadMore={() => void gallery.loadMore()}
      />
    </>
  )
}

describe('ImageViewer', () => {
  let fake: FakeDiffusion
  const save = vi.fn(async () => '/Users/me/Downloads/out.png')
  const revealItemInDir = vi.fn(async () => undefined)
  const first = makeItem({
    id: 'job-1-00',
    recipe: makeRecipe({ prompt: 'a red door', batchSeed: 42, seed: 42, batchSize: 1, index: 0 }),
  })
  const second = makeItem({
    id: 'job-2-00',
    recipe: makeRecipe({
      jobId: 'job-2',
      prompt: 'a blue window',
      model: { modelId: Q8_ID, family: 'z-image', displayName: 'Z-Image Turbo Q8_0', filename: 'z-image-turbo-Q8_0.gguf' },
    }),
  })

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useImageForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    useImageForm.setState({ ...DEFAULT_IMAGE_FORM })
    useImageSetting.setState({ selectedArtifactId: Q4_ID })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({ status: makeLoadedStatus(Q4_ID) })
    fake = makeFakeDiffusion()
    fake.gallery = [first, second]
    seedServiceHub({
      diffusion: fake,
      dialog: { open: vi.fn(), save } as unknown as ReturnType<ServiceHub['dialog']>,
      opener: {
        open: vi.fn(),
        openPath: vi.fn(),
        revealItemInDir,
      } as unknown as ReturnType<ServiceHub['opener']>,
    })
    useImageGalleryStore.getState().reset()
  })

  it('shows the selected image from the asset protocol, never fetched', async () => {
    render(<Gallery />)
    const viewer = await screen.findByTestId('image-viewer')
    const img = viewer.querySelector('img')!
    expect(img.getAttribute('src')).toMatch(/job-1-00\.png$/)
    expect(img.getAttribute('src')).not.toMatch(/^\/data/)
    expect(img).toHaveAttribute('alt', 'a red door')
  })

  it('restores the recipe into the form, batch seed included', async () => {
    render(<Gallery />)
    await screen.findByTestId('image-viewer')
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-recipe-trigger'))
    })
    await act(async () => {
      await userEvent.click(await screen.findByTestId('image-recipe-restore'))
    })
    const form = useImageForm.getState()
    expect(form.prompt).toBe('a red door')
    expect(form.seedText).toBe('42')
    expect(form.width).toBe(1024)
    expect(form.height).toBe(768)
    expect(form.aspect).toBe('photo')
    expect(form.workflow).toBe('create')
  })

  it('switches the selected model and offers to load it when the recipe used another', async () => {
    const onOfferLoad = vi.fn()
    render(<Gallery onOfferLoad={onOfferLoad} />)
    await screen.findByTestId('image-viewer')
    await act(async () => {
      await userEvent.click(screen.getByTestId('gallery-tile-job-2-00'))
    })
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-recipe-trigger'))
    })
    const restore = await screen.findByTestId('image-recipe-restore')
    expect(restore).toHaveTextContent('images:viewer.restoreAndLoad')
    await act(async () => {
      await userEvent.click(restore)
    })
    expect(useImageSetting.getState().selectedArtifactId).toBe(Q8_ID)
    expect(onOfferLoad).toHaveBeenCalledWith(Q8_ID)
    expect(useImageForm.getState().prompt).toBe('a blue window')
  })

  it('offers the export name to the save dialog and copies the file there', async () => {
    render(<Gallery />)
    await screen.findByTestId('image-viewer')
    await act(async () => {
      await userEvent.click(screen.getByText('images:viewer.saveAs'))
    })
    expect(save.mock.calls[0][0]).toMatchObject({
      defaultPath: expect.stringMatching(/^AtomicChat_\d{8}-\d{6}_42\.png$/),
    })
    await waitFor(() =>
      expect(fake.exportGalleryItem).toHaveBeenCalledWith(
        'job-1-00',
        '/Users/me/Downloads/out.png'
      )
    )
    expect(toast.success).toHaveBeenCalledWith('images:viewer.saved')
  })

  it('reveals the file on disk', async () => {
    render(<Gallery />)
    await screen.findByTestId('image-viewer')
    await act(async () => {
      await userEvent.click(screen.getByText('images:viewer.reveal'))
    })
    expect(revealItemInDir.mock.calls[0][0]).toBe('/data/images/job-1-00.png')
  })

  it('deletes after confirmation and moves on to the next tile', async () => {
    render(<Gallery />)
    await screen.findByTestId('image-viewer')
    expect(screen.getByTestId('gallery-tile-job-1-00')).toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByTestId('image-viewer-delete'))
    })
    await act(async () => {
      await userEvent.click(await screen.findByTestId('gallery-delete-confirm'))
    })

    await waitFor(() =>
      expect(screen.queryByTestId('gallery-tile-job-1-00')).not.toBeInTheDocument()
    )
    expect(fake.deleteGalleryItems).toHaveBeenCalledWith(['job-1-00'])
    expect(useImageGalleryStore.getState().selectedId).toBe('job-2-00')
    expect(screen.getByTestId('image-viewer').querySelector('img')?.getAttribute('src')).toMatch(
      /job-2-00\.png$/
    )
  })

  it('steps through the gallery with the arrow keys and opens delete with Delete', async () => {
    render(<Gallery />)
    await screen.findByTestId('image-viewer')
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(useImageGalleryStore.getState().selectedId).toBe('job-2-00')
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(useImageGalleryStore.getState().selectedId).toBe('job-1-00')

    fireEvent.keyDown(document, { key: 'Delete' })
    expect(await screen.findByTestId('gallery-delete-confirm')).toBeInTheDocument()
  })

  it('leaves the arrow keys alone while a text field has focus', async () => {
    render(
      <>
        <input data-testid="field" />
        <Gallery />
      </>
    )
    await screen.findByTestId('image-viewer')
    const field = screen.getByTestId('field')
    field.focus()
    fireEvent.keyDown(field, { key: 'ArrowRight' })
    expect(useImageGalleryStore.getState().selectedId).toBe('job-1-00')
  })

  it('opens a full-screen preview on click', async () => {
    render(<Gallery />)
    await screen.findByTestId('image-viewer')
    await act(async () => {
      await userEvent.click(screen.getAllByLabelText('images:viewer.fullscreen')[0])
    })
    expect(screen.getByTestId('image-fullscreen')).toBeInTheDocument()
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-fullscreen'))
    })
    expect(screen.queryByTestId('image-fullscreen')).not.toBeInTheDocument()
  })
})
