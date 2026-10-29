import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCapabilities,
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeJob,
  makeLoadedStatus,
  makeStatus,
  Q4_ID,
  Z_IMAGE,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('@/lib/notifications', () => ({ notifyUnlessWatching: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useHardware } from '@/hooks/useHardware'
import { useImageSetting } from '@/hooks/useImageSetting'
import { copyToClipboard } from '@/lib/clipboard'
import { previewImageCapabilities } from '@/lib/diffusion/capabilities'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImagePromptForm } from '../ImagePromptForm'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('ImagePromptForm', () => {
  let fake: FakeDiffusion

  beforeAll(() => {
    global.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await useImageForm.persist.rehydrate()
    await useImageSetting.persist.rehydrate()
    useImageForm.setState({ ...DEFAULT_IMAGE_FORM })
    useImageSetting.setState({ selectedArtifactId: Q4_ID, advancedOpen: false })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      status: makeLoadedStatus(Q4_ID),
      capabilities: makeCapabilities(),
    })
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
    // Subscribe the store to the fake the way the provider does at startup.
    fake.subscribe(useImageGenerationStore.getState().handleEvent)
  })

  it('keeps Generate disabled until there is a prompt', async () => {
    render(<ImagePromptForm />)
    expect(screen.getByTestId('image-generate')).toBeDisabled()

    await act(async () => {
      await userEvent.type(screen.getByLabelText('images:form.prompt'), 'a cat')
    })
    expect(screen.getByTestId('image-generate')).toBeEnabled()
    expect(useImageForm.getState().prompt).toBe('a cat')
  })

  it('omits the shortcut hint and gives Seed the slider label hierarchy', () => {
    render(<ImagePromptForm />)

    expect(screen.queryByText('images:form.shortcut')).not.toBeInTheDocument()
    expect(
      screen.queryByText('images:form.shortcutMac')
    ).not.toBeInTheDocument()
    for (const key of ['images:form.steps', 'images:form.seed']) {
      const label = screen.getByText(key).closest('label')
      expect(label).toHaveClass('text-xs', 'font-medium', 'text-foreground')
      expect(label).not.toHaveClass('text-muted-foreground')
    }
  })

  it('submits on Ctrl+Enter and swaps Generate for Stop while the job runs', async () => {
    fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
    useImageForm.setState({ prompt: 'a lighthouse', steps: 8 })
    render(<ImagePromptForm />)
    const actionSlot = screen.getByTestId('image-generate-slot')

    fireEvent.keyDown(screen.getByLabelText('images:form.prompt'), {
      key: 'Enter',
      ctrlKey: true,
    })

    expect(await screen.findByTestId('image-stop')).toBeInTheDocument()
    expect(screen.getByTestId('image-generate-slot')).toBe(actionSlot)
    expect(fake.generate.mock.calls[0][0]).toMatchObject({
      prompt: 'a lighthouse',
      steps: 8,
      width: 1024,
      height: 1024,
    })
    expect(screen.queryByTestId('image-job-progress')).not.toBeInTheDocument()
    expect(screen.queryByTestId('image-progress-slot')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('image-stop'))
    expect(screen.getByTestId('image-stop')).toBeDisabled()
    expect(screen.getByTestId('image-stop')).toHaveTextContent(
      'images:form.stopping'
    )

    await act(async () => {
      fake.emit({
        type: 'job',
        job: makeJob({ id: 'job-1', state: 'completed' }),
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('image-generate')).toBeInTheDocument()
    )
  })

  it('hides the negative prompt and CFG for a distilled model that has neither', async () => {
    render(<ImagePromptForm />)
    expect(
      screen.queryByText('images:form.negativePrompt')
    ).not.toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByTestId('image-advanced-toggle'))
    })
    expect(
      screen.getByRole('spinbutton', { name: 'images:form.steps' })
    ).toBeInTheDocument()
    expect(screen.queryByText('images:form.cfgScale')).not.toBeInTheDocument()
    expect(screen.queryByText('images:form.guidance')).not.toBeInTheDocument()
  })

  it('keeps the embedded Image Generation API compact and actionable', async () => {
    render(<ImagePromptForm />)

    expect(screen.queryByTestId('image-api-settings-card')).toBeNull()
    await userEvent.click(screen.getByTestId('image-advanced-toggle'))

    const card = screen.getByTestId('image-api-settings-card')
    expect(card).toHaveAttribute('data-variant', 'embedded')
    expect(screen.getByTestId('image-api-endpoint')).toHaveTextContent(
      '/v1/images/generations'
    )
    expect(screen.queryByTestId('image-api-curl')).not.toBeInTheDocument()
    expect(
      screen.queryByText('settings:media.apiRequirements')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('settings:media.apiAuthentication')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('settings:media.apiContract')
    ).not.toBeInTheDocument()

    const copy = screen.getByRole('button', {
      name: 'settings:media.apiCopyEndpoint',
    })
    expect(copy).toHaveTextContent('common:copy')
    expect(copy).toHaveClass('rounded-full')
    await userEvent.click(copy)
    expect(copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('/v1/images/generations')
    )

    const more = screen.getByRole('link', {
      name: 'settings:media.apiMore',
    })
    expect(more).toHaveAttribute('href', '/settings/media')

    const mediaSettings = screen.getByRole('button', {
      name: 'images:form.mediaSettings',
    })
    expect(mediaSettings).toHaveClass('rounded-full')
  })

  it('shows the negative prompt, CFG and guidance when the model supports them', async () => {
    useImageGenerationStore.setState({
      capabilities: makeCapabilities({
        supportsNegativePrompt: true,
        supportsGuidance: true,
        defaults: {
          steps: 20,
          cfgScale: 4,
          guidance: 3.5,
          width: 1024,
          height: 1024,
        },
      }),
    })
    useImageSetting.setState({ advancedOpen: true })
    render(<ImagePromptForm />)
    expect(screen.getByText('images:form.negativePrompt')).toBeInTheDocument()
    expect(screen.getByText('images:form.cfgScale')).toBeInTheDocument()
    expect(screen.getByText('images:form.guidance')).toBeInTheDocument()
  })

  it('resets the knobs to the model defaults but keeps the prompt', async () => {
    useImageForm.setState({
      prompt: 'keep me',
      steps: 3,
      width: 512,
      height: 512,
    })
    useImageSetting.setState({ advancedOpen: true })
    render(<ImagePromptForm />)

    // Reset sits in the settings heading, not in the page heading.
    const heading = screen.getByTestId('image-settings-heading')
    expect(heading).toHaveTextContent('common:settings')
    await act(async () => {
      await userEvent.click(
        within(heading).getByRole('button', { name: 'images:form.reset' })
      )
    })

    const state = useImageForm.getState()
    expect(state.prompt).toBe('keep me')
    expect(state.steps).toBe(8)
    expect(state.width).toBe(1024)
    expect(
      screen.getByRole('spinbutton', { name: 'images:form.steps' })
    ).toHaveValue(8)
  })

  it('snaps a leftover size to what the loaded model accepts', () => {
    useImageForm.setState({ width: 1000, height: 700, steps: 99 })
    render(<ImagePromptForm />)
    const state = useImageForm.getState()
    expect(state.width).toBe(1008)
    expect(state.height).toBe(704)
    expect(state.steps).toBe(50)
  })

  it('says why Generate is unavailable when no model is loaded', () => {
    useImageGenerationStore.setState({ capabilities: null })
    useImageForm.setState({ prompt: 'something' })
    render(<ImagePromptForm />)
    expect(screen.getByTestId('image-generate')).toBeDisabled()
  })

  it('keeps Batch size editable before a model is loaded', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      capabilities: null,
    })
    render(<ImagePromptForm />)

    const batch = screen.getByRole('spinbutton', {
      name: 'images:form.batchSize',
    })
    expect(batch).toBeEnabled()
    await userEvent.clear(batch)
    await userEvent.type(batch, '3')
    fireEvent.blur(batch)
    expect(useImageForm.getState().batchSize).toBe(3)
  })

  it('clamps an offline Batch size when a restrictive model loads', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      capabilities: null,
    })
    useImageForm.setState({ batchSize: 3 })
    render(<ImagePromptForm />)

    act(() => {
      useImageGenerationStore.setState({
        status: makeLoadedStatus(Q4_ID),
        capabilities: makeCapabilities({ maxBatch: 1 }),
      })
    })

    await waitFor(() => expect(useImageForm.getState().batchSize).toBe(1))
    expect(
      screen.getByRole('spinbutton', { name: 'images:form.batchSize' })
    ).toHaveValue(1)
    expect(
      screen.getByRole('spinbutton', { name: 'images:form.batchSize' })
    ).toBeDisabled()
  })

  it('retains an offline Batch size supported by the loaded model', async () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      capabilities: null,
    })
    useImageForm.setState({ batchSize: 3 })
    render(<ImagePromptForm />)

    act(() => {
      useImageGenerationStore.setState({
        status: makeLoadedStatus(Q4_ID),
        capabilities: makeCapabilities({ maxBatch: 4 }),
      })
    })

    await waitFor(() => expect(useImageForm.getState().batchSize).toBe(3))
    expect(
      screen.getByRole('spinbutton', { name: 'images:form.batchSize' })
    ).toHaveValue(3)
  })

  it('does not render a second model Stop beside the top picker', () => {
    render(<ImagePromptForm />)
    expect(
      screen.queryByRole('button', { name: 'images:model.unload' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('image-generate')).toBeInTheDocument()
  })

  it('does not present a remembered model as running', () => {
    useImageGenerationStore.setState({
      status: makeStatus(),
      capabilities: null,
    })
    render(<ImagePromptForm />)

    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'images:model.select'
    )
    expect(screen.getByTestId('image-models-toggle')).not.toHaveTextContent(
      'Z-Image Turbo'
    )
  })

  it('requires a compatible picker selection without a workflow warning card', () => {
    useImageForm.setState({ workflow: 'edit' })
    useImageForm.setState({ prompt: 'change the sky' })
    render(<ImagePromptForm />)

    expect(
      screen.queryByTestId('image-workflow-model-notice')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'images:model.select'
    )
    expect(screen.getByTestId('image-generate')).toBeDisabled()
  })
  describe('with the picked model stopped', () => {
    // Qwen-Image's shape: cfg 2.5, so it takes a negative prompt.
    const QWEN = {
      ...Z_IMAGE,
      id: 'qwen-image',
      name: 'Qwen-Image',
      defaults: { steps: 20, cfg_scale: 2.5, width: 1024, height: 1024 },
    } as typeof Z_IMAGE
    const QWEN_ID = 'qwen-image:q4_k_m'
    const realLoad = useImageGenerationStore.getState().loadModel

    beforeEach(() => {
      const catalog = makeCatalog([Z_IMAGE, QWEN])
      const files = makeFilesFor(QWEN, 'q4_k_m')
      useImageGenerationStore.setState({
        catalog,
        modelFiles: files,
        installedArtifacts: listInstalledArtifacts(catalog, files),
        paths: {
          dataFolder: '/data',
          modelsRoot: '/data/diffusion/models',
          backendsRoot: '/data/diffusion/backends',
          imagesDir: '/data/images',
          videosDir: '/data/videos',
        },
        status: makeStatus(),
        capabilities: null,
        loadModel: realLoad,
      })
      useImageSetting.setState({ selectedArtifactId: QWEN_ID })
      useImageForm.setState({ recipeFamily: 'qwen-image', prompt: 'a cat' })
    })

    it('shows the negative prompt and Reset at once, and lets Generate start it', () => {
      render(<ImagePromptForm />)
      expect(screen.getByText('images:form.negativePrompt')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'images:form.reset' })
      ).toBeInTheDocument()
      expect(screen.getByTestId('image-generate')).toBeEnabled()
    })

    it('gives a newly picked family its defaults before it starts', () => {
      useImageForm.setState({ recipeFamily: 'z-image', steps: 8, cfgScale: 1 })
      render(<ImagePromptForm />)
      expect(useImageForm.getState()).toMatchObject({
        recipeFamily: 'qwen-image',
        steps: 20,
        cfgScale: 2.5,
      })
    })

    it('asks before generating with a model that will not fit, and Cancel starts nothing', async () => {
      // QA 2026-10-23: an 8 GB Mac swapped a ~6.5 GB model until the engine stopped.
      const hardware = useHardware.getState().hardwareData
      useHardware.setState({
        hardwareData: { ...hardware, os_type: 'macos', total_memory: 8192, gpus: [] },
      })
      const loadModel = vi.fn(async () => {})
      useImageGenerationStore.setState({ loadModel })
      try {
        render(<ImagePromptForm />)
        await userEvent.click(screen.getByTestId('image-generate'))
        const dialog = await screen.findByTestId('image-exceeds-dialog')
        expect(dialog).toHaveTextContent('images:confirmExceeds.title')
        expect(dialog).toHaveTextContent('images:confirmExceeds.needs')
        await userEvent.click(
          within(dialog).getByRole('button', { name: 'common:cancel' })
        )
        await waitFor(() =>
          expect(
            screen.queryByTestId('image-exceeds-dialog')
          ).not.toBeInTheDocument()
        )
        expect(loadModel).not.toHaveBeenCalled()
        expect(fake.generate).not.toHaveBeenCalled()

        await userEvent.click(screen.getByTestId('image-generate'))
        await userEvent.click(
          within(await screen.findByTestId('image-exceeds-dialog')).getByRole(
            'button',
            { name: 'images:confirmExceeds.confirm' }
          )
        )
        await waitFor(() => expect(loadModel).toHaveBeenCalledWith(QWEN_ID))
      } finally {
        useHardware.setState({ hardwareData: hardware })
      }
    })

    it('starts the model on Generate and generates with what was set before', async () => {
      useImageForm.setState({
        width: 640,
        height: 480,
        aspect: 'photo',
        steps: 10,
        cfgScale: 3,
      })
      let finishLoad = () => {}
      const loadModel = vi.fn(
        (id: string) =>
          new Promise<void>((resolve) => {
            useImageGenerationStore.setState({ loadingArtifactId: id })
            finishLoad = () => {
              useImageGenerationStore.setState({
                loadingArtifactId: null,
                status: makeLoadedStatus(id),
                capabilities: previewImageCapabilities(QWEN),
              })
              resolve()
            }
          })
      )
      useImageGenerationStore.setState({ loadModel })
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      render(<ImagePromptForm />)

      await userEvent.click(screen.getByTestId('image-generate'))
      expect(loadModel).toHaveBeenCalledWith(QWEN_ID)
      expect(screen.getByTestId('image-generate')).toHaveTextContent(
        'images:form.starting'
      )

      await act(async () => finishLoad())
      await waitFor(() => expect(fake.generate).toHaveBeenCalledTimes(1))
      expect(fake.generate.mock.calls[0][0]).toMatchObject({
        prompt: 'a cat',
        width: 640,
        height: 480,
        steps: 10,
        cfgScale: 3,
      })
      expect(useImageForm.getState()).toMatchObject({
        width: 640,
        height: 480,
        aspect: 'photo',
        steps: 10,
        cfgScale: 3,
      })
    })
  })
})
