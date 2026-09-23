import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeCatalog,
  makeStatus,
  Q4_ID,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { LTX_2, LTX_Q4_ID } from '@/lib/diffusion/__tests__/video-fixtures'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageSetupCard } from '../ImageSetupCard'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const completeArtifact = {
  id: Q4_ID,
  family: 'z-image' as const,
  quantId: 'q4_k_m',
  bytes: 1,
  complete: true,
  missing: [],
}

describe('ImageSetupCard', () => {
  beforeEach(() => {
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
      hostBackendId: 'macos-arm64',
      hostBackendResolved: true,
      installedArtifacts: [],
    })
  })

  afterEach(cleanup)

  it('opens the engine step from its row and the tour from the button', async () => {
    render(<ImageSetupCard />)

    await userEvent.click(screen.getByText('images:setup.card.engine'))
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupOpen: true,
      setupStep: 1,
    })

    act(() => useImageGenerationStore.getState().closeSetup())
    await userEvent.click(screen.getByTestId('image-setup-open'))
    expect(screen.getByTestId('image-setup-open')).toHaveTextContent(
      'images:setup.card.button'
    )
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupOpen: true,
      setupStep: 0,
    })
  })

  it('shows the model row as the road ahead, not as a way into the wizard', async () => {
    render(<ImageSetupCard />)

    // Models are fetched from the studio's picker once the engine is in.
    const row = screen.getByTestId('image-setup-row-model')
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('images:setup.card.model'))
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })

  it('speaks for the Video page, counts only a video model as done, and opens the wizard for video', async () => {
    const completeVideo = {
      id: LTX_Q4_ID,
      family: 'ltx-2' as const,
      quantId: 'q4_k_m',
      bytes: 1,
      complete: true,
      missing: [],
    }
    useImageGenerationStore.setState({
      catalog: makeCatalog([Z_IMAGE, LTX_2]),
      installedArtifacts: [completeArtifact],
    })
    const { unmount } = render(<ImageSetupCard modality="video" />)

    const card = screen.getByTestId('image-setup-card')
    expect(card).toHaveAttribute('data-modality', 'video')
    expect(card).toHaveTextContent('videos:setup.card.title')
    expect(card).toHaveTextContent('videos:setup.card.engine')
    expect(card).not.toHaveTextContent('images:setup.card.title')
    // An image checkpoint on disk does not tick the video model row.
    expect(
      within(screen.getByTestId('image-setup-row-model')).getByText('2')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByText('videos:setup.card.engine'))
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupOpen: true,
      setupStep: 1,
      setupModality: 'video',
    })
    act(() => useImageGenerationStore.getState().closeSetup())
    await userEvent.click(screen.getByTestId('image-setup-open'))
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupStep: 0,
      setupModality: 'video',
    })
    unmount()

    useImageGenerationStore.setState({
      installedArtifacts: [completeArtifact, completeVideo],
    })
    render(<ImageSetupCard modality="video" />)
    expect(
      within(screen.getByTestId('image-setup-row-model')).queryByText('2')
    ).not.toBeInTheDocument()
  })

  it('still routes to engine setup when a model was downloaded first', async () => {
    useImageGenerationStore.setState({ installedArtifacts: [completeArtifact] })
    render(<ImageSetupCard />)

    expect(screen.getByTestId('image-setup-open')).toHaveTextContent(
      'images:setup.card.button'
    )
    await userEvent.click(screen.getByTestId('image-setup-open'))
    expect(useImageGenerationStore.getState().setupStep).toBe(0)
  })
})
