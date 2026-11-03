import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(async () => true),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: (s: unknown) => unknown) =>
    selector({ disableReasoning: false }),
}))

const userMessage: UIMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: 'question' }],
}

const assistantMessage: UIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'answer' }],
}

beforeEach(() => {
  mocks.copyToClipboard.mockClear()
  seedServiceHub()
})

/**
 * QA 2.2.23 (AC-14): the icon-only message actions were announced as a bare
 * "button" (copy, regenerate) or "pop up button" (delete). Each now carries the
 * name its tooltip or confirmation already used.
 */
describe('MessageItem action names', () => {
  it('names copy, edit and delete on a user message', () => {
    render(
      <MessageItem
        message={userMessage}
        isFirstMessage
        isLastMessage={false}
        status="ready"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'common:copy' }))
    expect(mocks.copyToClipboard).toHaveBeenCalledWith('question')
    expect(
      screen.getByRole('button', { name: 'common:editMessage' })
    ).toBeEnabled()
    const remove = screen.getByRole('button', { name: 'common:deleteMessage' })
    expect(remove).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('names copy, delete and regenerate on the last assistant message', () => {
    const onRegenerate = vi.fn()
    render(
      <MessageItem
        message={assistantMessage}
        isFirstMessage={false}
        isLastMessage
        status="ready"
        onDelete={vi.fn()}
        onRegenerate={onRegenerate}
      />
    )

    const actions = screen.getByTestId('assistant-message-actions')
    expect(
      within(actions).getByRole('button', { name: 'common:copy' })
    ).toBeInTheDocument()
    expect(
      within(actions).getByRole('button', { name: 'common:deleteMessage' })
    ).toBeInTheDocument()
    fireEvent.click(
      within(actions).getByRole('button', { name: 'common:regenerate' })
    )
    expect(onRegenerate).toHaveBeenCalledWith('a1')
  })
})
