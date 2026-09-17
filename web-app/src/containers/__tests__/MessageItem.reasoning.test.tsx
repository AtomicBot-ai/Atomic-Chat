import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count ? `${key} ${values.count}` : key,
  }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

afterEach(() => vi.restoreAllMocks())

const REASONED = 'activity.reasoned'

const withReasoning: UIMessage = {
  id: 'a-reasoned',
  role: 'assistant',
  parts: [
    { type: 'reasoning', text: 'Weigh both options first.', state: 'done' },
    { type: 'text', text: 'Pick the second one.' },
  ],
}

const plainAnswer: UIMessage = {
  id: 'a-plain',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Just the answer.' }],
}

const renderItem = (message: UIMessage) =>
  render(
    <MessageItem
      message={message}
      isFirstMessage={false}
      isLastMessage={false}
      status="ready"
    />
  )

/** What the reader sees: every visible text run plus every button label. */
const snapshot = (container: HTMLElement) => ({
  text: container.textContent,
  buttons: screen.queryAllByRole('button').map((b) => b.textContent),
})

beforeEach(() => {
  seedServiceHub()
})

// The effort slider in the composer writes the general-setting store. A
// message already on screen must render the parts it has, whatever the store
// says now: the setting is for the next request only.
describe('MessageItem reasoning is a property of the message, not the setting', () => {
  it('shows no Reasoned trigger for an answer without a reasoning part, even at high effort', () => {
    act(() => {
      useGeneralSetting.setState({
        disableReasoning: false,
        reasoningBudget: 'high',
      })
    })

    renderItem(plainAnswer)

    expect(screen.getByText('Just the answer.')).toBeInTheDocument()
    expect(screen.queryByText(REASONED)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reasoned/i })).toBeNull()
  })

  it('shows the Reasoned trigger for a stored reasoning part while the setting says Off', () => {
    act(() => {
      useGeneralSetting.setState({
        disableReasoning: true,
        reasoningBudget: 'off',
      })
    })

    renderItem(withReasoning)

    expect(screen.getByText(REASONED)).toBeInTheDocument()
    expect(screen.getByText('Pick the second one.')).toBeInTheDocument()
  })

  it('does not change the rendered message when the effort setting flips after render', () => {
    act(() => {
      useGeneralSetting.setState({
        disableReasoning: true,
        reasoningBudget: 'off',
      })
    })

    const reasoned = renderItem(withReasoning)
    const reasonedBefore = snapshot(reasoned.container)
    expect(reasonedBefore.text).toContain(REASONED)

    act(() => {
      useGeneralSetting.getState().setDisableReasoning(false)
      useGeneralSetting.getState().setReasoningBudget('max')
    })
    expect(snapshot(reasoned.container)).toEqual(reasonedBefore)

    act(() => {
      useGeneralSetting.getState().setDisableReasoning(true)
      useGeneralSetting.getState().setReasoningBudget('off')
    })
    expect(snapshot(reasoned.container)).toEqual(reasonedBefore)
    reasoned.unmount()

    const plain = renderItem(plainAnswer)
    const plainBefore = snapshot(plain.container)
    expect(plainBefore.text).not.toContain(REASONED)

    act(() => {
      useGeneralSetting.getState().setDisableReasoning(false)
      useGeneralSetting.getState().setReasoningBudget('max')
    })
    expect(snapshot(plain.container)).toEqual(plainBefore)
  })
})

describe('MessageItem live reasoning viewport', () => {
  it('formats adjacent bold local-reasoning steps while they stream', () => {
    const { container } = render(
      <MessageItem
        message={{
          id: 'local-steps',
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: '**Preparing files****Creating folder**',
              state: 'streaming',
            },
          ],
        }}
        isFirstMessage={false}
        isLastMessage
        status="streaming"
      />
    )

    expect(screen.getByText('Preparing files')).toHaveClass('font-semibold')
    expect(screen.getByText('Creating folder')).toHaveClass('font-semibold')
    expect(container.querySelector('[data-streaming-reasoning]')).toHaveTextContent(
      'Preparing files Creating folder'
    )
  })

  it('renders consecutive reasoning summaries as one continuous block', () => {
    const { container } = renderItem({
      id: 'summary-parts',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Planning the search.', state: 'done' },
        { type: 'reasoning', text: 'Checking the sources.', state: 'done' },
        { type: 'text', text: 'Final answer' },
      ],
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: /activity.reasoned|activity.thoughtFor/,
      })
    )

    expect(screen.getByText('Planning the search.')).toBeVisible()
    expect(screen.getByText('Checking the sources.')).toBeVisible()
    expect(container.querySelectorAll('.markdown')).toHaveLength(2)
    expect(container.querySelector('.border-dotted')).toBeNull()
  })

  it('streams at full height, closes on finish and expands on reader request', () => {
    const text =
      '**Full reasoning starts here**\n\n' +
      'A line of reasoning.\n'.repeat(500)
    const item = (streaming: boolean) => (
      <MessageItem
        message={{
          id: 'stream',
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text,
              state: streaming ? 'streaming' : 'done',
            },
            ...(!streaming
              ? [{ type: 'text' as const, text: 'Final answer' }]
              : []),
          ],
        }}
        isFirstMessage={false}
        isLastMessage
        status={streaming ? 'streaming' : 'ready'}
      />
    )
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { container, rerender } = render(item(true))
    const viewport = container.querySelector('[data-reasoning-viewport]')!
    expect(viewport).toHaveAttribute('data-state', 'open')
    expect(viewport).toHaveAttribute('data-bounded', 'false')
    expect(
      screen.getByRole('button', { name: /activity.thinking/ })
    ).toHaveAttribute('aria-expanded', 'true')

    now.mockReturnValue(6200)
    rerender(item(false))
    expect(viewport).toHaveAttribute('data-state', 'closed')
    expect(viewport).toHaveAttribute('data-bounded', 'true')
    expect(screen.getByText('Final answer')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'activity.thoughtFor 6' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(container.querySelector('[data-streamdown="strong"]')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: /activity.reasoned|activity.thoughtFor/,
      })
    )
    expect(viewport).toHaveAttribute('data-state', 'open')
    expect(viewport).toHaveAttribute('data-bounded', 'false')
    expect(screen.getByText('Full reasoning starts here')).toBeVisible()
  })
})
