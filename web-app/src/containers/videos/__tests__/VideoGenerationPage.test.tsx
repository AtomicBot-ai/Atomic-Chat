import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeStatus,
  Q4_ID,
  Z_IMAGE,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_2,
  LTX_Q4_ID,
  makeVideoCapabilities,
  makeVideoItem,
  makeVideoJob,
  makeVideoLoadedStatus,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number | string>) =>
      key === 'videos:progress.elapsed'
        ? `${values?.seconds} s`
        : key === 'videos:errors.OUT_OF_MEMORY.body'
          ? `${values?.frames} frames at ${values?.size} (${values?.seconds} s)`
          : key === 'videos:progress.remaining'
            ? `осталось ${values?.duration}`
            : key === 'videos:estimate.units.min'
              ? 'мин'
              : key,
  }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../VideoPromptForm', () => ({
  VideoPromptForm: ({ modelsOpen }: { modelsOpen?: boolean }) => (
    <div data-testid="video-prompt-form" data-models-open={String(modelsOpen)} />
  ),
}))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}))
vi.mock('@/containers/images/ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoGenerationPage } from '../VideoGenerationPage'

const completeImage = {
  id: Q4_ID,
  family: 'z-image' as const,
  quantId: 'q4_k_m',
  bytes: 1,
  complete: true,
  missing: [],
}
const completeVideo = {
  id: LTX_Q4_ID,
  family: 'ltx-2' as const,
  quantId: 'q4_k_m',
  bytes: 1,
  complete: true,
  missing: [],
}

describe('VideoGenerationPage', () => {
  let fake: FakeDiffusion

  beforeEach(async () => {
    localStorage.clear()
    await useVideoForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    await useVideoSetting.persist.rehydrate()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM })
    useImageSetting.setState({ setupCompleted: true })
    useVideoSetting.setState({ selectedArtifactId: null })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({ catalog: makeCatalog([Z_IMAGE, LTX_2]) })
    useVideoGenerationStore.getState().reset()
    useVideoGalleryStore.getState().reset()
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const renderPage = async (search: { model?: string; quant?: string } = {}) => {
    render(<VideoGenerationPage search={search} />)
    await waitFor(() =>
      expect(useVideoGalleryStore.getState().initialized).toBe(true)
    )
  }

  it('shows one centered video setup card when nothing is installed', async () => {
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
    })
    await renderPage()
    const onboarding = screen.getByTestId('video-onboarding')
    const card = within(onboarding).getByTestId('image-setup-card')
    expect(card).toHaveAttribute('data-modality', 'video')
    expect(card).toHaveTextContent('videos:setup.card.title')
    expect(screen.queryByTestId('video-prompt-form')).not.toBeInTheDocument()
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })

  it('keeps the setup card while the engine is missing, beside existing clips', async () => {
    fake.listVideoGallery.mockResolvedValue({
      items: [makeVideoItem()],
      hasMore: false,
      total: 1,
    })
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
      installedArtifacts: [completeVideo],
    })
    await renderPage()
    expect(screen.queryByTestId('video-onboarding')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-setup-card')).toBeInTheDocument()
    expect(screen.getByTestId('video-gallery-grid')).toBeInTheDocument()
  })

  it('opens the studio once the engine is in, and asks for a video model on the empty canvas', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeImage],
    })
    await renderPage()
    expect(screen.getByTestId('video-prompt-form')).toHaveAttribute('data-models-open', 'false')
    const empty = screen.getByTestId('image-empty-state')
    expect(empty).toHaveAttribute('data-modality', 'video')
    expect(empty).toHaveTextContent('videos:gallery.emptyNoModel')
    // An image checkpoint on disk is not a video model: the download offer stays.
    await userEvent.click(screen.getByTestId('image-empty-download'))
    expect(screen.getByTestId('video-prompt-form')).toHaveAttribute('data-models-open', 'true')
  })

  it('stops offering a download once a video model is on disk, and preselects a deep-linked one', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeVideo],
      modelFiles: makeFilesFor(LTX_2, 'q4_k_m'),
    })
    await renderPage({ model: 'ltx-2', quant: 'q4_k_m' })
    expect(screen.queryByTestId('image-empty-download')).not.toBeInTheDocument()
    expect(useVideoSetting.getState().selectedArtifactId).toBe(LTX_Q4_ID)
    // Picked and stopped is enough: Generate starts it, so no "select a model".
    expect(screen.getByTestId('image-empty-state')).toHaveTextContent(
      'videos:gallery.empty.description'
    )
    expect(screen.getByTestId('video-prompt-form')).toHaveAttribute('data-models-open', 'true')
  })

  it('shows the running clip as a live placeholder above a pending tile', async () => {
    fake.listVideoGallery.mockResolvedValue({ items: [makeVideoItem()], hasMore: false, total: 1 })
    useImageGenerationStore.setState({
      status: makeVideoLoadedStatus(),
      videoCapabilities: makeVideoCapabilities(),
      installedArtifacts: [completeVideo],
    })
    useVideoGenerationStore.setState({
      generating: true,
      generationStartedAtMs: Date.now(),
      currentJob: makeVideoJob({
        state: 'generating',
        progress: { phase: 'sampling', step: 2, totalSteps: 8, fraction: 0.25, etaSeconds: null, elapsedMs: 100 },
      }),
    })
    await renderPage()
    expect(screen.getByTestId('image-generation-preview')).toBeInTheDocument()
    // One announcement in the viewer, one in the pending tile: both speak of a video.
    for (const announcement of screen.getAllByTestId('image-generation-progress-announcement')) {
      expect(announcement).toHaveTextContent('videos:progress.generatingVideo')
    }
    expect(screen.getByTestId('gallery-pending-0')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('video-viewer-section')).toBeInTheDocument()
    // The count includes the clip on its way.
    expect(screen.getByText('2')).toBeInTheDocument()

    // Browsing the gallery brings the viewer back; the pending tile leads back to live.
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-tile-vjob-1'))
    })
    expect(screen.getByTestId('video-viewer')).toBeInTheDocument()
    await act(async () => {
      await userEvent.click(screen.getByTestId('gallery-pending-0'))
    })
    expect(screen.getByTestId('image-generation-preview')).toBeInTheDocument()
  })

  describe('the live progress', () => {
    const running = (
      progress: Partial<
        NonNullable<ReturnType<typeof makeVideoJob>['progress']>
      > | null,
      overrides: Partial<ReturnType<typeof makeVideoJob>> = {}
    ) => {
      useImageGenerationStore.setState({
        status: makeVideoLoadedStatus(),
        videoCapabilities: makeVideoCapabilities(),
        installedArtifacts: [completeVideo],
      })
      useVideoGenerationStore.setState({
        generating: true,
        generationStartedAtMs: Date.now(),
        currentJob: makeVideoJob({
          state: 'generating',
          progress:
            progress === null
              ? null
              : {
                  phase: 'sampling',
                  step: 3,
                  totalSteps: 8,
                  fraction: 0.4,
                  etaSeconds: null,
                  elapsedMs: 60_000,
                  ...progress,
                },
          ...overrides,
        }),
      })
    }

    it('fills the bar inside the preview frame and puts the time left on the step line', async () => {
      running({ etaSeconds: 750, fraction: 0.4 })
      await renderPage()
      const preview = screen.getByTestId('image-generation-preview')
      expect(
        within(preview).getByTestId('image-generation-progress-detail')
      ).toHaveTextContent('videos:progress.step · 60 s · осталось ~13 мин')
      // The shared bar moves its indicator rather than setting aria-valuenow.
      const indicator = within(preview)
        .getByTestId('image-generation-progress-bar')
        .querySelector('[data-slot="progress-indicator"]')
      expect(indicator).toHaveStyle({ transform: 'translateX(-60%)' })
      expect(screen.queryByTestId('video-slowdown')).not.toBeInTheDocument()
    })

    it('says the phase once when the decode runs past its forecast', async () => {
      running({ phase: 'decoding', step: 8, etaSeconds: null, fraction: 0.9 })
      await renderPage()
      const preview = screen.getByTestId('image-generation-preview')
      expect(preview).toHaveTextContent('videos:progress.phase.decoding')
      expect(
        within(preview).queryByTestId('image-generation-remaining')
      ).not.toBeInTheDocument()
      // Nothing outside the frame repeats it.
      expect(screen.getByTestId('video-viewer-section').textContent).toBe(
        preview.textContent
      )
    })

    it('counts down from the job’s estimate before the core reports progress', async () => {
      running(null, {
        estimate: {
          memory: {
            requiredBytes: 1,
            budgetBytes: 2,
            pool: 'unified',
            verdict: 'fits',
          },
          seconds: { low: 450, high: 1800 },
          basis: 'heuristic',
        },
      })
      await renderPage()
      // The middle of 450–1800 s is 900 s: fifteen minutes, less the moment since the start.
      expect(screen.getByTestId('image-generation-remaining')).toHaveTextContent(
        'осталось ~15 мин'
      )
    })

    it('warns when the steps slowed down sharply, and Stop cancels the clip', async () => {
      running({ slowdown: true })
      await renderPage()
      const warning = screen.getByTestId('video-slowdown')
      expect(warning).toHaveTextContent('videos:progress.slowdown.title')
      expect(warning).toHaveTextContent('videos:progress.slowdown.body')
      await act(async () => {
        await userEvent.click(
          within(warning).getByRole('button', {
            name: 'videos:progress.slowdown.stop',
          })
        )
      })
      expect(fake.cancelVideoJob).toHaveBeenCalledWith('vjob-1')
      expect(useVideoGenerationStore.getState().stopRequested).toBe(true)
      expect(
        within(screen.getByTestId('video-slowdown')).getByRole('button')
      ).toBeDisabled()
    })

    it('reads a progress without the flag, from an older core, as no slowdown', async () => {
      running({ etaSeconds: 30 })
      await renderPage()
      expect(screen.queryByTestId('video-slowdown')).not.toBeInTheDocument()
    })
  })

  it('shows a job error and a video-filed model error, and clears both; an image error stays off the page', async () => {
    fake.listVideoGallery.mockResolvedValue({ items: [makeVideoItem()], hasMore: false, total: 1 })
    useImageGenerationStore.setState({
      status: makeVideoLoadedStatus(),
      videoCapabilities: makeVideoCapabilities(),
      lastError: { code: 'OUT_OF_MEMORY', message: 'no room' },
      lastErrorModality: 'video',
    })
    useVideoForm.setState({ width: 1216, height: 704, frames: 121 })
    await renderPage()
    const banner = screen.getByTestId('image-error-banner')
    const viewer = screen.getByTestId('video-viewer')
    expect(banner.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The clip's own words, with what it asked for, not the picture's.
    expect(banner).toHaveTextContent('videos:errors.OUT_OF_MEMORY.title')
    expect(banner).toHaveTextContent('121 frames at 1216×704 (5.0 s)')
    expect(banner).not.toHaveTextContent('images:errors.OUT_OF_MEMORY')
    // "Smaller" here is the smallest preset of the family.
    await userEvent.click(
      screen.getByRole('button', { name: 'videos:errors.actions.reduceSize' })
    )
    expect(useVideoForm.getState()).toMatchObject({ width: 768, height: 512 })
    expect(useImageGenerationStore.getState().lastError).toBeNull()
    expect(screen.queryByTestId('image-error-banner')).not.toBeInTheDocument()

    act(() => {
      useImageGenerationStore.setState({
        lastError: { code: 'MODEL_LOAD_FAILED', message: 'x' },
        lastErrorModality: 'image',
      })
    })
    expect(screen.queryByTestId('image-error-banner')).not.toBeInTheDocument()

    act(() => {
      useVideoGenerationStore.setState({
        lastError: { code: 'ENGINE_CRASHED', message: 'gone' },
      })
    })
    expect(screen.getByTestId('image-error-banner')).toHaveTextContent('images:errors.ENGINE_CRASHED.title')
    await userEvent.click(screen.getByRole('button', { name: 'common:close' }))
    expect(useVideoGenerationStore.getState().lastError).toBeNull()
    // The image page's own error is not this page's to clear.
    expect(useImageGenerationStore.getState().lastError?.code).toBe('MODEL_LOAD_FAILED')
  })

  it('installs the engine straight from the install action, with no wizard', async () => {
    const install = vi
      .spyOn(useImageGenerationStore.getState(), 'installEngine')
      .mockResolvedValue()
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
      lastError: { code: 'ENGINE_MISSING', message: 'x' },
      lastErrorModality: 'video',
    })
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'images:errors.actions.install' }))
    expect(install).toHaveBeenCalledOnce()
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
    install.mockRestore()
  })

  it('offers to load the recipe model from the viewer', async () => {
    fake.listVideoGallery.mockResolvedValue({
      items: [makeVideoItem()],
      hasMore: false,
      total: 1,
    })
    useImageGenerationStore.setState({
      status: makeStatus(),
      installedArtifacts: [completeVideo],
    })
    const load = vi.spyOn(useImageGenerationStore.getState(), 'loadModel').mockResolvedValue()
    await renderPage()
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-recipe-trigger'))
    })
    await act(async () => {
      await userEvent.click(await screen.findByTestId('video-recipe-restore'))
    })
    // The recipe is in the form and its model is picked before the load is offered.
    expect(useVideoForm.getState().prompt).toBe('a lighthouse at dusk, waves rolling in')
    expect(useVideoSetting.getState().selectedArtifactId).toBe(LTX_Q4_ID)
    expect(toast.info).toHaveBeenCalledWith(
      'videos:viewer.loadOffer',
      expect.objectContaining({ action: expect.objectContaining({ label: 'images:model.load' }) })
    )
    const offer = toast.info.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } }
    offer.action.onClick()
    expect(load).toHaveBeenCalledWith(LTX_Q4_ID)
    load.mockRestore()
  })
})
