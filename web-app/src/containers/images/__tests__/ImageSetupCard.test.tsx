import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeStatus } from '@/lib/diffusion/__tests__/image-fixtures'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageSetupCard } from '../ImageSetupCard'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const MB = 1024 * 1024

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

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('installs the engine in one click, with no wizard in between', async () => {
    const install = vi
      .spyOn(useImageGenerationStore.getState(), 'installEngine')
      .mockResolvedValue()
    render(<ImageSetupCard />)

    const button = screen.getByTestId('image-engine-install')
    expect(button).toHaveTextContent('images:setup.card.engine')
    await userEvent.click(button)

    expect(install).toHaveBeenCalledOnce()
    expect(useImageGenerationStore.getState().setupOpen).toBe(false)
  })

  it('shows the progress on the button while the engine comes down', () => {
    useImageGenerationStore.setState({
      engineInstall: {
        inFlight: true,
        transferred: 25 * MB,
        total: 100 * MB,
        error: null,
      },
    })
    render(<ImageSetupCard />)

    const button = screen.getByTestId('image-engine-install')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('25%')
    expect(screen.getByTestId('image-engine-progress')).toHaveTextContent(
      '25 / 100 MB'
    )
  })

  it('offers the same button again with the reason after a failed install', () => {
    useImageGenerationStore.setState({
      engineInstall: {
        inFlight: false,
        transferred: 0,
        total: 0,
        error: { code: 'ENGINE_MISSING', message: 'No space left.' },
      },
    })
    render(<ImageSetupCard />)

    expect(screen.getByTestId('image-engine-install')).toBeEnabled()
    expect(screen.getByTestId('image-setup-card')).toHaveTextContent(
      'images:setup.engine.failed No space left.'
    )
  })

  it('waits for the host check before offering the install', () => {
    useImageGenerationStore.setState({
      hostBackendId: null,
      hostBackendResolved: false,
    })
    render(<ImageSetupCard />)

    const button = screen.getByTestId('image-engine-install')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('images:setup.engine.checking')
  })

  it('explains when this computer has no engine build, and offers no install', () => {
    useImageGenerationStore.setState({
      hostBackendId: null,
      hostBackendReason: 'Intel Macs are not supported.',
      hostBackendResolved: true,
    })
    render(<ImageSetupCard />)

    const card = screen.getByTestId('image-setup-card')
    expect(card).toHaveTextContent('images:setup.engine.unsupported')
    expect(card).toHaveTextContent('Intel Macs are not supported.')
    expect(screen.queryByTestId('image-engine-install')).not.toBeInTheDocument()
    expect(screen.queryByTestId('image-engine-retry')).not.toBeInTheDocument()
  })

  it('says the build list could not be loaded, why, after how many attempts, and retries', async () => {
    const readError =
      'sd.cpp manifest from https://raw.githubusercontent.com/x: timed out after 8000ms'
    useImageGenerationStore.setState({
      hostBackendId: null,
      hostBackendReason: readError,
      hostBackendCheckFailed: 'manifest',
      hostBackendAttempt: 3,
      hostBackendResolved: true,
    })
    const retry = vi
      .spyOn(useImageGenerationStore.getState(), 'refreshHostBackend')
      .mockResolvedValue()
    render(<ImageSetupCard />)

    const card = screen.getByTestId('image-setup-card')
    expect(card).toHaveTextContent('images:setup.engine.offline')
    expect(card).not.toHaveTextContent('images:setup.engine.unsupported')
    expect(screen.getByTestId('image-engine-failure-reason')).toHaveTextContent(
      'images:setup.engine.reason.timeoutSeconds images:setup.engine.attempts'
    )
    expect(screen.getByTestId('image-engine-host-reason')).toHaveTextContent(
      readError
    )
    await userEvent.click(screen.getByTestId('image-engine-retry'))
    expect(retry).toHaveBeenCalledWith({ force: true })
  })

  it('says it is trying again while the check repeats on its own', () => {
    useImageGenerationStore.setState({
      hostBackendId: null,
      hostBackendCheckFailed: null,
      hostBackendAttempt: 2,
      hostBackendResolved: false,
    })
    render(<ImageSetupCard />)

    const button = screen.getByTestId('image-engine-install')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('images:setup.engine.retrying')
    expect(screen.queryByTestId('image-engine-retry')).not.toBeInTheDocument()
  })

  it('names the network reason when the engine download fails, the core words on hover', () => {
    useImageGenerationStore.setState({
      engineInstall: {
        inFlight: false,
        transferred: 0,
        total: 0,
        error: {
          code: 'INTERNAL',
          message: 'Unable to connect. Is the computer able to access the url?',
        },
      },
    })
    render(<ImageSetupCard />)

    const line = screen.getByTestId('image-engine-install-error')
    expect(line).toHaveTextContent(
      'images:setup.engine.failed images:setup.engine.reason.unreachable'
    )
    expect(line).toHaveAttribute(
      'title',
      'Unable to connect. Is the computer able to access the url?'
    )
  })

  it('offers a retry when the core did not answer the host check', () => {
    useImageGenerationStore.setState({
      hostBackendId: null,
      hostBackendReason: 'The core did not answer.',
      hostBackendCheckFailed: 'core',
      hostBackendResolved: true,
    })
    render(<ImageSetupCard />)

    expect(screen.getByTestId('image-setup-card')).toHaveTextContent(
      'images:setup.engine.checkFailed'
    )
    expect(screen.getByTestId('image-engine-retry')).toBeInTheDocument()
  })

  it('speaks for the Video page', () => {
    render(<ImageSetupCard modality="video" />)

    const card = screen.getByTestId('image-setup-card')
    expect(card).toHaveAttribute('data-modality', 'video')
    expect(card).toHaveTextContent('videos:setup.card.title')
    expect(card).not.toHaveTextContent('images:setup.card.title')
    expect(screen.getByTestId('image-engine-install')).toHaveTextContent(
      'videos:setup.card.engine'
    )
  })
})
