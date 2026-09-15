/**
 * "Add file" on the Media page (the user, 2026-09-15: "text prompt with add
 * file option"). A model with an image parameter gets a file picker beside the
 * prompt; the picture goes with the job as a data URL.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type {
  MediaModelDescriptor,
  MediaProviderDescriptor,
  NormalizedMediaRequest,
} from '@/services/media/contract'

import { MediaGenerationForm } from '../MediaGenerationForm'
import { MAX_IMAGE_BYTES, readImageFileAsDataUrl } from '../params/imageFile'

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

const videoModel: MediaModelDescriptor = {
  id: 'builtin-engine:wan',
  provider_id: 'builtin-engine',
  local_id: 'wan',
  label: 'Wan 2.2',
  tasks: ['text_to_video'],
  params: {
    text_to_video: [
      { id: 'prompt', type: 'text', required: true, label: 'Prompt' },
      { id: 'init_image', type: 'image_ref', group: 'core', label: 'First frame', accept: ['image/png'] },
      { id: 'end_image', type: 'image_ref', group: 'core', label: 'Last frame', accept: ['image/png'] },
    ],
  },
  install: { installed: true, installable: true },
}

const plainModel: MediaModelDescriptor = {
  ...videoModel,
  id: 'builtin-engine:plain',
  local_id: 'plain',
  params: {
    text_to_video: [{ id: 'prompt', type: 'text', required: true, label: 'Prompt' }],
  },
}

const PNG = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'cat.png', {
  type: 'image/png',
})

function renderForm(model: MediaModelDescriptor, onSubmit = vi.fn()) {
  render(
    <MediaGenerationForm
      tasks={[{ id: 'text_to_video', label: 'Video', output_media_type: 'video' }]}
      task="text_to_video"
      onTaskChange={() => {}}
      models={[model]}
      providers={[engine]}
      devices={[]}
      selectedModelId={model.id}
      onSelectModel={() => {}}
      onSubmit={onSubmit}
    />
  )
  return onSubmit
}

describe('Add file beside the prompt', () => {
  it('offers Add file for the model’s first image, and a picker for the others', () => {
    renderForm(videoModel)

    expect(screen.getByRole('button', { name: 'Add file' })).toBeInTheDocument()
    expect(screen.getByLabelText('Add First frame')).toHaveAttribute('type', 'file')
    // The second image parameter is drawn in the settings, as a picker too.
    expect(screen.getByLabelText('Add Last frame')).toHaveAttribute('type', 'file')
    expect(screen.getByRole('button', { name: /Choose last frame/ })).toBeInTheDocument()
  })

  it('has no Add file for a model that takes no image', () => {
    renderForm(plainModel)

    expect(screen.queryByRole('button', { name: 'Add file' })).not.toBeInTheDocument()
  })

  it('shows the picture and sends it with the job', async () => {
    const user = userEvent.setup()
    const onSubmit = renderForm(videoModel)

    await user.upload(screen.getByLabelText('Add First frame'), PNG)

    expect(await screen.findByRole('img', { name: 'First frame' })).toBeInTheDocument()
    expect(screen.getByText('cat.png')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Prompt'), 'the cat walks away')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    const request = onSubmit.mock.calls[0][0] as NormalizedMediaRequest
    expect(String(request.params.init_image)).toMatch(/^data:image\/png;base64,/)
    expect(request.params.end_image).toBeUndefined()
  })

  it('removes a picture again', async () => {
    const user = userEvent.setup()
    const onSubmit = renderForm(videoModel)

    await user.upload(screen.getByLabelText('Add First frame'), PNG)
    await user.click(await screen.findByRole('button', { name: 'Remove First frame' }))

    await waitFor(() =>
      expect(screen.queryByRole('img', { name: 'First frame' })).not.toBeInTheDocument()
    )
    await user.type(screen.getByLabelText('Prompt'), 'waves')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect((onSubmit.mock.calls[0][0] as NormalizedMediaRequest).params.init_image).toBeFalsy()
  })
})

describe('an image parameter that is a path', () => {
  it('keeps its text box when it lists no file types (a v1 worker)', () => {
    renderForm({
      ...videoModel,
      params: {
        text_to_video: [
          { id: 'prompt', type: 'text', required: true, label: 'Prompt' },
          { id: 'input_image', type: 'image_ref', group: 'core', label: 'Reference image path' },
        ],
      },
    })

    expect(screen.queryByRole('button', { name: 'Add file' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Input image')).toHaveAttribute('type', 'text')
  })
})

describe('reading a picked image', () => {
  it('refuses something that is not a picture, saying so', async () => {
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await expect(readImageFileAsDataUrl(text)).rejects.toThrow('notes.txt is not an image')
  })

  it('refuses a picture that is too large', async () => {
    const huge = new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' })
    Object.defineProperty(huge, 'size', { value: MAX_IMAGE_BYTES + 1 })
    await expect(readImageFileAsDataUrl(huge)).rejects.toThrow('larger than 25 MB')
  })
})
