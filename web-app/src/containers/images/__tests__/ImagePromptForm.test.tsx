import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCapabilities,
  makeFakeDiffusion,
  makeJob,
  makeLoadedStatus,
  Q4_ID,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
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
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  beforeEach(async () => {
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

  it('submits on Ctrl+Enter and swaps Generate for Stop while the job runs', async () => {
    fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
    useImageForm.setState({ prompt: 'a lighthouse', steps: 8 })
    render(<ImagePromptForm />)

    fireEvent.keyDown(screen.getByLabelText('images:form.prompt'), {
      key: 'Enter',
      ctrlKey: true,
    })

    expect(await screen.findByTestId('image-stop')).toBeInTheDocument()
    expect(fake.generate.mock.calls[0][0]).toMatchObject({
      prompt: 'a lighthouse',
      steps: 8,
      width: 1024,
      height: 1024,
    })
    expect(screen.getByTestId('image-job-progress')).toBeInTheDocument()

    await act(async () => {
      fake.emit({ type: 'job', job: makeJob({ id: 'job-1', state: 'completed' }) })
    })
    await waitFor(() =>
      expect(screen.getByTestId('image-generate')).toBeInTheDocument()
    )
  })

  it('hides the negative prompt and CFG for a distilled model that has neither', async () => {
    render(<ImagePromptForm />)
    expect(screen.queryByText('images:form.negativePrompt')).not.toBeInTheDocument()

    await act(async () => {
      await userEvent.click(screen.getByTestId('image-advanced-toggle'))
    })
    expect(screen.getByRole('spinbutton', { name: 'images:form.steps' })).toBeInTheDocument()
    expect(screen.queryByText('images:form.cfgScale')).not.toBeInTheDocument()
    expect(screen.queryByText('images:form.guidance')).not.toBeInTheDocument()
  })

  it('shows the negative prompt, CFG and guidance when the model supports them', async () => {
    useImageGenerationStore.setState({
      capabilities: makeCapabilities({
        supportsNegativePrompt: true,
        supportsGuidance: true,
        defaults: { steps: 20, cfgScale: 4, guidance: 3.5, width: 1024, height: 1024 },
      }),
    })
    useImageSetting.setState({ advancedOpen: true })
    render(<ImagePromptForm />)
    expect(screen.getByText('images:form.negativePrompt')).toBeInTheDocument()
    expect(screen.getByText('images:form.cfgScale')).toBeInTheDocument()
    expect(screen.getByText('images:form.guidance')).toBeInTheDocument()
  })

  it('resets the knobs to the model defaults but keeps the prompt', async () => {
    useImageForm.setState({ prompt: 'keep me', steps: 3, width: 512, height: 512 })
    useImageSetting.setState({ advancedOpen: true })
    render(<ImagePromptForm />)

    await act(async () => {
      await userEvent.click(screen.getByText('images:form.reset'))
    })

    const state = useImageForm.getState()
    expect(state.prompt).toBe('keep me')
    expect(state.steps).toBe(8)
    expect(state.width).toBe(1024)
    expect(screen.getByRole('spinbutton', { name: 'images:form.steps' })).toHaveValue(8)
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
})
