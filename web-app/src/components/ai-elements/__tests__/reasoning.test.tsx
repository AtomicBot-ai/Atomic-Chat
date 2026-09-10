import { fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Reasoning, ReasoningContent, ReasoningTrigger } from '../reasoning'

const { markdownRenders } = vi.hoisted(() => ({ markdownRenders: vi.fn() }))

// Counting renders, not DOM: the finished trace used to be parsed for exactly
// one commit and unmounted by the auto-close effect on the next, which no
// assertion against the DOM can see.
vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamdown')>()
  const Streamdown = (props: ComponentProps<typeof actual.Streamdown>) => {
    markdownRenders(props.children)
    return <actual.Streamdown {...props} />
  }
  return { ...actual, Streamdown }
})

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
    // The window, plus the truncation notice — not the 120k-character trace.
    expect(container.textContent?.length).toBeGreaterThan(4_000)
    expect(container.textContent?.length).toBeLessThan(4_200)
    expect(container.textContent).toMatch(/visible tail$/)
  })

  it('does not parse the trace when a finished panel auto-closes', () => {
    const reasoning = '**Material finding**\n\n- first\n- second'
    const { container, rerender } = render(
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent isStreaming>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    expect(container.querySelector('[data-streaming-reasoning]')).not.toBeNull()
    markdownRenders.mockClear()

    rerender(
      <Reasoning defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    expect(markdownRenders).not.toHaveBeenCalled()
  })

  it('parses the trace when the reader opens a finished panel', async () => {
    const reasoning = '**Material finding**\n\n- first\n- second'
    const { container, getByRole, rerender } = render(
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent isStreaming>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    rerender(
      <Reasoning defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    fireEvent.click(getByRole('button'))

    await waitFor(() =>
      expect(
        container.querySelector('[data-streamdown="strong"]')
      ).not.toBeNull()
    )
  })
})
