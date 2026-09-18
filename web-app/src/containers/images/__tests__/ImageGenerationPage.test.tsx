import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  useTranslation: () => ({ t: (key: string) => key }),
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
  ImagePromptForm: () => <div data-testid="image-prompt-form" />,
}))
vi.mock('../ImageViewer', () => ({
  ImageViewer: () => <div data-testid="image-viewer" />,
}))
vi.mock('../ImageGalleryGrid', () => ({
  ImageGalleryGrid: () => <div data-testid="image-gallery-grid" />,
}))
vi.mock('../ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
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
})
