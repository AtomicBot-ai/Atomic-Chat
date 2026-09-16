import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

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
