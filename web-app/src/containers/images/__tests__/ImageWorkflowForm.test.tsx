import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCapabilities,
  makeFakeDiffusion,
  makeLoadedStatus,
  Q4_ID,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && 'width' in params ? `${key}:${params.width}x${params.height}` : key,
  }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: vi.fn(),
}))
// The picked file never leaves the store in these tests: the read is a
// 1×1 PNG so the dropzone and the mask editor get a picture to show.
const PNG_1x1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)
vi.mock('@/lib/readFileBytes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/readFileBytes')>()),
  readFileBytes: vi.fn(async () => ({ bytes: PNG_1x1, size: PNG_1x1.length })),
}))
// Extend's canvases are pixel work jsdom cannot do; the geometry has its own tests.
vi.mock('../canvas', () => ({
  loadImage: vi.fn(async () => ({ naturalWidth: 1024, naturalHeight: 768 })),
  drawOutpaint: vi.fn(() => ({
    initBase64: 'data:image/png;base64,SU5JVA==',
    maskBase64: 'data:image/png;base64,TUFTSw==',
  })),
}))

// The jsdom bridge stub has no asset protocol; this is what the WebView does.
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}))

import { DEFAULT_IMAGE_FORM, DEFAULT_WORKFLOW_KNOBS, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { makeItem } from '@/lib/diffusion/__tests__/image-fixtures'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { useImageGalleryStore } from '@/stores/image-gallery-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImagePromptForm } from '../ImagePromptForm'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const ALL_WORKFLOWS: ImageWorkflowId[] = [
  'create',
  'transform',
  'inpaint',
  'extend',
  'upscale',
  'reference',
  'edit',
]
const SOURCE = { path: '/pics/in.png', width: 1024, height: 768 }

describe('ImagePromptForm per workflow', () => {
  let fake: FakeDiffusion

  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    URL.createObjectURL = vi.fn(() => 'blob:source')
    URL.revokeObjectURL = vi.fn()
  })

  beforeEach(async () => {
    localStorage.clear()
    await useImageForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    useImageForm.setState({
      ...DEFAULT_IMAGE_FORM,
      ...DEFAULT_WORKFLOW_KNOBS,
      prompt: 'a lighthouse',
      sourceImage: null,
      maskBase64: null,
      referenceImages: [],
    })
    useImageSetting.setState({ selectedArtifactId: Q4_ID, advancedOpen: false })
    useImageGenerationStore.getState().reset()
    useImageGalleryStore.getState().reset()
    useImageGenerationStore.setState({
      status: makeLoadedStatus(Q4_ID),
      capabilities: makeCapabilities({ workflows: ALL_WORKFLOWS }),
    })
    fake = makeFakeDiffusion()
    fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
    seedServiceHub({ diffusion: fake })
    fake.subscribe(useImageGenerationStore.getState().handleEvent)
  })

  const generate = async () => {
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-generate'))
    })
    await waitFor(() => expect(fake.generate).toHaveBeenCalled())
    return fake.generate.mock.calls[0][0]
  }

  it('titles the column after the workflow and asks for a source before generating', () => {
    useImageForm.setState({ workflow: 'transform' })
    render(<ImagePromptForm />)
    expect(screen.getByTestId('image-workflow-title')).toHaveTextContent(
      'images:workflow.transform.title'
    )
    expect(screen.getByText('images:workflow.transform.hint')).toBeInTheDocument()
    expect(screen.getByTestId('image-source-dropzone')).toBeInTheDocument()
    expect(screen.getByTestId('image-generate')).toBeDisabled()
  })

  it('transforms the source fitted into the form resolution at the chosen strength', async () => {
    useImageForm.setState({ workflow: 'transform', sourceImage: SOURCE, strength: 0.45, width: 1024, height: 1024 })
    render(<ImagePromptForm />)
    expect(screen.getByText('images:form.strength')).toBeInTheDocument()

    const request = await generate()
    expect(request).toMatchObject({
      workflow: 'transform',
      initImage: { path: SOURCE.path },
      strength: 0.45,
      width: 1024,
      height: 768,
    })
    expect(request).not.toHaveProperty('maskImage')
  })

  it('inpaints only once a mask is painted, and sends it inline', async () => {
    useImageForm.setState({ workflow: 'inpaint', sourceImage: SOURCE })
    render(<ImagePromptForm />)
    expect(screen.queryByTestId('image-source-dropzone')).not.toBeInTheDocument()
    expect(screen.getByText('images:form.brushSize')).toBeInTheDocument()
    expect(screen.getByText('images:form.clearMask')).toBeInTheDocument()
    expect(screen.queryByText('images:size.title')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-generate')).toBeDisabled()

    act(() => useImageForm.setState({ maskBase64: 'data:image/png;base64,TUFTSw==' }))
    const request = await generate()
    expect(request).toMatchObject({
      workflow: 'inpaint',
      initImage: { path: SOURCE.path },
      maskImage: { base64: 'data:image/png;base64,TUFTSw==' },
      strength: 0.6,
      width: 1024,
      height: 768,
    })
  })

  it('extends by building the grown canvas and its mask at generate time', async () => {
    useImageForm.setState({ workflow: 'extend', sourceImage: SOURCE, expandPercent: 25 })
    render(<ImagePromptForm />)
    expect(screen.getByText('images:form.expandBy')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'images:form.sides' })).toBeInTheDocument()
    expect(screen.getByText('images:form.outputSize:1536x1152')).toBeInTheDocument()

    const request = await generate()
    expect(request).toMatchObject({
      workflow: 'extend',
      initImage: { base64: 'data:image/png;base64,SU5JVA==' },
      maskImage: { base64: 'data:image/png;base64,TUFTSw==' },
      strength: 1,
      width: 1536,
      height: 1152,
    })
  })

  it('refuses to extend with no side chosen', () => {
    useImageForm.setState({
      workflow: 'extend',
      sourceImage: SOURCE,
      sides: { top: false, bottom: false, left: false, right: false },
    })
    render(<ImagePromptForm />)
    expect(screen.getByTestId('image-generate')).toBeDisabled()
  })

  it('upscales by asking for the source times the factor, capped by the model', async () => {
    useImageForm.setState({ workflow: 'upscale', sourceImage: SOURCE, upscaleFactor: 4, upscaleStrength: 0.3 })
    render(<ImagePromptForm />)
    expect(screen.getByText('images:form.scale')).toBeInTheDocument()
    expect(screen.getByText('images:form.detailStrength')).toBeInTheDocument()
    // 1024×4 is over the 2048 ceiling: the factor is capped at 2.
    expect(screen.getByTestId('image-upscale-output')).toHaveTextContent('2048x1536')

    const request = await generate()
    expect(request).toMatchObject({
      workflow: 'upscale',
      initImage: { path: SOURCE.path },
      strength: 0.3,
      width: 2048,
      height: 1536,
    })
  })

  it('sends the source plus the extra references for a reference job', async () => {
    useImageForm.setState({
      workflow: 'reference',
      sourceImage: SOURCE,
      referenceImages: ['/pics/ref2.png'],
      width: 1024,
      height: 1024,
    })
    render(<ImagePromptForm />)
    expect(screen.getByTestId('image-reference-list')).toBeInTheDocument()
    expect(screen.getByTestId('image-add-reference')).toBeEnabled()

    const request = await generate()
    expect(request).toMatchObject({
      workflow: 'reference',
      initImage: { path: SOURCE.path },
      referenceImages: [{ path: '/pics/ref2.png' }],
      width: 1024,
      height: 1024,
    })
    expect(request).not.toHaveProperty('strength')
  })

  it('labels the prompt as an instruction and keeps the source size for an edit', async () => {
    useImageForm.setState({ workflow: 'edit', sourceImage: SOURCE })
    render(<ImagePromptForm />)
    expect(screen.getByLabelText('images:form.instruction')).toBeInTheDocument()
    expect(screen.queryByText('images:size.title')).not.toBeInTheDocument()

    const request = await generate()
    expect(request).toMatchObject({
      workflow: 'edit',
      initImage: { path: SOURCE.path },
      width: 1024,
      height: 768,
    })
    expect(request).not.toHaveProperty('referenceImages')
  })

  it('takes the source image from the gallery', async () => {
    const generated = makeItem({ id: 'job-9-00', width: 768, height: 1024 })
    useImageGalleryStore.setState({ items: [generated], initialized: true, total: 1 })
    useImageForm.setState({ workflow: 'transform' })
    render(<ImagePromptForm />)

    await act(async () => {
      await userEvent.click(screen.getByTestId('image-source-dropzone-gallery'))
    })
    expect(screen.getByTestId('image-gallery-picker')).toBeInTheDocument()
    await act(async () => {
      await userEvent.click(screen.getByTestId('gallery-tile-job-9-00'))
    })

    expect(useImageForm.getState().sourceImage).toEqual({
      path: generated.path,
      width: 768,
      height: 1024,
    })
    await waitFor(() =>
      expect(screen.queryByTestId('image-gallery-picker')).not.toBeInTheDocument()
    )
  })

  it('adds an extra reference from the gallery', async () => {
    const generated = makeItem({ id: 'job-9-00' })
    useImageGalleryStore.setState({ items: [generated], initialized: true, total: 1 })
    useImageForm.setState({ workflow: 'reference', sourceImage: SOURCE })
    render(<ImagePromptForm />)

    await act(async () => {
      await userEvent.click(screen.getByTestId('image-add-reference-gallery'))
    })
    await act(async () => {
      await userEvent.click(screen.getByTestId('gallery-tile-job-9-00'))
    })
    expect(useImageForm.getState().referenceImages).toEqual([generated.path])
  })

  it('keeps Generate off for a workflow the loaded model lacks', () => {
    useImageGenerationStore.setState({
      capabilities: makeCapabilities({ workflows: ['create', 'transform'] }),
    })
    useImageForm.setState({ workflow: 'edit', sourceImage: SOURCE })
    render(<ImagePromptForm />)
    expect(screen.getByTestId('image-generate')).toBeDisabled()
    expect(useImageForm.getState().workflow).toBe('edit')
  })
})
