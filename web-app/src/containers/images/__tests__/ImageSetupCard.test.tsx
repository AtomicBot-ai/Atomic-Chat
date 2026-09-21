import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeStatus, Q4_ID } from '@/lib/diffusion/__tests__/image-fixtures'
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

  it('keeps both prerequisite cards clickable and starts the full setup flow', async () => {
    render(<ImageSetupCard />)

    await userEvent.click(screen.getByText('images:setup.card.engine'))
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupOpen: true,
      setupStep: 1,
    })

    act(() => useImageGenerationStore.getState().closeSetup())
    await userEvent.click(screen.getByText('images:setup.card.model'))
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupOpen: true,
      setupStep: 2,
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

  it('jumps straight to model download once the engine is installed', async () => {
    useImageGenerationStore.setState({ status: makeStatus() })
    render(<ImageSetupCard />)

    expect(screen.getByTestId('image-setup-open')).toHaveTextContent(
      'images:setup.card.downloadModel'
    )
    await userEvent.click(screen.getByTestId('image-setup-open'))
    expect(useImageGenerationStore.getState()).toMatchObject({
      setupOpen: true,
      setupStep: 2,
    })
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
