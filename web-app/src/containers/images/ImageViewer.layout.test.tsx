import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { expectNoHorizontalOverflow, settle, setFontSize, setTheme, withTranslations } from '@/test/layout'
import { ImageGenerationPage } from './ImageGenerationPage'
import { ImageViewer } from './ImageViewer'

const route = vi.hoisted(() => ({
  navigate: vi.fn(),
  setWorkflow: null as ((workflow: ImageWorkflowId) => void) | null,
}))

const squarePng =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#67809f"/></svg>'
  )

const squareItem = {
  id: 'square-00',
  path: squarePng,
  thumbnailPath: squarePng,
  width: 1024,
  height: 1024,
  sizeBytes: 1,
  createdAtMs: 1,
  pinned: false,
  archived: false,
  recipe: {
    jobId: 'square',
    index: 0,
    prompt: 'square regression image',
    negativePrompt: null,
    width: 1024,
    height: 1024,
    steps: 8,
    cfgScale: 1,
    guidance: null,
    seed: 1,
    batchSeed: 1,
    batchSize: 1,
    samplingMethod: 'euler',
    flowShift: null,
    workflow: 'create' as const,
    strength: null,
    model: {
      modelId: 'z-image:q4_k_m',
      family: 'z-image' as const,
      displayName: 'Z-Image Turbo',
      filename: 'z-image.gguf',
    },
    engine: {
      kind: 'sd-cpp' as const,
      backend: 'metal',
      tag: 'test',
      offload: 'none' as const,
      cpuFallback: false,
    },
    createdAtMs: 1,
    durationMs: 1,
  },
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => route.navigate,
}))
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
vi.mock('@/hooks/useImageGallery', () => ({
  useImageGallery: () => ({
    items: [squareItem],
    hasMore: false,
    total: 1,
    loading: false,
    initialized: true,
    selected: squareItem,
    selectedId: squareItem.id,
    selectedIds: [squareItem.id],
    loadMore: vi.fn(),
    reload: vi.fn(),
    select: vi.fn(),
    toggleSelect: vi.fn(),
    step: vi.fn(),
    remove: vi.fn(),
  }),
}))
vi.mock('@/hooks/useServiceHub', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/hooks/useServiceHub')
  >()
  const serviceHub = {
    dialog: () => ({ save: vi.fn() }),
    diffusion: () => ({}),
    opener: () => ({ revealItemInDir: vi.fn() }),
  }
  return {
    ...original,
    useServiceHub: () => serviceHub,
    getServiceHub: () => serviceHub,
  }
})
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <header className="flex h-15 shrink-0 items-center">{children}</header>
  ),
}))
vi.mock('./ImagePromptForm', () => ({
  ImagePromptForm: () => <div data-testid="image-prompt-form" />,
}))
vi.mock('./ImageGalleryGrid', () => ({
  ImageGalleryGrid: () => <div className="h-40" data-testid="image-gallery-grid" />,
}))

const completeArtifact = {
  id: 'z-image:q4_k_m',
  family: 'z-image' as const,
  quantId: 'q4_k_m',
  bytes: 1,
  complete: true,
  missing: [],
}

function RoutedImagePage() {
  const [workflow, setWorkflow] = useState<ImageWorkflowId>('create')

  useEffect(() => {
    route.setWorkflow = setWorkflow
    return () => {
      route.setWorkflow = null
    }
  }, [])

  return (
    <>
      <span hidden data-testid="active-image-workflow">
        {workflow}
      </span>
      <ImageGenerationPage workflow={workflow} search={{}} />
    </>
  )
}

describe('image viewer page geometry', () => {
  beforeEach(async () => {
    await page.viewport(1280, 800)
    route.navigate.mockReset()
    route.navigate.mockImplementation(({ to }: { to: string }) => {
      if (to === '/images/transform') route.setWorkflow?.('transform')
    })
    localStorage.clear()
    await useImageForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    useImageForm.setState({ ...DEFAULT_IMAGE_FORM })
    useImageSetting.setState({ selectedArtifactId: completeArtifact.id })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      installedArtifacts: [completeArtifact],
    })
  })

  it.each([
    { width: 1536, height: 512, viewport: 1280, font: '16px', theme: 'light' as const },
    { width: 512, height: 1536, viewport: 1024, font: '20px', theme: 'dark' as const },
  ])('clips the contained $width × $height bitmap at $viewport px with a sidebar', async ({ width, height, viewport, font, theme }) => {
    await page.viewport(viewport, 800)
    setFontSize(font)
    setTheme(theme)
    const path = 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#67809f"/></svg>`
    )
    const view = render(withTranslations(
      <div style={{ marginLeft: 256, width: viewport - 256, height: 600 }}>
        <ImageViewer item={{ ...squareItem, width, height, path }} selectedIds={[]} onOfferLoad={vi.fn()} />
      </div>
    ))
    const image = screen.getByAltText<HTMLImageElement>('square regression image')
    const frame = screen.getByTestId('image-viewer-frame')
    await image.decode()
    await settle(view.container)
    const region = screen.getByTestId('image-viewer-region').getBoundingClientRect()
    const box = image.getBoundingClientRect()
    const badge = screen.getByTestId('image-dimension-badge').getBoundingClientRect()
    const scale = Math.min(region.width / width, region.height / height)
    expect(box.width).toBeCloseTo(width * scale, 1)
    expect(box.height).toBeCloseTo(height * scale, 1)
    expect(box.top).toBeCloseTo(region.top, 1)
    expect(box.left + box.width / 2).toBeCloseTo(region.left + region.width / 2, 1)
    expect(badge.top).toBeCloseTo(box.top + 8, 1)
    expect(badge.right).toBeCloseTo(box.right - 8, 1)
    expect(parseFloat(getComputedStyle(frame).borderRadius)).toBeGreaterThan(0)
    expect(getComputedStyle(frame).overflow).toBe('hidden')
    expectNoHorizontalOverflow(view.container)
    fireEvent.click(image)
    const fullscreen = screen.getByTestId('image-fullscreen').querySelector('img')!
    await fullscreen.decode()
    const fullscreenBox = fullscreen.getBoundingClientRect()
    expect(fullscreenBox.width / fullscreenBox.height).toBeCloseTo(width / height, 2)
    expect(fullscreenBox.width).toBeLessThanOrEqual(viewport * 0.9 + 1)
    expect(fullscreenBox.height).toBeLessThanOrEqual(800 * 0.9 + 1)
  })

  it('keeps a 1024 square large, top-contained, and stable after Use as source', async () => {
    render(withTranslations(<RoutedImagePage />))
    await waitFor(() => expect(useImageForm.getState().workflow).toBe('create'))

    const root = screen.getByTestId('image-generation-page')
    const section = screen.getByTestId('image-viewer-section')
    const region = screen.getByTestId('image-viewer-region')
    const image = screen.getByAltText('square regression image')
    const frame = screen.getByTestId('image-viewer-frame')
    await image.decode()
    await settle(root)

    const initialRegion = region.getBoundingClientRect()
    const initialImage = image.getBoundingClientRect()
    const containedSquareSize = Math.min(initialImage.width, initialImage.height)

    expect(containedSquareSize).toBeGreaterThan(320)
    expect(initialImage.width).toBeLessThanOrEqual(initialRegion.width + 1)
    expect(initialImage.height).toBeLessThanOrEqual(initialRegion.height + 1)
    expect(initialImage.top).toBeCloseTo(initialRegion.top, 1)
    expect(getComputedStyle(image).objectFit).toBe('contain')
    expect(getComputedStyle(image).objectPosition).toMatch(/0(%|px)/)
    // The rounded element must follow the bitmap, including its letterboxed
    // edges; rounding the full viewer region leaves the bitmap square.
    expect(initialImage.width).toBeCloseTo(containedSquareSize, 1)
    expect(initialImage.height).toBeCloseTo(containedSquareSize, 1)
    expect(parseFloat(getComputedStyle(frame).borderTopLeftRadius)).toBeGreaterThan(0)
    expect(getComputedStyle(frame).overflow).toBe('hidden')
    expect(section.scrollHeight).toBeLessThanOrEqual(section.clientHeight + 1)
    expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1)

    await act(async () => {
      fireEvent.click(screen.getByTestId('image-viewer-use-as-source'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('active-image-workflow')).toHaveTextContent(
        'transform'
      )
    )
    await waitFor(() => expect(useImageForm.getState().workflow).toBe('transform'))
    await settle(root)

    expect(useImageForm.getState().sourceImage).toEqual({
      path: squarePng,
      width: 1024,
      height: 1024,
    })
    expect(route.navigate).toHaveBeenCalledWith({ to: '/images/transform' })

    const nextRegion = region.getBoundingClientRect()
    const nextImage = image.getBoundingClientRect()
    expect(nextRegion.width).toBeCloseTo(initialRegion.width, 1)
    expect(nextRegion.height).toBeCloseTo(initialRegion.height, 1)
    expect(nextImage.width).toBeCloseTo(initialImage.width, 1)
    expect(nextImage.height).toBeCloseTo(initialImage.height, 1)
    expect(nextImage.top).toBeCloseTo(nextRegion.top, 1)
    expect(section.scrollHeight).toBeLessThanOrEqual(section.clientHeight + 1)
    expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1)
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(800)
  })

  it('clips the first frame and a cached image switch with a stable rounded wrapper', async () => {
    const secondPath =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#9f8067"/></svg>'
      )
    const cached = new Image()
    cached.src = secondPath
    await cached.decode()

    const view = render(
      withTranslations(
        <div style={{ width: 900, height: 600 }}>
          <ImageViewer
            item={squareItem}
            selectedIds={[]}
            onOfferLoad={vi.fn()}
          />
        </div>
      )
    )

    const frame = screen.getByTestId('image-viewer-frame')
    const initialImage = screen.getByAltText<HTMLImageElement>(
      'square regression image'
    )
    const beforeDecode = getComputedStyle(frame)
    expect(parseFloat(beforeDecode.borderTopLeftRadius)).toBeGreaterThan(0)
    expect(beforeDecode.overflow).toBe('hidden')
    expect(beforeDecode.animationName).toBe('none')
    expect(beforeDecode.transform).toBe('none')

    await initialImage.decode()
    await settle(view.container)
    const loadedBox = frame.getBoundingClientRect()
    expect(screen.getByTestId('image-viewer-frame')).toBe(frame)
    expect(getComputedStyle(frame).overflow).toBe('hidden')

    view.rerender(
      withTranslations(
        <div style={{ width: 900, height: 600 }}>
          <ImageViewer
            item={{
              ...squareItem,
              id: 'cached-square-00',
              path: secondPath,
              thumbnailPath: secondPath,
              recipe: {
                ...squareItem.recipe,
                jobId: 'cached-square',
                prompt: 'cached square regression image',
              },
            }}
            selectedIds={[]}
            onOfferLoad={vi.fn()}
          />
        </div>
      )
    )

    const switchedFrame = screen.getByTestId('image-viewer-frame')
    const switchedImage = screen.getByAltText<HTMLImageElement>(
      'cached square regression image'
    )
    expect(switchedFrame).toBe(frame)
    expect(switchedImage.complete).toBe(true)
    expect(parseFloat(getComputedStyle(switchedFrame).borderTopLeftRadius)).toBeGreaterThan(0)
    expect(getComputedStyle(switchedFrame).overflow).toBe('hidden')
    expect(getComputedStyle(switchedFrame).animationName).toBe('none')
    expect(getComputedStyle(switchedFrame).transform).toBe('none')
    expect(switchedFrame.getBoundingClientRect().width).toBeCloseTo(
      loadedBox.width,
      1
    )
    expect(switchedFrame.getBoundingClientRect().height).toBeCloseTo(
      loadedBox.height,
      1
    )

    const transition = screen.getByTestId('image-viewer-transition')
    expect(transition).not.toHaveClass('zoom-in-95')
    expect(getComputedStyle(transition).borderTopLeftRadius).toBe('0px')
  })
})
