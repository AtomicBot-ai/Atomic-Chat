import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeFakeDiffusion,
  makeStatus,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_Q4_ID,
  makeVideoCapabilities,
  makeVideoEstimate,
  makeVideoLoadedStatus,
  makeWanCapabilities,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'videos:form.durationOption'
        ? `${values?.seconds}s · ${values?.frames} frames`
        : key === 'videos:form.fps'
          ? `${values?.fps} fps`
          : key === 'videos:estimate.duration'
            ? `Takes ${values?.range}`
            : key === 'videos:estimate.exceeds'
              ? `Needs ${values?.required} GB, ${values?.available} GB available`
              : key.startsWith('videos:estimate.units.')
                ? key.slice('videos:estimate.units.'.length)
                : key,
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('@/lib/notifications', () => ({ notifyWhenAway: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }))
vi.mock('@/containers/images/ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoPromptForm } from '../VideoPromptForm'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('VideoPromptForm', () => {
  let fake: FakeDiffusion

  beforeAll(() => {
    global.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useVideoForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    await useVideoSetting.persist.rehydrate()
    useVideoForm.setState({ ...DEFAULT_VIDEO_FORM })
    useImageSetting.setState({ advancedOpen: false, offloadOverride: 'auto' })
    useVideoSetting.setState({ selectedArtifactId: LTX_Q4_ID, advancedOpen: false })
    useImageGenerationStore.getState().reset()
    useVideoGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      status: makeVideoLoadedStatus(),
      videoCapabilities: makeVideoCapabilities(),
    })
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
    fake.subscribe(useVideoGenerationStore.getState().handleEvent)
  })

  it('keeps Generate disabled until there is a prompt, then submits the video request', async () => {
    render(<VideoPromptForm />)
    expect(screen.getByTestId('video-workflow-title')).toHaveTextContent('videos:form.title')
    expect(screen.getByTestId('image-generate')).toBeDisabled()

    await act(async () => {
      await userEvent.type(screen.getByLabelText('videos:form.prompt'), 'a cat')
    })
    expect(screen.getByTestId('image-generate')).toBeEnabled()
    expect(useVideoForm.getState().prompt).toBe('a cat')

    fake.generateVideo.mockImplementation(async () => ({ jobId: 'vjob-1' }))
    await act(async () => {
      await userEvent.click(screen.getByTestId('image-generate'))
    })
    expect(fake.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'a cat',
        width: 768,
        height: 512,
        frames: 121,
        fps: 24,
        steps: 8,
        cfgScale: 1,
        workflow: 'create',
      })
    )
    expect(screen.getByTestId('image-stop')).toBeInTheDocument()
  })

  it('heads the column like Images, with the same mode pill; image-to-video is listed as coming', async () => {
    render(<VideoPromptForm />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('videos:page.title')
    expect(screen.getByTestId('video-page-subtitle')).toHaveTextContent('videos:page.subtitle')
    expect(screen.getByTestId('video-workflow-select')).toHaveAttribute('data-mode', 'create')

    await act(async () => {
      await userEvent.click(screen.getByTestId('video-workflow-select'))
    })
    expect(screen.getByTestId('video-workflow-option-create')).toHaveAttribute('data-selected', 'true')
    const imageToVideo = screen.getByTestId('video-workflow-option-image-to-video')
    expect(imageToVideo).toHaveAttribute('data-disabled')
    expect(imageToVideo).toHaveTextContent('videos:workflow.imageToVideo.title')
    expect(imageToVideo).toHaveTextContent('videos:workflow.soon')

    await act(async () => {
      await userEvent.click(imageToVideo)
    })
    expect(screen.getByTestId('video-workflow-select')).toHaveAttribute('data-mode', 'create')
  })

  it('submits on Ctrl+Enter', async () => {
    useVideoForm.setState({ prompt: 'a lighthouse' })
    fake.generateVideo.mockImplementation(async () => ({ jobId: 'vjob-1' }))
    render(<VideoPromptForm />)
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('videos:form.prompt'), {
        key: 'Enter',
        ctrlKey: true,
      })
    })
    expect(fake.generateVideo).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('image-stop')).toBeInTheDocument()
  })

  it('offers the family presets, the lattice durations and the fixed rate', async () => {
    useVideoForm.setState({ frames: 49 })
    render(<VideoPromptForm />)
    expect(screen.getByTestId('video-resolution')).toHaveTextContent('768 × 512')
    expect(screen.getByTestId('video-duration')).toHaveTextContent('2.0s · 49 frames')
    expect(screen.getByTestId('video-frame-rate')).toHaveTextContent('24 fps')

    await act(async () => {
      await userEvent.click(screen.getByTestId('video-resolution'))
    })
    const portrait = await screen.findByTestId('video-resolution-704x1216')
    expect(portrait).toHaveTextContent('704 × 1216videos:form.portraitSuffix')
    await act(async () => {
      await userEvent.click(portrait)
    })
    expect(useVideoForm.getState()).toMatchObject({ width: 704, height: 1216 })

    await act(async () => {
      await userEvent.click(screen.getByTestId('video-duration'))
    })
    const options = await screen.findAllByTestId(/^video-duration-\d+$/)
    expect(options.map((o) => o.textContent)).toEqual([
      '1.0s · 25 frames',
      '2.0s · 49 frames',
      '3.0s · 73 frames',
      '5.0s · 121 frames',
    ])
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-duration-121'))
    })
    expect(useVideoForm.getState().frames).toBe(121)
  })

  it('hides the negative prompt and guidance for LTX, and shows them for Wan', async () => {
    const { unmount } = render(<VideoPromptForm />)
    expect(screen.queryByText('videos:form.negativePrompt')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('videos:form.guidance')).not.toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'videos:form.steps' })).toBeInTheDocument()
    expect(screen.getByLabelText('images:form.seed')).toHaveAttribute('id', 'video-seed')
    unmount()

    useImageGenerationStore.setState({
      status: makeVideoLoadedStatus('wan2.2-ti2v-5b:q4_k_m', 'wan2.2-ti2v-5b'),
      videoCapabilities: makeWanCapabilities({ supportsGuidance: true }),
    })
    useVideoSetting.setState({ selectedArtifactId: 'wan2.2-ti2v-5b:q4_k_m' })
    render(<VideoPromptForm />)
    expect(screen.getByText('videos:form.negativePrompt')).toBeInTheDocument()
    // Another family: the draft took Wan's own numbers, cfg 5 among them.
    expect(screen.getByRole('spinbutton', { name: 'videos:form.guidance' })).toHaveValue(5)
    expect(
      screen.getByRole('spinbutton', { name: 'videos:form.distilledGuidance' })
    ).toBeInTheDocument()
    expect(useVideoForm.getState()).toMatchObject({
      recipeFamily: 'wan2.2-ti2v-5b',
      width: 1280,
      height: 704,
    })
  })

  it('resets the knobs to the model defaults but keeps the prompt', async () => {
    useVideoForm.setState({ prompt: 'kept', frames: 25, steps: 3, seedText: '9' })
    render(<VideoPromptForm />)
    // Reset sits in the settings heading, not in the page heading.
    const heading = screen.getByTestId('video-settings-heading')
    expect(heading).toHaveTextContent('common:settings')
    await act(async () => {
      await userEvent.click(
        within(heading).getByRole('button', { name: 'videos:form.reset' })
      )
    })
    expect(useVideoForm.getState()).toMatchObject({
      prompt: 'kept',
      frames: 121,
      steps: 8,
      seedText: '',
    })
  })

  it('says why Generate is unavailable when no video model is loaded', () => {
    useImageGenerationStore.setState({ status: makeStatus(), videoCapabilities: null })
    useVideoForm.setState({ prompt: 'a cat' })
    render(<VideoPromptForm />)
    expect(screen.getByTestId('image-generate')).toBeDisabled()
  })

  it('writes the Advanced load-time settings to the shared image settings and shows the video API card', async () => {
    render(<VideoPromptForm />)
    expect(screen.queryByTestId('image-api-settings-card')).toBeNull()
    await act(async () => {
      await userEvent.click(screen.getByTestId('video-advanced-toggle'))
    })
    expect(useVideoSetting.getState().advancedOpen).toBe(true)
    expect(useImageSetting.getState().advancedOpen).toBe(false)

    const card = screen.getByTestId('image-api-settings-card')
    expect(card).toHaveAttribute('data-resource', 'videos')
    expect(screen.getByText('settings:media.videoApiTitle')).toBeInTheDocument()
    expect(screen.queryByText('settings:media.apiTitle')).not.toBeInTheDocument()
    expect(screen.getByTestId('image-api-endpoint')).toHaveTextContent(/\/v1\/videos$/)

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'images:form.memory' }))
    })
    await act(async () => {
      await userEvent.click(await screen.findByText('images:form.memoryModel'))
    })
    expect(useImageSetting.getState().offloadOverride).toBe('model')

    await act(async () => {
      await userEvent.click(screen.getByRole('switch', { name: 'settings:media.keepLoaded' }))
    })
    expect(useImageSetting.getState().keepModelLoaded).toBe(true)
    expect(fake.configure).toHaveBeenCalled()
  })

  describe('the estimate', () => {
    it('reads a range of time when the clip fits', async () => {
      fake.estimateVideo.mockResolvedValue(makeVideoEstimate('fits'))
      render(<VideoPromptForm />)
      const line = await screen.findByTestId('video-estimate')
      expect(line).toHaveAttribute('data-verdict', 'fits')
      expect(line).toHaveTextContent('Takes ~4–7 min')
      expect(line).not.toHaveTextContent('videos:estimate.tight')
      expect(
        screen.queryByTestId('video-estimate-history')
      ).not.toBeInTheDocument()
      // The form's numbers go to the core, never the prompt.
      expect(fake.estimateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'estimate',
          width: 768,
          height: 512,
          frames: 121,
          steps: 8,
        })
      )
    })

    it('warns when memory is tight, and marks an estimate made from this machine’s clips', async () => {
      fake.estimateVideo.mockResolvedValue(
        makeVideoEstimate('tight', { basis: 'history' })
      )
      render(<VideoPromptForm />)
      const line = await screen.findByTestId('video-estimate')
      expect(line).toHaveAttribute('data-verdict', 'tight')
      expect(line).toHaveTextContent('Takes ~4–7 min')
      expect(line).toHaveTextContent('videos:estimate.tight')
      expect(screen.getByTestId('video-estimate-history')).toHaveTextContent(
        'videos:estimate.historyShort'
      )
    })

    it('leaves an exceeding clip to the confirmation: no warning under Generate', async () => {
      fake.estimateVideo.mockResolvedValue(makeVideoEstimate('exceeds'))
      render(<VideoPromptForm />)
      await vi.waitFor(() => expect(fake.estimateVideo).toHaveBeenCalled())
      await act(async () => {})
      expect(screen.queryByTestId('video-estimate')).not.toBeInTheDocument()
      expect(screen.queryByText(/Needs 27\.3 GB/)).not.toBeInTheDocument()
    })

    it('shows nothing when the core has no estimate, and Generate works as before', async () => {
      fake.estimateVideo.mockResolvedValue(null)
      useVideoForm.setState({ prompt: 'a cat' })
      render(<VideoPromptForm />)
      await vi.waitFor(() => expect(fake.estimateVideo).toHaveBeenCalled())
      await act(async () => {})
      expect(screen.queryByTestId('video-estimate')).not.toBeInTheDocument()
      await act(async () => {
        await userEvent.click(screen.getByTestId('image-generate'))
      })
      expect(fake.generateVideo).toHaveBeenCalledTimes(1)
      expect(
        screen.queryByTestId('video-exceeds-dialog')
      ).not.toBeInTheDocument()
    })

    it('asks before generating a clip that exceeds memory', async () => {
      fake.estimateVideo.mockResolvedValue(makeVideoEstimate('exceeds'))
      useVideoForm.setState({ prompt: 'a cat' })
      render(<VideoPromptForm />)
      await vi.waitFor(() => expect(fake.estimateVideo).toHaveBeenCalled())
      await act(async () => {})
      await act(async () => {
        await userEvent.click(screen.getByTestId('image-generate'))
      })
      const dialog = screen.getByTestId('video-exceeds-dialog')
      expect(dialog).toHaveTextContent('Needs 27.3 GB, 13.6 GB available')
      expect(dialog).toHaveTextContent('videos:estimate.exceedsAdvice')
      expect(fake.generateVideo).not.toHaveBeenCalled()
      await act(async () => {
        await userEvent.click(screen.getByText('videos:confirmExceeds.confirm'))
      })
      expect(fake.generateVideo).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'a cat', frames: 121 })
      )
    })
  })
})
