import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCapabilities,
  makeFakeDiffusion,
  makeJob,
  makeLoadedStatus,
  makeStatus,
  Q4_ID,
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
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { copyToClipboard } from '@/lib/clipboard'
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

    await act(async () => {
      await userEvent.click(screen.getByText('images:form.reset'))
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
})
