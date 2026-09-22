/**
 * The Media page's model picker (the user, 2026-09-15: "same as the chat model
 * picker", saying what is downloaded and in which sizes).
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { MediaModelDescriptor } from '@/services/media/contract'

import { MediaModelPicker } from '../MediaModelPicker'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue ?? key)
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
    },
  }),
}))

function sd(quant: string, size: number, installed: boolean, isDefault: boolean): MediaModelDescriptor {
  const localId = isDefault ? 'sd-1.5' : `sd-1.5@${quant.toLowerCase()}`
  return {
    id: `builtin-engine:${localId}`,
    provider_id: 'builtin-engine',
    local_id: localId,
    label: `Stable Diffusion 1.5 · ${quant}`,
    family: 'sd1',
    tasks: ['text_to_image'],
    params: { text_to_image: [] },
    install: { installed, installable: true, size_bytes: size },
    license: { id: 'creativeml-openrail-m' },
    quant: {
      group_id: 'sd-1.5',
      group_label: 'Stable Diffusion 1.5',
      label: quant,
      note: `${quant} note`,
      is_default: isDefault,
    },
    download_files: [
      {
        name: `stable-diffusion-v1-5-pruned-emaonly-${quant}.gguf`,
        role: 'model',
        size_bytes: size,
        source: 'huggingface.co/second-state/stable-diffusion-v1-5-GGUF',
        installed,
      },
    ],
    min_memory_mb: 3072,
  }
}

const WAN: MediaModelDescriptor = {
  id: 'builtin-engine:wan2.2-ti2v-5b',
  provider_id: 'builtin-engine',
  local_id: 'wan2.2-ti2v-5b',
  label: 'Wan 2.2 TI2V 5B (video) · Q4_0',
  tasks: ['text_to_image'],
  params: { text_to_image: [] },
  install: { installed: false, installable: true, size_bytes: 8_093_632_832 },
  quant: { group_id: 'wan2.2-ti2v-5b', group_label: 'Wan 2.2 TI2V 5B (video)', label: 'Q4_0', is_default: true },
  download_files: [
    { name: 'Wan2.2-TI2V-5B-Q4_0.gguf', role: 'diffusion_model', size_bytes: 3_029_086_560 },
    { name: 'wan2.2_vae.safetensors', role: 'vae', size_bytes: 1_409_400_960 },
    { name: 'umt5-xxl-encoder-Q4_K_M.gguf', role: 't5xxl', size_bytes: 3_655_145_312 },
  ],
  min_memory_mb: 12_288,
}

const MODELS = [sd('Q8_0', 1_763_578_176, true, true), sd('Q4_0', 1_566_768_416, false, false), WAN]

function renderPicker(onSelect = vi.fn()) {
  render(
    <MediaModelPicker
      id="media-model"
      ariaLabel="Model"
      models={MODELS}
      selectedId="builtin-engine:sd-1.5"
      onSelect={onSelect}
    />
  )
  return onSelect
}

const optionNames = (root: HTMLElement) =>
  within(root).getAllByRole('option').map((node) => node.getAttribute('aria-label'))

describe('the Media model picker', () => {
  it('shows the chosen model, its size and whether it is downloaded', () => {
    renderPicker()

    const trigger = screen.getByLabelText('Model')
    expect(trigger).toHaveTextContent('Stable Diffusion 1.5')
    expect(trigger).toHaveTextContent('Q8_0')
    expect(trigger).toHaveTextContent('Downloaded')
  })

  it('lists each model once, with its sizes smallest first', async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(screen.getByLabelText('Model'))

    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Stable Diffusion 1.5',
      'Wan 2.2 TI2V 5B (video)',
    ])
    expect(groups[0]).toHaveTextContent('2 sizes')
    expect(optionNames(groups[0])).toEqual([
      'Stable Diffusion 1.5 · Q4_0',
      'Stable Diffusion 1.5 · Q8_0',
    ])
    const [small, standard] = within(groups[0]).getAllByRole('option')
    expect(small).toHaveTextContent('1.5 GB')
    expect(small).toHaveTextContent('Not downloaded')
    expect(standard).toHaveTextContent('1.6 GB')
    expect(standard).toHaveTextContent('Downloaded')
    expect(standard).toHaveTextContent('Recommended')
    expect(standard).toHaveAttribute('aria-selected', 'true')
  })

  it('says what a size downloads, file by file, before it is chosen', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByLabelText('Model'))

    await user.hover(screen.getByRole('option', { name: 'Stable Diffusion 1.5 · Q4_0' }))
    const details = screen.getByTestId('media-model-details')
    expect(details).toHaveTextContent('Q4_0 — Q4_0 note')
    expect(details).toHaveTextContent('stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf')
    expect(details).toHaveTextContent('huggingface.co/second-state/stable-diffusion-v1-5-GGUF')
    expect(details).toHaveTextContent('About 3.0 GB of graphics memory')
    expect(details).toHaveTextContent('Not downloaded yet')

    await user.hover(screen.getByRole('option', { name: 'Wan 2.2 TI2V 5B (video) · Q4_0' }))
    expect(details).toHaveTextContent('wan2.2_vae.safetensors')
    expect(details).toHaveTextContent('VAE (turns the result into pixels)')
    expect(details).toHaveTextContent('umt5-xxl-encoder-Q4_K_M.gguf')
    expect(details).toHaveTextContent('Parts every size of this model shares are downloaded once.')
  })

  it('searches by model name or size', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByLabelText('Model'))

    await user.type(screen.getByLabelText('Search models'), 'q4')
    expect(optionNames(screen.getByRole('listbox'))).toEqual([
      'Stable Diffusion 1.5 · Q4_0',
      'Wan 2.2 TI2V 5B (video) · Q4_0',
    ])

    await user.clear(screen.getByLabelText('Search models'))
    await user.type(screen.getByLabelText('Search models'), 'stable q8')
    expect(optionNames(screen.getByRole('listbox'))).toEqual(['Stable Diffusion 1.5 · Q8_0'])

    await user.type(screen.getByLabelText('Search models'), 'zzz')
    expect(screen.getByRole('listbox')).toHaveTextContent('No models match')
  })

  it('choosing a size selects it and closes the list', async () => {
    const user = userEvent.setup()
    const onSelect = renderPicker()
    await user.click(screen.getByLabelText('Model'))

    await user.click(screen.getByRole('option', { name: 'Stable Diffusion 1.5 · Q4_0' }))

    expect(onSelect).toHaveBeenCalledWith('builtin-engine:sd-1.5@q4_0')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })
})
