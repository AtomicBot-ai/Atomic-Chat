import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  MissingModelBadge,
  ModelSourceBadge,
  modelSourceLabel,
} from '@/components/ModelSourceBadge'

describe('ModelSourceBadge', () => {
  it('names the Hugging Face cache after Hugging Face, not Unsloth', () => {
    // Anything found in ~/.cache/huggingface/hub wore another app's name.
    render(<ModelSourceBadge source="huggingface-cache" />)
    expect(screen.getByText('Hugging Face')).toBeInTheDocument()
    expect(screen.queryByText('Unsloth')).toBeNull()
  })

  it('has a label for every source the scanner can report', () => {
    for (const [source, label] of [
      ['ollama', 'Ollama'],
      ['lmstudio', 'LM Studio'],
      ['unsloth', 'Unsloth'],
      ['huggingface-cache', 'Hugging Face'],
      ['gpt4all', 'GPT4All'],
      ['jan', 'Jan'],
      ['msty', 'Msty'],
      ['llamacpp-cache', 'llama.cpp'],
      ['local', 'Local'],
    ] as const) {
      expect(modelSourceLabel(source)).toBe(label)
    }
    expect(modelSourceLabel(undefined)).toBeUndefined()
  })

  it('blames the right app when the file went missing', () => {
    render(<MissingModelBadge source="huggingface-cache" />)
    expect(screen.getByTitle(/removed in Hugging Face/)).toBeInTheDocument()
  })
})
