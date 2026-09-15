/**
 * Downloading a model from the Media page itself (tracker Task 30).
 *
 * The built-in engine lists every model it can make images with, downloaded or
 * not. A model that is not downloaded yet offers "Download model" in place of
 * Generate, so a new user never has to leave the page to make a first image.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type {
  MediaModelDescriptor,
  MediaProviderDescriptor,
} from '@/services/media/contract'

import { formatDownloadSize } from '../downloadSize'
import {
  MediaGenerationForm,
  type MediaInstallProgress,
} from '../MediaGenerationForm'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue ?? key)
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
    },
  }),
}))

const engine: MediaProviderDescriptor = {
  id: 'builtin-engine',
  label: 'Built-in engine',
  kind: 'local_engine',
  adapter: 'builtin-engine',
  enabled: true,
  origin: 'builtin',
}

const model = (installed: boolean): MediaModelDescriptor => ({
  id: 'builtin-engine:sd-1.5',
  provider_id: 'builtin-engine',
  local_id: 'sd-1.5',
  label: 'Stable Diffusion 1.5',
  tasks: ['text_to_image'],
  params: {
    text_to_image: [{ id: 'prompt', type: 'text', required: true, label: 'Prompt' }],
  },
  install: { installed, installable: true, size_bytes: 1_763_578_176 },
})

function Harness({
  onInstall,
  onSubmit = vi.fn(),
}: {
  onInstall: (onProgress: (p: MediaInstallProgress) => void) => Promise<void>
  onSubmit?: () => void
}) {
  const [installed, setInstalled] = useState(false)
  return (
    <MediaGenerationForm
      tasks={[{ id: 'text_to_image', label: 'Image', output_media_type: 'image' }]}
      task="text_to_image"
      onTaskChange={() => {}}
      models={[model(installed)]}
      providers={[engine]}
      devices={[]}
      selectedModelId="builtin-engine:sd-1.5"
      onSelectModel={() => {}}
      onSubmit={onSubmit}
      onInstallModel={async (_model, onProgress) => {
        await onInstall(onProgress)
        // What the page does next: refresh, and the model reads as installed.
        setInstalled(true)
      }}
    />
  )
}

describe('downloading a model from the Media page', () => {
  it('offers Download with the size, not Generate, for a model not downloaded yet', () => {
    render(<Harness onInstall={async () => {}} />)

    expect(
      screen.getByRole('button', { name: 'Download model (1.6 GB)' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Model')).toHaveTextContent('Not downloaded')
    expect(screen.getByTestId('media-form-status')).toHaveTextContent(
      'Download Stable Diffusion 1.5 to start making images with it'
    )
  })

  it('shows progress while downloading, then lets the user generate', async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    let report: (p: MediaInstallProgress) => void = () => {}
    const onInstall = vi.fn(
      (onProgress: (p: MediaInstallProgress) => void) =>
        new Promise<void>((resolve) => {
          report = onProgress
          finish = resolve
        })
    )
    render(<Harness onInstall={onInstall} />)

    await user.click(screen.getByRole('button', { name: 'Download model (1.6 GB)' }))
    report({ received: 42, total: 100 })

    await waitFor(() =>
      expect(screen.getByTestId('media-form-status')).toHaveTextContent(
        'Downloading the model… 42%'
      )
    )
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled()

    finish()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument()
    )
    expect(screen.queryByRole('button', { name: /Download model/ })).not.toBeInTheDocument()
  })

  it('also offers the download right under the model picker', async () => {
    const user = userEvent.setup()
    const onInstall = vi.fn(async () => {})
    render(<Harness onInstall={onInstall} />)

    expect(screen.getByTestId('media-model-download')).toHaveTextContent(
      'Stable Diffusion 1.5 is not downloaded yet'
    )
    await user.click(screen.getByRole('button', { name: 'Download (1.6 GB)' }))

    expect(onInstall).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByTestId('media-model-download')).not.toBeInTheDocument()
    )
  })

  it('says why a download failed and offers it again', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        onInstall={async () => {
          throw new Error('Not enough free space on the disk')
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Download model (1.6 GB)' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The download did not finish: Not enough free space on the disk'
    )
    expect(
      screen.getByRole('button', { name: 'Download model (1.6 GB)' })
    ).toBeEnabled()
  })
})

describe('formatDownloadSize', () => {
  it('reads like a download size', () => {
    expect(formatDownloadSize(1_763_578_176)).toBe('1.6 GB')
    expect(formatDownloadSize(39_092_706)).toBe('37 MB')
    expect(formatDownloadSize(undefined)).toBeUndefined()
  })
})
