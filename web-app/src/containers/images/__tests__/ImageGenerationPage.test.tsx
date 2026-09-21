import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeFakeDiffusion,
  makeItem,
  makeJob,
  makeStatus,
  Q4_ID,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number>) =>
      key === 'images:progress.elapsed' ? `${values?.seconds} s` : key,
  }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))

// The page decides which blocks to show; the blocks have their own tests.
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('../ImagePromptForm', () => ({
  ImagePromptForm: ({ modelsOpen }: { modelsOpen?: boolean }) => (
    <div data-testid="image-prompt-form" data-models-open={String(modelsOpen)} />
  ),
}))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) =>
    `asset://localhost/${encodeURIComponent(path)}`,
}))
vi.mock('../ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { IMAGE_WORKFLOW_IDS } from '@/lib/diffusion/workflows'
import { useImageGalleryStore } from '@/stores/image-gallery-store'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageGenerationPage } from '../ImageGenerationPage'

const completeArtifact = {
  id: Q4_ID,
  family: 'z-image' as const,
  quantId: 'q4_k_m',
  bytes: 1,
  complete: true,
  missing: [],
}

describe('ImageGenerationPage', () => {
  let fake: FakeDiffusion

  beforeEach(async () => {
    localStorage.clear()
    await useImageForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    useImageForm.setState({ ...DEFAULT_IMAGE_FORM })
    // Keep the first-visit wizard out of these tests.
    useImageSetting.setState({ setupCompleted: true, selectedArtifactId: null })
    useImageGenerationStore.getState().reset()
    useImageGalleryStore.getState().reset()
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
  })

  it('routes the engine compatibility banner to the existing update-and-retry flow', async () => {
    const update = vi.spyOn(useImageGenerationStore.getState(), 'updateEngine').mockResolvedValue()
    useImageGenerationStore.setState({
      status: makeStatus(),
      lastError: { code: 'ENGINE_UPDATE_REQUIRED', message: 'Update required' },
    })
    render(<ImageGenerationPage workflow="create" search={{}} />)
    await userEvent.click(screen.getByRole('button', { name: 'images:errors.actions.updateEngine' }))
    expect(update).toHaveBeenCalledTimes(1)
    update.mockRestore()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const renderPage = async (workflow: ImageWorkflowId = 'create') => {
    render(<ImageGenerationPage workflow={workflow} search={{}} />)
    await waitFor(() =>
      expect(useImageGalleryStore.getState().initialized).toBe(true)
    )
  }

  it('hands the route workflow to the form and asks for a model on the empty canvas', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
    })
    await renderPage('upscale')

    expect(useImageForm.getState().workflow).toBe('upscale')
    expect(screen.getByTestId('image-empty-state')).toHaveTextContent(
      'images:gallery.emptyNoModel'
    )
  })

  it('opens the studio as soon as the engine is in, and gets the model from its picker', async () => {
    useImageGenerationStore.setState({ status: makeStatus() })
    await renderPage()

    expect(screen.queryByTestId('image-onboarding')).not.toBeInTheDocument()
    expect(screen.queryByTestId('image-setup-card')).not.toBeInTheDocument()
    const form = screen.getByTestId('image-prompt-form')
    expect(form).toHaveAttribute('data-models-open', 'false')

    await userEvent.click(screen.getByTestId('image-empty-download'))
    expect(form).toHaveAttribute('data-models-open', 'true')
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })

  it('stops offering a download on the empty canvas once a model is on disk', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
    })
    await renderPage()

    expect(screen.getByTestId('image-empty-state')).toBeInTheDocument()
    expect(screen.queryByTestId('image-empty-download')).not.toBeInTheDocument()
  })

  it('keeps the setup card while the engine is missing, even with a model on disk', async () => {
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
      installedArtifacts: [completeArtifact],
    })
    await renderPage()

    expect(screen.getByTestId('image-onboarding')).toBeInTheDocument()
    expect(screen.queryByTestId('image-prompt-form')).not.toBeInTheDocument()
  })

  it('shows one centered setup card when nothing is installed', async () => {
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
    })
    await renderPage()

    const onboarding = screen.getByTestId('image-onboarding')
    expect(
      within(onboarding).getByTestId('image-setup-card')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('image-empty-state')).not.toBeInTheDocument()
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument()
  })

  it('never opens setup automatically on a first visit', async () => {
    useImageSetting.setState({ setupCompleted: false })
    useImageGenerationStore.setState({
      setupOpen: false,
      status: makeStatus({ install: { state: 'not-installed' } }),
    })

    await renderPage()

    expect(screen.getByTestId('image-setup-card')).toBeInTheDocument()
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })

  it('keeps existing images in view next to the setup card', async () => {
    fake.gallery = [makeItem()]
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
    })
    await renderPage()

    expect(screen.queryByTestId('image-onboarding')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-setup-card')).toBeInTheDocument()
    expect(screen.getByTestId('image-gallery-grid')).toBeInTheDocument()
  })

  it('puts an error above the picture, never over it', async () => {
    fake.gallery = [makeItem()]
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
      lastError: {
        code: 'INTERNAL',
        message: 'sd-server returned 500',
        details: 'generation_failed: generate_image returned no results',
      },
    })
    await renderPage()

    // The banner's tint is translucent: floated over the viewer, its text sat
    // on the photo and could not be read.
    const banner = screen.getByTestId('image-error-banner')
    const viewer = screen.getByTestId('image-viewer')
    expect(banner.parentElement).not.toHaveClass('absolute')
    expect(
      banner.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('offers a smaller scale, not 768², when an upscale runs out of memory', async () => {
    fake.gallery = [makeItem()]
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
      lastError: { code: 'OUT_OF_MEMORY', message: 'out of memory' },
    })
    useImageForm.setState({ upscaleFactor: 2, width: 1024, height: 1024 })
    await renderPage('upscale')

    // Upscale sizes the output from the source, so the form's width and
    // height are not in the request: 768² would change nothing.
    await userEvent.click(
      screen.getByRole('button', { name: 'images:errors.actions.reduceUpscale' })
    )
    expect(useImageForm.getState().upscaleFactor).toBe(1.5)
    expect(useImageForm.getState().width).toBe(1024)
    expect(useImageGenerationStore.getState().lastError).toBeNull()

    // Everywhere else the same error still offers the smaller size.
    useImageGenerationStore.setState({
      lastError: { code: 'OUT_OF_MEMORY', message: 'out of memory' },
    })
    cleanup()
    await renderPage('create')
    await userEvent.click(
      screen.getByRole('button', { name: 'images:errors.actions.reduceSize' })
    )
    expect(useImageForm.getState().width).toBe(768)
    expect(useImageForm.getState().upscaleFactor).toBe(1.5)
  })

  it('shows the form beside the empty canvas once the engine and a model are in place', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
    })
    await renderPage()

    expect(screen.queryByTestId('image-onboarding')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-prompt-form')).toBeInTheDocument()
    expect(screen.getByTestId('image-empty-state')).toBeInTheDocument()
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument()
  })

  it('reserves animated canvas and gallery slots while generation is running', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
      generating: true,
      generationStartedAtMs: 1_000,
      currentJob: makeJob({ state: 'generating' }),
    })
    await renderPage()

    expect(screen.getByTestId('image-generation-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('image-empty-state')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-gallery-grid')).toBeInTheDocument()
  })

  it.each(IMAGE_WORKFLOW_IDS)(
    'uses the shared live placeholder for the %s workflow',
    async (workflow) => {
      useImageGenerationStore.setState({
        status: makeStatus(),
        installedArtifacts: [completeArtifact],
        generating: true,
        generationStartedAtMs: Date.now(),
        currentJob: makeJob({
          state: 'generating',
          request: {
            ...makeJob().request,
            workflow,
          },
        }),
      })

      await renderPage(workflow)

      expect(screen.getByTestId('image-generation-preview')).toBeInTheDocument()
      expect(useImageForm.getState().workflow).toBe(workflow)
    }
  )

  it('ticks through Transform encoding before the first sampling step', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    useImageGalleryStore.setState({ initialized: true })
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
      generating: true,
      generationStartedAtMs: 100_000,
      currentJob: makeJob({
        state: 'generating',
        progress: {
          phase: 'encoding',
          step: 0,
          totalSteps: 0,
          fraction: 0,
          etaSeconds: null,
          batchIndex: 0,
          batchSize: 1,
          elapsedMs: 0,
        },
      }),
    })

    render(<ImageGenerationPage workflow="transform" search={{}} />)
    act(() => vi.advanceTimersByTime(6_100))

    const preview = screen.getByTestId('image-generation-preview')
    expect(preview).toHaveTextContent('images:progress.phase.encoding')
    expect(preview).toHaveTextContent('6 s')

    act(() => {
      useImageGenerationStore.getState().handleEvent({
        type: 'progress',
        jobId: 'job-1',
        progress: {
          phase: 'sampling',
          step: 1,
          totalSteps: 8,
          fraction: 0.125,
          etaSeconds: null,
          batchIndex: 0,
          batchSize: 1,
          elapsedMs: 1_000,
        },
      })
    })
    expect(preview).toHaveTextContent('images:progress.step')
    expect(preview).toHaveTextContent('6 s')
  })

  it('cleans up the Edit clock when gallery selection changes and generation is cancelled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    useImageGalleryStore.setState({
      initialized: true,
      items: [makeItem({ id: 'ready-00' })],
      total: 1,
    })
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
      generating: true,
      generationStartedAtMs: 200_000,
      currentJob: makeJob({ state: 'generating', progress: null }),
    })

    render(<ImageGenerationPage workflow="edit" search={{}} />)
    const timersWithLivePreview = vi.getTimerCount()
    expect(timersWithLivePreview).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('gallery-tile-ready-00'))
    expect(
      screen.queryByTestId('image-generation-preview')
    ).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(timersWithLivePreview - 1)

    fireEvent.click(screen.getByTestId('gallery-pending-0'))
    expect(screen.getByTestId('image-generation-preview')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(timersWithLivePreview)

    act(() => {
      useImageGenerationStore.setState({
        generating: false,
        currentJob: null,
        generationStartedAtMs: null,
      })
    })
    expect(
      screen.queryByTestId('image-generation-preview')
    ).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(timersWithLivePreview - 1)
  })

  const renderRunningPage = async () => {
    fake.gallery = [makeItem({ id: 'ready-00' })]
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeArtifact],
      generating: true,
      generationStartedAtMs: 1_000,
      currentJob: makeJob({ state: 'generating' }),
    })
    await renderPage()
  }

  it('lets a ready thumbnail open the full viewer while generation continues', async () => {
    await renderRunningPage()
    fireEvent.click(screen.getByTestId('gallery-tile-ready-00'))

    const viewer = screen.getByTestId('image-viewer')
    expect(viewer.querySelector('img')).toHaveAttribute(
      'src',
      'asset://localhost/%2Fdata%2Fimages%2Fready-00.png'
    )
    expect(within(viewer).getByTestId('image-recipe-trigger')).toBeEnabled()
    for (const action of ['saveAs', 'useAsSource', 'reveal']) {
      expect(
        within(viewer).getByRole('button', { name: `images:viewer.${action}` })
      ).toBeEnabled()
    }
    expect(within(viewer).getByTestId('image-viewer-delete')).toBeEnabled()
    expect(
      screen.queryByTestId('image-generation-preview')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('image-generation-tile-0')).toBeInTheDocument()
    expect(useImageGenerationStore.getState().generating).toBe(true)
    expect(fake.cancelJob).not.toHaveBeenCalled()
  })

  it('returns to live progress when a pending thumbnail is selected by keyboard', async () => {
    await renderRunningPage()
    fireEvent.click(screen.getByTestId('gallery-tile-ready-00'))
    const pending = screen.getByTestId('gallery-pending-0')
    expect(pending).toHaveAttribute('aria-pressed', 'false')
    pending.focus()
    await userEvent.keyboard('{Enter}')

    expect(pending).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('image-generation-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument()
    expect(screen.getByTestId('gallery-tile-ready-00')).not.toHaveAttribute(
      'data-current'
    )
    expect(useImageGenerationStore.getState().generating).toBe(true)
  })

  it('preserves a deliberate ready selection when a job completes', async () => {
    await renderRunningPage()
    fireEvent.click(screen.getByTestId('gallery-tile-ready-00'))
    act(() => {
      useImageGalleryStore.getState().prepend([makeItem({ id: 'new-00' })])
      useImageGenerationStore.setState({ generating: false, currentJob: null })
    })

    expect(
      screen.getByTestId('image-viewer').querySelector('img')
    ).toHaveAttribute(
      'src',
      'asset://localhost/%2Fdata%2Fimages%2Fready-00.png'
    )
    expect(screen.getByTestId('gallery-tile-new-00')).toBeInTheDocument()
    expect(screen.queryByTestId('gallery-pending-0')).not.toBeInTheDocument()
    expect(useImageGalleryStore.getState().selectedId).toBe('ready-00')
  })

  it('shows the new result on completion after returning to the pending preview', async () => {
    await renderRunningPage()
    fireEvent.click(screen.getByTestId('gallery-tile-ready-00'))
    fireEvent.click(screen.getByTestId('gallery-pending-0'))
    act(() => {
      useImageGalleryStore.getState().prepend([makeItem({ id: 'new-00' })])
      useImageGenerationStore.setState({ generating: false, currentJob: null })
    })

    expect(
      screen.getByTestId('image-viewer').querySelector('img')
    ).toHaveAttribute('src', 'asset://localhost/%2Fdata%2Fimages%2Fnew-00.png')
    expect(
      screen.queryByTestId('image-generation-preview')
    ).not.toBeInTheDocument()
  })

  it('keeps finalization live while ready-image selection remains independent', async () => {
    await renderRunningPage()
    const baseProgress = {
      phase: 'sampling' as const,
      step: 20,
      totalSteps: 20,
      fraction: 0.97,
      etaSeconds: null,
      batchIndex: 0,
      batchSize: 1,
      elapsedMs: 12_000,
    }

    act(() => {
      useImageGenerationStore.getState().handleEvent({
        type: 'progress',
        jobId: 'job-1',
        progress: baseProgress,
      })
    })
    expect(screen.getByTestId('image-generation-preview')).toHaveTextContent(
      'images:progress.finalizingImage'
    )
    expect(
      screen.getByTestId('image-generation-preview')
    ).not.toHaveTextContent('images:progress.step')

    fireEvent.click(screen.getByTestId('gallery-tile-ready-00'))
    act(() => {
      for (const phase of ['decoding', 'postprocessing', 'saving'] as const) {
        useImageGenerationStore.getState().handleEvent({
          type: 'progress',
          jobId: 'job-1',
          progress: { ...baseProgress, phase },
        })
      }
    })
    expect(
      screen.getByTestId('image-viewer').querySelector('img')
    ).toHaveAttribute(
      'src',
      'asset://localhost/%2Fdata%2Fimages%2Fready-00.png'
    )

    fireEvent.click(screen.getByTestId('gallery-pending-0'))
    expect(screen.getByTestId('image-generation-preview')).toHaveTextContent(
      'images:progress.phase.saving'
    )

    act(() => {
      useImageGalleryStore.getState().prepend([makeItem({ id: 'new-00' })])
      useImageGenerationStore.setState({ generating: false, currentJob: null })
    })
    expect(
      screen.getByTestId('image-viewer').querySelector('img')
    ).toHaveAttribute('src', 'asset://localhost/%2Fdata%2Fimages%2Fnew-00.png')
  })
})
