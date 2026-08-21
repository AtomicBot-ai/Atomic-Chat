import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineMessageEditor } from '../InlineMessageEditor'
import { injectFilesIntoPrompt } from '@/lib/fileMetadata'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

// Built through the real injector so the fixture cannot drift from the format
// the app actually writes.
const WITH_ATTACHMENT = injectFilesIntoPrompt('hello world', [
  { id: 'f1', name: 'notes.pdf', type: 'pdf', size: 1024 },
])

const onSave = vi.fn()
const onCancel = vi.fn()

const setup = (initialText: string) => {
  render(
    <InlineMessageEditor
      initialText={initialText}
      onSave={onSave}
      onCancel={onCancel}
    />
  )
  return screen.getByTestId('inline-message-editor') as HTMLTextAreaElement
}

beforeEach(() => {
  onSave.mockClear()
  onCancel.mockClear()
})

describe('InlineMessageEditor', () => {
  it('seeds the textarea with the message text and focuses it', () => {
    const textarea = setup('hello world')
    expect(textarea.value).toBe('hello world')
    expect(document.activeElement).toBe(textarea)
  })

  it('hides the attached-files block from the editable text', () => {
    const textarea = setup(WITH_ATTACHMENT)
    expect(textarea.value).toBe('hello world')
    expect(textarea.value).not.toContain('ATTACHED_FILES')
  })

  it('re-injects the attached-files block on save', () => {
    const textarea = setup(WITH_ATTACHMENT)
    fireEvent.change(textarea, { target: { value: 'goodbye world' } })
    fireEvent.click(screen.getByText('common:save'))

    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0] as string
    expect(saved).toContain('goodbye world')
    expect(saved).toContain('[ATTACHED_FILES]')
    expect(saved).toContain('notes.pdf')
  })

  it('saves on Enter and adds a newline on Shift+Enter', () => {
    const textarea = setup('hello')
    fireEvent.change(textarea, { target: { value: 'edited' } })

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith('edited')
  })

  it('does not save on Enter while an IME composition is active', () => {
    const textarea = setup('hello')
    fireEvent.change(textarea, { target: { value: 'こんにちは' } })

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(onSave).not.toHaveBeenCalled()

    // Safari reports composition as keyCode 229 rather than isComposing.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('cancels on Escape without saving', () => {
    const textarea = setup('hello')
    fireEvent.change(textarea, { target: { value: 'edited' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('treats an unchanged save as a cancel', () => {
    // Saving a user message truncates the thread and re-runs the model, so a
    // no-op edit must not reach the save path.
    const textarea = setup('hello')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('refuses to save a whitespace-only draft', () => {
    const textarea = setup('hello')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText('common:save').closest('button')).toBeDisabled()
  })

  it('disables Save until the text actually changes', () => {
    const textarea = setup('hello')
    expect(screen.getByText('common:save').closest('button')).toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'hello!' } })
    expect(screen.getByText('common:save').closest('button')).toBeEnabled()
  })

  it('cancels when the Cancel button is pressed', () => {
    const textarea = setup('hello')
    fireEvent.change(textarea, { target: { value: 'edited' } })
    fireEvent.click(screen.getByText('common:cancel'))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('stops keydown from reaching the app-wide shortcut listener', () => {
    // Global shortcuts are bound on `window` with no focused-input guard, so
    // Cmd+N / Cmd+K would otherwise fire while typing an edit.
    const windowListener = vi.fn()
    window.addEventListener('keydown', windowListener)

    const textarea = setup('hello')
    fireEvent.keyDown(textarea, { key: 'n', metaKey: true })

    expect(windowListener).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowListener)
  })
})
