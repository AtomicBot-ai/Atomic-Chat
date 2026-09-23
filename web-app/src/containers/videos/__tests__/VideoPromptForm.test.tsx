import { act, fireEvent, render, screen } from '@testing-library/react'
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
          : key,
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
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
    expect(screen.getByTestId('video-form-title')).toHaveTextContent('videos:form.title')
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
    // The knob shows the draft's cfg; the defaults land through the store's reset on load.
    expect(screen.getByRole('spinbutton', { name: 'videos:form.guidance' })).toHaveValue(1)
    expect(
      screen.getByRole('spinbutton', { name: 'videos:form.distilledGuidance' })
    ).toBeInTheDocument()
    // The load clamped the draft to Wan's own presets and lattice.
    expect(useVideoForm.getState()).toMatchObject({ width: 1280, height: 704 })
  })

  it('resets the knobs to the model defaults but keeps the prompt', async () => {
    useVideoForm.setState({ prompt: 'kept', frames: 25, steps: 3, seedText: '9' })
    render(<VideoPromptForm />)
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'videos:form.reset' }))
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
})
