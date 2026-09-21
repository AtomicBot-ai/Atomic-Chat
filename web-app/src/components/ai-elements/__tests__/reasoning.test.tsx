import { act, fireEvent, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => vi.useRealTimers())

describe('ReasoningContent', () => {
  it('uses the shared action-icon scale and a vertically centred trigger', () => {
    const { container, getByRole } = render(
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent isStreaming>Reasoning</ReasoningContent>
      </Reasoning>
    )

    const trigger = getByRole('button')
    const chevron = container.querySelector('.lucide-chevron-down')!
    expect(trigger).toHaveClass('min-h-6', 'items-center')
    expect(container.querySelector('.tabler-icon-bulb')).toHaveClass(
      'size-[18px]',
      'shrink-0'
    )
    expect(trigger.querySelector('.text-transparent')).toBeNull()
    expect(trigger).toHaveTextContent('Thinking for 1s…')
    expect(chevron.parentElement).toHaveClass(
      'inline-flex',
      'min-w-0',
      'items-center'
    )
    expect(chevron.previousElementSibling).toHaveClass('truncate')
    expect(chevron.previousElementSibling).not.toHaveClass('flex-1')
  })

  it('keeps one monotonic timer until the enclosing turn becomes terminal', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const { rerender, getByRole, queryByText } = render(
      <Reasoning isStreaming defaultOpen={false}>
        <ReasoningTrigger />
      </Reasoning>
    )

    expect(getByRole('button')).toHaveTextContent('Thinking for 1s…')
    act(() => vi.advanceTimersByTime(2_000))
    expect(getByRole('button')).toHaveTextContent('Thinking for 2s…')

    rerender(
      <Reasoning isStreaming defaultOpen={false}>
        <ReasoningTrigger />
      </Reasoning>
    )
    expect(getByRole('button')).toHaveTextContent('Thinking for 2s…')

    rerender(
      <Reasoning defaultOpen={false}>
        <ReasoningTrigger />
      </Reasoning>
    )
    expect(getByRole('button')).toHaveTextContent('Thought for 2s')
    expect(queryByText(/Thinking for/)).not.toBeInTheDocument()
    expect(queryByText('Thought for 2s')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(10_000))
    expect(getByRole('button')).toHaveTextContent('Thought for 2s')
  })

  it('continues elapsed time when the wall clock moves backwards or forwards', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { getByRole } = render(
      <Reasoning isStreaming defaultOpen={false}>
        <ReasoningTrigger />
      </Reasoning>
    )
    act(() => vi.advanceTimersByTime(3_000))
    expect(getByRole('button')).toHaveTextContent('Thinking for 3s')
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    act(() => vi.advanceTimersByTime(2_000))
    expect(getByRole('button')).toHaveTextContent('Thinking for 5s')
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'))
    act(() => vi.advanceTimersByTime(2_000))
    expect(getByRole('button')).toHaveTextContent('Thinking for 7s')
  })

  it('renders streaming reasoning as plain text, then Markdown once complete', async () => {
    const reasoning = '**Material finding**\n\n- first\n- second'
    const { container, rerender } = render(
      <Reasoning defaultOpen>
        <ReasoningContent isStreaming>{reasoning}</ReasoningContent>
      </Reasoning>
    )

    expect(container.querySelector('[data-streaming-reasoning]')).not.toBeNull()
    expect(container.querySelector('[data-streamdown="strong"]')).toBeNull()
    expect(container.querySelector('strong')).toHaveTextContent(
      'Material finding'
    )
    expect(container.textContent).not.toContain('**')

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

  it('keeps the full long trace visible without invoking Markdown', () => {
    const longReasoning = '**token** '.repeat(12_000) + 'visible tail'
    const { container } = render(
      <Reasoning defaultOpen>
        <ReasoningContent isStreaming>{longReasoning}</ReasoningContent>
      </Reasoning>
    )

    expect(container.querySelector('[data-streaming-reasoning]')).not.toBeNull()
    expect(container.querySelector('[data-streamdown]')).toBeNull()
    expect(container.textContent).not.toContain(
      'earlier reasoning will appear when generation completes'
    )
    expect(container.textContent?.length).toBeGreaterThan(100_000)
    expect(container.textContent).toMatch(/visible tail$/)
  })

  it('keeps a just-finished live trace open and lightweight', () => {
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
    expect(container.querySelector('[data-streaming-reasoning]')).not.toBeNull()
    expect(getComputedStyle(container.firstElementChild!).display).not.toBe(
      'none'
    )
  })

  it('parses a stored trace when the reader opens its finished panel', async () => {
    const reasoning = '**Material finding**\n\n- first\n- second'
    const { container, getByRole } = render(
      <Reasoning defaultOpen={false}>
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
