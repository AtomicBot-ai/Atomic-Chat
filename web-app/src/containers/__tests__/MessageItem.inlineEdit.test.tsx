import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { seedServiceHub } from '@/test/service-hub'

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

vi.mock('react-textarea-autosize', async () => {
  const React = await import('react')
  type AutosizeProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    minRows?: number
    maxRows?: number
  }
  return {
    default: React.forwardRef<HTMLTextAreaElement, AutosizeProps>(
      ({ minRows, maxRows, ...props }, ref) => {
        void minRows
        void maxRows
        return <textarea {...props} ref={ref} />
      }
    ),
  }
})

const userMessage: UIMessage = {
  id: 'm1',
  role: 'user',
  parts: [{ type: 'text', text: 'original text' }],
}

const onEdit = vi.fn()

const editButton = () =>
  screen.getByRole('button', { name: 'common:editMessage' })

const renderMessage = (message: UIMessage = userMessage) =>
  render(
    <MessageItem
      message={message}
      isFirstMessage
      isLastMessage
      status="ready"
      onEdit={onEdit}
    />
  )

beforeEach(() => {
  onEdit.mockClear()
  seedServiceHub()
})

describe('MessageItem inline editing', () => {
  it('replaces the message text in place instead of opening a dialog', () => {
    renderMessage()
    expect(screen.getByText('original text')).toBeInTheDocument()

    fireEvent.click(editButton())

    // The static transcript text is gone, replaced by an editable field — and
    // no modal shell was mounted over the thread.
    expect(
      screen.queryByText('original text', { selector: 'div' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('inline-message-editor')).toHaveValue(
      'original text'
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('hides the message action row while editing', () => {
    renderMessage()
    fireEvent.click(editButton())
    expect(
      screen.queryByRole('button', { name: 'common:editMessage' })
    ).not.toBeInTheDocument()
  })

  it('reports the edited text through onEdit and closes the editor', () => {
    renderMessage()
    fireEvent.click(editButton())

    const textarea = screen.getByTestId('inline-message-editor')
    fireEvent.change(textarea, { target: { value: 'rewritten text' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onEdit).toHaveBeenCalledWith('m1', 'rewritten text')
    expect(screen.queryByTestId('inline-message-editor')).not.toBeInTheDocument()
  })

  it('restores the original text on cancel without calling onEdit', () => {
    renderMessage()
    fireEvent.click(editButton())

    const textarea = screen.getByTestId('inline-message-editor')
    fireEvent.change(textarea, { target: { value: 'discarded' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('original text')).toBeInTheDocument()
  })

  it('edits an assistant message in place too', () => {
    renderMessage({
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'assistant reply' }],
    })

    fireEvent.click(editButton())
    const textarea = screen.getByTestId('inline-message-editor')
    fireEvent.change(textarea, { target: { value: 'corrected reply' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onEdit).toHaveBeenCalledWith('a1', 'corrected reply')
  })
})
