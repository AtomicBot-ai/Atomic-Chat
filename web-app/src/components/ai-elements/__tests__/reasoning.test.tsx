import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Reasoning, ReasoningContent } from '../reasoning'

describe('ReasoningContent', () => {
  it('renders streaming reasoning as plain text, then Markdown once complete', async () => {
    const reasoning = '**Material finding**\n\n- first\n- second'
    const { container, rerender } = render(
      <Reasoning defaultOpen>
        <ReasoningContent isStreaming>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    expect(container.querySelector('[data-streaming-reasoning]')).not.toBeNull()
    expect(container.querySelector('[data-streamdown="strong"]')).toBeNull()
    expect(container.textContent).toContain('**Material finding**')

    rerender(
      <Reasoning defaultOpen>
        <ReasoningContent>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    await waitFor(() =>
      expect(
        container.querySelector('[data-streamdown="strong"]')
      ).not.toBeNull()
    )
    expect(container.querySelector('[data-streaming-reasoning]')).toBeNull()
  })

  it('keeps a long streaming trace out of the Markdown renderer', () => {
    const longReasoning = '**token** '.repeat(12_000) + 'visible tail'
    const { container } = render(
      <Reasoning defaultOpen>
        <ReasoningContent isStreaming>{longReasoning}</ReasoningContent>
      </Reasoning>
    )

    expect(container.querySelector('[data-streaming-reasoning]')).not.toBeNull()
    expect(container.querySelector('[data-streamdown]')).toBeNull()
    expect(container.textContent).toContain(
      'earlier reasoning will appear when generation completes'
    )
    expect(container.textContent).toHaveLength(16_061)
    expect(container.textContent).toMatch(/visible tail$/)
  })
})
