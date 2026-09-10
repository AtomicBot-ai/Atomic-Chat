import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { ModelListRow } from '../ModelListRow'

const model = (overrides: Partial<CatalogModel> = {}): CatalogModel =>
  ({
    model_name: 'Qwen/Qwen3.5-4B-GGUF',
    developer: 'Qwen',
    downloads: 12_345,
    num_quants: 1,
    quants: [
      {
        model_id: 'Qwen3.5-4B-Q4_K_M.gguf',
        path: 'Qwen3.5-4B-Q4_K_M.gguf',
        file_size: '2.50 GB',
      },
    ],
    ...overrides,
  }) as CatalogModel

describe('ModelListRow', () => {
  it('renders the repo name and format without size or download count', () => {
    render(<ModelListRow model={model()} onSelect={vi.fn()} />)

    expect(screen.getByText('Qwen3.5-4B-GGUF')).toBeInTheDocument()
    // Uppercased by CSS, so the node still carries the raw format token.
    expect(screen.getByText('gguf')).toBeInTheDocument()
    expect(screen.queryByText(/^12.345$/)).not.toBeInTheDocument()
    expect(screen.queryByText('2.5 GB')).not.toBeInTheDocument()
  })

  it('prefers the curated title and summary over catalog values', () => {
    render(
      <ModelListRow
        model={model()}
        pick={{
          model_name: 'Qwen/Qwen3.5-4B-GGUF',
          title: 'Qwen3.5 4B',
          summary: 'Compact all-rounder.',
        }}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    expect(screen.getByText('Compact all-rounder.')).toBeInTheDocument()
    expect(screen.queryByText('Qwen3.5-4B-GGUF')).not.toBeInTheDocument()
  })

  it('uses the model summary instead of its category label', () => {
    render(
      <ModelListRow
        model={model()}
        pick={{
          model_name: 'Qwen/Qwen3.5-4B-GGUF',
          description_key: 'hub:recEverydayUse',
          summary: 'Compact all-rounder.',
        }}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('Compact all-rounder.')).toBeInTheDocument()
    expect(screen.queryByText('hub:recEverydayUse')).not.toBeInTheDocument()
  })

  it('falls back to the organization when no curated summary exists', () => {
    render(
      <ModelListRow
        model={model({
          developer: 'Qwen',
          description: '**Tags**: transformers, gguf, image-to-text',
        })}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('Qwen')).toBeInTheDocument()
    expect(screen.queryByText(/\*\*Tags\*\*/)).not.toBeInTheDocument()
  })

  it('marks the selected row for assistive tech', () => {
    const { rerender } = render(
      <ModelListRow model={model()} onSelect={vi.fn()} />
    )
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-current')

    rerender(<ModelListRow model={model()} selected onSelect={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true')
  })

  it('reports the row the user clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ModelListRow model={model()} onSelect={onSelect} />)

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('Qwen3.5-4B-GGUF')
    await user.click(row)

    expect(onSelect).toHaveBeenCalledOnce()
  })

  // Capabilities are read in the detail panel, where the whole set is shown.
  // A row that drew the first two of four was a second, differently truncated
  // copy of the same answer.
  it('draws no capability pills', () => {
    render(
      <ModelListRow
        model={model({
          model_name: 'org/model-vision-tools-reasoning',
          tools: true,
          vision: true,
          reasoning: true,
        })}
        pick={{
          model_name: 'org/model-vision-tools-reasoning',
          categories: ['vision', 'tools', 'reasoning', 'audio'],
        }}
        onSelect={vi.fn()}
      />
    )

    for (const label of ['Vision', 'Tool Use', 'Reasoning', 'Audio']) {
      expect(screen.queryByText(label), label).not.toBeInTheDocument()
    }
  })

  it('draws the Hugging Face mark instead of a letter for long-tail hits', () => {
    const unknownFamily = model({
      model_name: 'some-lab/experimental-7b',
      developer: 'some-lab',
    })
    const { rerender } = render(
      <ModelListRow model={unknownFamily} onSelect={vi.fn()} />
    )
    expect(screen.getByText('S')).toBeInTheDocument()

    rerender(
      <ModelListRow model={unknownFamily} fromHuggingFace onSelect={vi.fn()} />
    )
    expect(screen.queryByText('S')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'some-lab' })).toBeInTheDocument()
  })
})
